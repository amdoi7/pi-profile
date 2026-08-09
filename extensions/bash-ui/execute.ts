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
import type { ApplyPatchInvocation, ApplyPatchPlan } from "./recognize.ts";
import { snapshotPaths, type FileSnapshot, type SnapshotSet } from "./patch-snapshot.ts";
import { buildResultViewModel, type DiffBatchSubmitter } from "./view-model-build.ts";
import type { ApplyPatchResultViewModel } from "./view-model-codec.ts";

/**
 * execute.ts — 执行者架构（终局）：识别 canonical shape 后自己执行 patch invocations，
 * 语义从源头就是结构，不再从混流文本逆向重建。
 *
 *   recognize -> per-invocation（withFileMutationQueue + before 快照 + exec + after 快照）
 *             -> && 短路 -> trailing（原生 shell 语义）-> worker batch -> VM
 *
 * 守恒：
 * - 非识别命令 delegate built-in（index.ts），语义零改动。
 * - content 是 CLI 真实输出的忠实拼接 + trailing 原文；模型看到的 world 不变。
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
	/** 忠实拼接的 CLI 输出（invocations 原文 + trailing 截断快照 + 错误后缀）。 */
	content: string;
	/** built-in metadata（truncation/fullOutputPath）+ bashUi view model。 */
	details: {
		truncation?: unknown;
		fullOutputPath?: string;
		bashUi?: { applyPatch: ApplyPatchResultViewModel };
	};
	viewModel: ApplyPatchResultViewModel | undefined;
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

/** 重建执行命令：quoted heredoc（无变量展开，与 shell 语义一致）。 */
function buildInvocationCommand(invocation: ApplyPatchInvocation): string {
	return `apply_patch <<'${INVOCATION_MARKER}'\n${invocation.envelope}\n${INVOCATION_MARKER}`;
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

	for (const invocation of plan.invocations) {
		if (aborted) break;
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
			onUpdate?.({ content: [{ type: "text", text: outputText }], details: undefined });
			continue;
		}
		if (parsed.success) {
			if (!successMatchesPatch(invocation.patch, parsed.changes)) matched = false;
		} else if (!failureMatchesPatch(invocation.patch, parsed.failure)) {
			matched = false;
		}
		executed.push({ invocation, parsed, before: runResult.before, after: runResult.after });
		onUpdate?.({ content: [{ type: "text", text: outputText }], details: undefined });
		if (!parsed.success) {
			invocationFailure = { exitCode: runResult.exitCode ?? 1 };
			break; // && 短路
		}
	}

	// trailing：invocation 全部成功且未 abort 且语义已确认时执行（&& 语义）。
	let trailingSnapshot: ReturnType<OutputAccumulator["snapshot"]> | undefined;
	let trailingFailure: TrailingFailure | undefined;
	if (!invocationFailure && !aborted && matched && plan.trailingCommand) {
		const trailingCommand = plan.trailingCommand.replace(/^[ \t]*&&[ \t]*/, "");
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
		const settleTrailing = async (): Promise<void> => {
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = undefined;
			}
			emitUpdate();
			accumulator.finish();
			await accumulator.closeTempFile();
			trailingSnapshot = accumulator.snapshot();
		};
		try {
			const result = await ops.exec(trailingCommand, plan.invocations.at(-1)!.cwd, {
				onData: (data) => {
					accumulator.append(data);
					scheduleUpdate();
				},
				signal,
				timeout,
				env,
			});
			await settleTrailing();
			if (result.exitCode !== 0 && result.exitCode !== null) {
				trailingFailure = { kind: "exit", exitCode: result.exitCode };
			}
		} catch (error) {
			await settleTrailing();
			if (error instanceof Error && error.message === "aborted") {
				aborted = true;
			} else if (error instanceof Error && error.message.startsWith("timeout:")) {
				trailingFailure = { kind: "timeout", seconds: error.message.split(":")[1] ?? String(timeout) };
			} else {
				trailingFailure = { kind: "other", message: error instanceof Error ? error.message : String(error) };
			}
		}
	}

	// content：invocations 输出原文 + trailing 截断快照 + 错误后缀（built-in 形状）。
	let content = outputText;
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
	} else if (trailingFailure) {
		isError = true;
		if (trailingFailure.kind === "exit") errorSuffix = `Command exited with code ${trailingFailure.exitCode}`;
		else if (trailingFailure.kind === "timeout") errorSuffix = `Command timed out after ${trailingFailure.seconds} seconds`;
		else errorSuffix = trailingFailure.message;
	} else if (invocationFailure) {
		isError = true;
		errorSuffix = `Command exited with code ${invocationFailure.exitCode}`;
	}
	if (errorSuffix !== undefined) {
		content = `${content ? `${content}\n\n` : ""}${errorSuffix}`;
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

	return { content, details, viewModel, isError };
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
