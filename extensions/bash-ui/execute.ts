import * as path from "node:path";

import { createLocalBashOperations, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestDiffBatch } from "../_shared/diff-service.ts";
import type { DiffInput, DiffOutput } from "../_shared/diff-service.ts";

import { OutputAccumulator } from "./accumulator.ts";
import {
	failureMatchesPatch,
	parseInvocationResult,
	successMatchesPatch,
	type ParsedApplyPatchResult,
	type ParsedApplyPatchResultSequence,
} from "./invocation-result.ts";
import type { ApplyPatchInvocation, ApplyPatchPlan, BashCommandPipeline, InPlaceEditPlan } from "./recognize.ts";
import { snapshotPaths, type FileSnapshot, type SnapshotSet } from "./patch-snapshot.ts";
import { buildInPlaceEditViewModel, buildResultViewModel, type DiffBatchSubmitter } from "./view-model-build.ts";
import type { ApplyPatchResultViewModel, InPlaceEditResultViewModel } from "./view-model-codec.ts";

/**
 * execute.ts — 执行者架构（终局）：识别 canonical shape 后自己执行 patch invocations，
 * 语义从源头就是结构，不再从混流文本逆向重建。
 *
 *   recognize -> pipeline 段队列（executeBashPipeline：顺序调度 + && 短路 + content 拼接 +
 *             details 合并，段间执行互不共享）
 *             -> 段内：apply-patch = prefix（原生 shell 语义）-> per-invocation（withFileMutationQueue
 *             + before 快照 + exec + after 快照）-> && 短路 -> trailing（原生 shell 语义）
 *             -> worker batch -> VM；
 *             in-place-edit = 编辑区整条 verbatim + 快照 bracket -> 快照真实 diff VM
 *
 * 守恒：
 * - 非识别命令 delegate built-in（index.ts），语义零改动。
 * - content 是 CLI 真实输出的忠实拼接 + trailing 原文；模型看到的 world 不变。
 * - 错误后缀独立返回（errorSuffix），由组合方拼接：pipeline 里非末段失败不产生文本。
 * - 主线程零 diff（worker batch）；快照由执行者 bracket，无 sibling 竞态窗口。
 * - invocation 失败 → 短路后续与 trailing；trailing 的 exit code = 整条命令 exit code。
 * - abort → kill 当前 spawn，已应用部分照常出 VM（诚实呈现磁盘状态）。
 * - timeout 预算全部给 trailing（patch 应用是本地毫秒级操作）。
 */

/** 重建 heredoc 的自选 marker：envelope 内不存在该裸行（patch 文本行必有前缀）。 */
const INVOCATION_MARKER = "PI_BASH_UI_PATCH_EOF";

/** built-in 的 100ms 流式节流。 */
const UPDATE_THROTTLE_MS = 100;

export type ExecuteOutcome = {
	/** 忠实拼接的 CLI 输出（invocations 原文 + trailing 截断快照；不含错误后缀）。 */
	content: string;
	/** 错误后缀（built-in 形状）：组合方（index 单段 / pipeline 末段）决定拼接，执行段不拼。 */
	errorSuffix?: string;
	/** built-in metadata（truncation/fullOutputPath）+ bashUi view model。 */
	details: {
		truncation?: unknown;
		fullOutputPath?: string;
		bashUi?: { applyPatch?: ApplyPatchResultViewModel; inPlaceEdit?: InPlaceEditResultViewModel };
	};
	viewModel: ApplyPatchResultViewModel | InPlaceEditResultViewModel | undefined;
	isError: boolean;
};

export type ExecuteOptions = {
	signal?: AbortSignal;
	timeout?: number;
	ctx: ExtensionContext;
	onUpdate?: AgentToolUpdateCallback;
};

/**
 * 执行 env：复刻 built-in 的 resolveSpawnContext（getShellEnv 的 binDir PATH 前置 +
 * exposeSessionEnvironment 的 PI_* 注入）。pi 内部函数未导出，此处按源码语义复刻。
 */
function buildEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const binDir = path.join(getAgentDir(), "bin");
	const current = env[pathKey] ?? "";
	const entries = current.split(path.delimiter).filter(Boolean);
	env[pathKey] = entries.includes(binDir) ? current : [binDir, current].filter(Boolean).join(path.delimiter);
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	const model = ctx.model;
	if (model) {
		env.PI_PROVIDER = model.provider;
		env.PI_MODEL = model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

/** invocation 涉及的 absolute paths（source + destination，去重）。 */
function invocationPaths(invocation: ApplyPatchInvocation): string[] {
	const paths = new Set<string>();
	for (const planned of invocation.operations) {
		paths.add(planned.sourceAbsolutePath);
		if (planned.destinationAbsolutePath !== undefined) paths.add(planned.destinationAbsolutePath);
	}
	return [...paths];
}

/** 同一文件不嵌套（队列链死锁）；不同文件顺序嵌套（无环）。fn 只在最后一层执行一次。 */
async function withFileQueues<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
	if (paths.length === 0) return fn();
	const [head, ...rest] = paths;
	return withFileMutationQueue(head, () => withFileQueues(rest, fn));
}

/** shell 单引号引用（`'` → `'\''`），用于重建命令中的绝对路径。 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 重建执行命令：quoted heredoc（无变量展开，与 shell 语义一致）。
 * 同命令 cat 写入的 stdin redirect：先 replay 写文件副作用再 redirect 应用——
 * 文件系统世界状态与原命令一致（trailing 可能读该文件）。
 * 外部来源文件（前序命令落盘）：原命令无写文件副作用，原样 redirect，无 replay。
 */
function buildInvocationCommand(invocation: ApplyPatchInvocation): string {
	if (invocation.stdinFilePath === undefined) {
		return `apply_patch <<'${INVOCATION_MARKER}'\n${invocation.envelope}\n${INVOCATION_MARKER}`;
	}
	const target = shellQuote(invocation.stdinFilePath);
	if (invocation.stdinExternal === true) {
		return `apply_patch < ${target}`;
	}
	return `cat > ${target} <<'${INVOCATION_MARKER}'\n${invocation.envelope}\n${INVOCATION_MARKER}\napply_patch < ${target}`;
}

/** 合并快照：before 首见优先（最早时点），after 末见覆盖（最终态）——与观察者架构语义一致。 */
function mergeSnapshots(entries: readonly { before: SnapshotSet; after: SnapshotSet }[]): {
	before: Map<string, FileSnapshot>;
	after: Map<string, FileSnapshot>;
} {
	const before = new Map<string, FileSnapshot>();
	const after = new Map<string, FileSnapshot>();
	for (const entry of entries) {
		for (const [key, value] of entry.before) {
			if (!before.has(key)) before.set(key, value);
		}
		for (const [key, value] of entry.after) {
			after.set(key, value);
		}
	}
	return { before, after };
}

type ExecutedInvocation = {
	invocation: ApplyPatchInvocation;
	parsed: ParsedApplyPatchResult;
	before: SnapshotSet;
	after: SnapshotSet;
};

/** trailing 阶段失败分类（错误后缀与 built-in 形状一致）。 */
type TrailingFailure =
	| { kind: "exit"; exitCode: number }
	| { kind: "timeout"; seconds: string }
	| { kind: "other"; message: string };

type StreamedSnapshot = ReturnType<OutputAccumulator["snapshot"]>;

type StreamedCommand =
	| { kind: "ok"; snapshot: StreamedSnapshot; exitCode: number | null }
	| { kind: "error"; snapshot: StreamedSnapshot; error: Error };

/**
 * 流式执行 + 截断快照（built-in 形状）：100ms throttle onUpdate，错误也带出部分输出。
 * 不抛异常：abort/timeout/启动错误由调用方按自身语义分类（trailing vs 整条命令）。
 */
async function runStreamingCommand(
	ops: ReturnType<typeof createLocalBashOperations>,
	command: string,
	cwd: string,
	options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number; onUpdate?: AgentToolUpdateCallback },
): Promise<StreamedCommand> {
	const { signal, timeout, onUpdate } = options;
	const accumulator = new OutputAccumulator("pi-bash");
	let updateDirty = false;
	let lastUpdateAt = 0;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	const emitUpdate = () => {
		if (!onUpdate || !updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		const snapshot = accumulator.snapshot();
		onUpdate({
			content: [{ type: "text", text: snapshot.content || "" }],
			details: snapshot.truncation.truncated
				? { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath }
				: undefined,
		});
	};
	const scheduleUpdate = () => {
		if (!onUpdate) return;
		updateDirty = true;
		const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = undefined;
			}
			emitUpdate();
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			emitUpdate();
		}, delay);
	};
	const settle = async (): Promise<void> => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
		emitUpdate();
		accumulator.finish();
		await accumulator.closeTempFile();
	};
	try {
		const result = await ops.exec(command, cwd, {
			onData: (data) => {
				accumulator.append(data);
				scheduleUpdate();
			},
			signal,
			timeout,
			env: options.env,
		});
		await settle();
		return { kind: "ok", snapshot: accumulator.snapshot(), exitCode: result.exitCode };
	} catch (error) {
		await settle();
		return { kind: "error", snapshot: accumulator.snapshot(), error: error instanceof Error ? error : new Error(String(error)) };
	}
}

export async function executeApplyPatchPlan(
	plan: ApplyPatchPlan,
	options: ExecuteOptions,
): Promise<ExecuteOutcome> {
	const ops = createLocalBashOperations();
	const env = buildEnv(options.ctx);
	const { signal, timeout, onUpdate } = options;
	const executed: ExecutedInvocation[] = [];
	let outputText = "";
	/** 无法确认语义（输出与 plan 不匹配）：继续执行（&& 语义），最终无 VM。 */
	let matched = true;
	/** 短路原因：invocation 失败（exit code 非 0 或输出含 failure 块）。 */
	let invocationFailure: { exitCode: number } | undefined;
	let aborted = false;

	// built-in 契约：执行开始先发一次空 update。
	onUpdate?.({ content: [], details: undefined });

	// prefix：invocation 之前的普通语句 verbatim 原生执行（bash 语句原子拆分——前缀段与
	// patch 识别互不影响；执行顺序 prefix → invocations → trailing，&& 短路贯穿）。
	let prefixText = "";
	let prefixFailure: TrailingFailure | undefined;
	if (plan.prefixCommand) {
		const run = await runStreamingCommand(ops, plan.prefixCommand, plan.prefixCwd ?? plan.invocations[0]!.cwd, {
			env,
			signal,
			timeout,
			onUpdate,
		});
		prefixText = run.snapshot.content || "";
		if (run.kind === "ok") {
			if (run.exitCode !== 0 && run.exitCode !== null) {
				prefixFailure = { kind: "exit", exitCode: run.exitCode };
			}
		} else if (run.error.message === "aborted") {
			aborted = true;
		} else if (run.error.message.startsWith("timeout:")) {
			prefixFailure = { kind: "timeout", seconds: run.error.message.split(":")[1] ?? String(timeout) };
		} else {
			prefixFailure = { kind: "other", message: run.error.message };
		}
	}

	for (const invocation of plan.invocations) {
		// 短路语义：prefix 与 invocation 之间为 &&（bash 短路）；分号/换行不短路，prefix 失败照常执行。
		if (aborted) break;
		if (plan.prefixShortCircuit === true && prefixFailure) break;
		const paths = invocationPaths(invocation);
		const chunks: Buffer[] = [];
		let runResult: { exitCode: number | null; before: SnapshotSet; after: SnapshotSet };
		try {
			runResult = await withFileQueues(paths, async () => {
				const before = await snapshotPaths(paths);
				const result = await ops.exec(buildInvocationCommand(invocation), invocation.cwd, {
					onData: (data) => chunks.push(data),
					signal,
					env,
				});
				const after = await snapshotPaths(paths);
				return { exitCode: result.exitCode, before, after };
			});
		} catch (error) {
			if (error instanceof Error && error.message === "aborted") {
				aborted = true;
				break;
			}
			// 其他 exec 错误（cwd 不存在等）：整体失败，无 VM（异常路径，不做语义推断）。
			const message = error instanceof Error ? error.message : String(error);
			const content = `${outputText ? `${outputText}\n\n` : ""}${message}`;
			return { content, details: {}, viewModel: undefined, isError: true };
		}

		const text = Buffer.concat(chunks).toString("utf8");
		outputText += text;
		const parsed = parseInvocationResult(text);
		if (!parsed) {
			// 输出与 canonical 形状不符：无法确认语义，继续执行（&& 语义），最终无 VM。
			matched = false;
			onUpdate?.({ content: [{ type: "text", text: prefixText + outputText }], details: undefined });
			continue;
		}
		if (parsed.success) {
			if (!successMatchesPatch(invocation.patch, parsed.changes)) matched = false;
		} else if (!failureMatchesPatch(invocation.patch, parsed.failure)) {
			matched = false;
		}
		executed.push({ invocation, parsed, before: runResult.before, after: runResult.after });
		onUpdate?.({ content: [{ type: "text", text: prefixText + outputText }], details: undefined });
		if (!parsed.success) {
			invocationFailure = { exitCode: runResult.exitCode ?? 1 };
			break; // && 短路
		}
	}

	// trailing：invocation 全部成功且未 abort 且语义已确认时执行（&& 语义；prefix && 短路失败同规则）。
	let trailingSnapshot: StreamedSnapshot | undefined;
	let trailingFailure: TrailingFailure | undefined;
	if (!(plan.prefixShortCircuit === true && prefixFailure) && !invocationFailure && !aborted && matched && plan.trailingCommand) {
		const trailingCommand = plan.trailingCommand.replace(/^[ \t]*&&[ \t]*/, "");
		const run = await runStreamingCommand(ops, trailingCommand, plan.invocations.at(-1)!.cwd, {
			env,
			signal,
			timeout,
			onUpdate,
		});
		trailingSnapshot = run.snapshot;
		if (run.kind === "ok") {
			if (run.exitCode !== 0 && run.exitCode !== null) {
				trailingFailure = { kind: "exit", exitCode: run.exitCode };
			}
		} else if (run.error.message === "aborted") {
			aborted = true;
		} else if (run.error.message.startsWith("timeout:")) {
			trailingFailure = { kind: "timeout", seconds: run.error.message.split(":")[1] ?? String(timeout) };
		} else {
			trailingFailure = { kind: "other", message: run.error.message };
		}
	}

	// content：prefix 输出原文 + invocations 输出原文 + trailing 截断快照；错误后缀独立返回由组合方拼接。
	let content = prefixText;
	content += outputText;
	if (trailingSnapshot?.content) content += trailingSnapshot.content;
	const details: ExecuteOutcome["details"] = {};
	if (trailingSnapshot?.truncation.truncated) {
		details.truncation = trailingSnapshot.truncation;
		details.fullOutputPath = trailingSnapshot.fullOutputPath;
	}
	let isError = false;
	let errorSuffix: string | undefined;
	if (aborted) {
		isError = true;
		errorSuffix = "Command aborted";
	} else if (plan.prefixShortCircuit === true && prefixFailure) {
		// 仅 && 短路时 prefix 失败才是整条命令失败；分号/换行分隔的 prefix 失败不设错误（后续命令决定）。
		isError = true;
		if (prefixFailure.kind === "exit") errorSuffix = `Command exited with code ${prefixFailure.exitCode}`;
		else if (prefixFailure.kind === "timeout") errorSuffix = `Command timed out after ${prefixFailure.seconds} seconds`;
		else errorSuffix = prefixFailure.message;
	} else if (trailingFailure) {
		isError = true;
		if (trailingFailure.kind === "exit") errorSuffix = `Command exited with code ${trailingFailure.exitCode}`;
		else if (trailingFailure.kind === "timeout") errorSuffix = `Command timed out after ${trailingFailure.seconds} seconds`;
		else errorSuffix = trailingFailure.message;
	} else if (invocationFailure) {
		isError = true;
		errorSuffix = `Command exited with code ${invocationFailure.exitCode}`;
	}

	// VM：已执行 invocation（含失败块）→ worker batch → 组装（主线程零 diff）。
	let viewModel: ApplyPatchResultViewModel | undefined;
	if (matched && executed.length > 0) {
		const executedPlan: ApplyPatchPlan = {
			...plan,
			invocations: executed.map((entry) => entry.invocation),
		};
		const sequence: ParsedApplyPatchResultSequence = {
			results: executed.map((entry) => entry.parsed),
			// trailing 快照文本承载进 VM（渲染层显示 trailing 输出的契约，与观察者架构一致）。
			trailing: trailingSnapshot?.content ?? "",
		};
		const merged = mergeSnapshots(executed);
		try {
			viewModel = await buildResultViewModel(executedPlan, sequence, merged.before, merged.after, diffSubmitter);
		} catch (error) {
			console.error(
				`bash-ui view model build failed ` +
				`error=${error instanceof Error ? error.message : String(error)} ` +
				`action="rendering raw output"`,
			);
		}
	}
	if (viewModel) details.bashUi = { applyPatch: viewModel };

	return { content, errorSuffix, details, viewModel, isError };
}

/**
 * in-place edit 执行：整条命令 verbatim（无 rebuild/replay——语义零改动由构造保证），
 * 快照 bracket 由 withFileMutationQueue 保护（与 apply-patch 路径同一纪律）。
 * content 是原生命令输出 + 错误后缀（built-in 形状）；VM 是快照真实 diff，
 * 失败/abort 也照常出 VM（诚实呈现磁盘状态）。timeout 预算是整条命令的（built-in 语义）。
 */
export async function executeInPlaceEditPlan(
	plan: InPlaceEditPlan,
	options: ExecuteOptions,
): Promise<ExecuteOutcome> {
	const ops = createLocalBashOperations();
	const env = buildEnv(options.ctx);
	const { signal, timeout, onUpdate } = options;
	const files = [...plan.snapshotFiles];

	onUpdate?.({ content: [], details: undefined });

	let bracketed: { before: SnapshotSet; after: SnapshotSet; run: StreamedCommand };
	try {
		bracketed = await withFileQueues(files, async () => {
			const before = await snapshotPaths(files);
			const run = await runStreamingCommand(ops, plan.command, plan.cwd, { env, signal, timeout, onUpdate });
			const after = await snapshotPaths(files);
			return { before, after, run };
		});
	} catch (error) {
		// 快照/队列层错误：整体失败，无 VM（异常路径，不做语义推断）。
		const message = error instanceof Error ? error.message : String(error);
		return { content: message, details: {}, viewModel: undefined, isError: true };
	}
	const { before, after, run } = bracketed;

	let isError = false;
	let errorSuffix: string | undefined;
	if (run.kind === "error") {
		isError = true;
		if (run.error.message === "aborted") errorSuffix = "Command aborted";
		else if (run.error.message.startsWith("timeout:")) {
			errorSuffix = `Command timed out after ${run.error.message.split(":")[1] ?? String(timeout)} seconds`;
		} else {
			errorSuffix = run.error.message;
		}
	} else if (run.exitCode !== 0 && run.exitCode !== null) {
		isError = true;
		errorSuffix = `Command exited with code ${run.exitCode}`;
	}

	let content = run.snapshot.content || "";
	const details: ExecuteOutcome["details"] = {};
	if (run.snapshot.truncation.truncated) {
		details.truncation = run.snapshot.truncation;
		details.fullOutputPath = run.snapshot.fullOutputPath;
	}
	let viewModel: InPlaceEditResultViewModel | undefined;
	try {
		viewModel = await buildInPlaceEditViewModel(plan, before, after, run.snapshot.content || "", diffSubmitter);
	} catch (error) {
		console.error(
			`bash-ui in-place-edit view model build failed ` +
			`error=${error instanceof Error ? error.message : String(error)} ` +
			`action="rendering raw output"`,
		);
	}
	if (viewModel) details.bashUi = { inPlaceEdit: viewModel };

	return { content, errorSuffix, details, viewModel, isError };
}

/**
 * pipeline 执行：段队列按原文顺序调度，段间执行互不共享（各自 executor / 快照 bracket /
 * VM 独立）。组合器职责仅此三项：&& 短路（前段失败跳过后段）、content 忠实拼接（onUpdate
 * 部分输出带前段前缀，流式显示不掉前段）、details 合并（bashUi 两段 VM 并存）。
 * 整体 isError / errorSuffix 取末段（shell：整条命令 exit code = 最后执行的命令）。
 */
export async function executeBashPipeline(
	pipeline: BashCommandPipeline,
	options: ExecuteOptions,
): Promise<ExecuteOutcome> {
	const segments: ExecuteOutcome[] = [];
	let prefix = "";
	for (const [index, plan] of pipeline.plans.entries()) {
		if (index > 0 && pipeline.shortCircuit && segments[index - 1]!.isError) break;
		const onUpdate = options.onUpdate;
		const segmentOptions: ExecuteOptions = onUpdate === undefined ? options : {
			...options,
			onUpdate: (update) => {
				const text = update.content.map((item) => (item.type === "text" ? item.text : "")).join("");
				onUpdate({ ...update, content: [{ type: "text", text: prefix + text }] });
			},
		};
		const segment = plan.kind === "apply-patch"
			? await executeApplyPatchPlan(plan, segmentOptions)
			: await executeInPlaceEditPlan(plan, segmentOptions);
		segments.push(segment);
		prefix += segment.content;
	}
	const last = segments.at(-1)!;
	const details: ExecuteOutcome["details"] = {};
	for (const segment of segments) {
		if (segment.details.truncation !== undefined) {
			details.truncation = segment.details.truncation;
			details.fullOutputPath = segment.details.fullOutputPath;
		}
		if (segment.details.bashUi) details.bashUi = { ...details.bashUi, ...segment.details.bashUi };
	}
	return {
		content: segments.map((segment) => segment.content).join(""),
		errorSuffix: last.errorSuffix,
		details,
		viewModel: last.viewModel,
		isError: last.isError,
	};
}

let batchCounter = 0;
const diffSubmitter: DiffBatchSubmitter = async (inputs: readonly DiffInput[]) => {
	try {
		const response = await requestDiffBatch(inputs, `apply-patch-${batchCounter++}`);
		return response.files;
	} catch {
		// worker 崩溃 / session dispose 已在 diff-service 记录单条结构化 diagnostic；
		// 这里静默降级 intent diff（已定义 degradation）。
		return undefined;
	}
};
