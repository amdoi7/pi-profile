/**
 * execute.ts —— apply_patch 命令的守卫执行路径（bash 工具 execute 覆写）。
 *
 * 背景：内置 bash 工具 execute 在 apply_patch 成功后跑同步 jsdiff 全量 diff
 * （O(ND) Myers、主线程、无超时）——大 buffer 时 tool call 卡死。见
 * guarded-diff.ts 顶部说明。本文件把 apply_patch 的执行结果接入守卫 diff；
 * 其余语义逐行对照内置 bash.js 复制：spawn 委托 createLocalBashOperations
 * （内置；含 waitForChildProcess 的 detached-descendant 空闲宽限、abort/timeout
 * killProcessTree、commandTransport=stdin 兼容），输出累积走本地
 * accumulator.ts（内置 OutputAccumulator 的忠实副本，见文件头），
 * env 构造、onUpdate 节流、truncation 脚注、错误信息全部与内置一致。
 *
 * 上游：pi dist/core/tools/bash.js（基线 2026-08）。语义对齐承诺：
 * CLI stdout/stderr/exit code、content、错误文案与内置一致；唯一契约差异是
 * apply_patch 的展示 diff：结构化 details.patchFiles（worker + tripwire 产出的
 * DisplayDiff，双侧行号）取代内置的 details.diffs 单列字符串，由 index.ts 的
 * renderResult 自渲染。
 */
import { delimiter } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	createLocalBashOperations,
	formatSize,
	type AgentToolUpdateCallback,
	type BashOperations,
	type BashToolDetails,
} from "@earendil-works/pi-coding-agent";

import { OutputAccumulator } from "./accumulator.ts";
import {
	APPLY_PATCH_RE,
	computeGuardedPatchDiffs,
	extractPatchFiles,
	snapshotFiles,
} from "./guarded-diff.ts";

const BASH_UPDATE_THROTTLE_MS = 100;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/** 与内置 getBinDir/getShellEnv 同构（config.js 基线的内联副本）。
 * getAgentDir = env[PI_CODING_AGENT_DIR] ?? ~/.pi/agent（无 ~ 展开，normalize 而已）。 */
function resolveBinDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = envDir ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "bin");
}

function buildShellEnv(): NodeJS.ProcessEnv {
	const binDir = resolveBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);
	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * 与内置 resolveSpawnContext 同构：env 上去掉 PI_SESSION_* 再按
 * exposeSessionEnvironment 重新注入（session 身份属于父进程，不默认透传）。
 */
function buildSpawnContext(
	command: string,
	cwd: string,
	exposeSessionEnvironment: boolean,
	ctx: unknown,
): { command: string; cwd: string; env: NodeJS.ProcessEnv } {
	const env: NodeJS.ProcessEnv = { ...buildShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		// 防御：真实运行 ctx 恒有 sessionManager；测试/异常 ctx 缺失时静默跳过分组 env。
		const session = (ctx as { sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } }).sessionManager;
		if (session) {
			env.PI_SESSION_ID = session.getSessionId();
			const sessionFile = session.getSessionFile();
			if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		}
		const model = (ctx as { model?: { provider: string; id: string } }).model;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		const thinkingLevel = (ctx as { thinkingLevel?: string }).thinkingLevel;
		if (thinkingLevel) env.PI_REASONING_LEVEL = thinkingLevel;
	}
	return { command, cwd, env };
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) {
		return undefined;
	}
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

type ExecuteShared = {
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>;
	ctx: unknown;
	timeout?: number;
};

/**
 * apply_patch 命令的守卫执行主体。返回与内置 execute 同形（content/details）；
 * 错误分支抛与内置同文案的 Error。
 */
/**
 * 守卫只为一个目的:把补丁落盘前后的快照变成可看的真 diff。
 *
 * 文件改写的 owner 是 edit（一个意图一个事务），路由面已不再指向这条路;它留着只服务
 * 人直接调用遗留 CLI 时的渲染。因此它不约束也不改写模型行为，不进机制账;
 * 当遗留 CLI 不再被人使用时，整条守卫路径随它一起退役。
 */
export async function executeApplyPatchGuarded(
	command: string,
	cwd: string,
	options: ExecuteShared,
	overrides: { operations?: BashOperations } = {},
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	const { signal, onUpdate, ctx, timeout } = options;
	const operations = overrides.operations ?? createLocalBashOperations();
	const timeoutMs = resolveTimeoutMs(timeout);
	if (signal?.aborted) {
		throw new Error("aborted");
	}

	const spawnContext = buildSpawnContext(command, cwd, true, ctx);
	const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
	let acceptingOutput = true;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;

	const emitOutputUpdate = () => {
		if (!onUpdate || !updateDirty) {
			return;
		}
		updateDirty = false;
		lastUpdateAt = Date.now();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		onUpdate({
			content: [{ type: "text", text: snapshot.content || "" }],
			details: {
				truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
				fullOutputPath: snapshot.fullOutputPath,
			},
		});
	};
	const clearUpdateTimer = () => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
	};
	const scheduleOutputUpdate = () => {
		if (!onUpdate) {
			return;
		}
		updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitOutputUpdate();
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			emitOutputUpdate();
		}, delay);
	};

	if (onUpdate) {
		onUpdate({ content: [], details: undefined });
	}

	const handleData = (data: Buffer) => {
		if (!acceptingOutput) {
			return;
		}
		output.append(data);
		scheduleOutputUpdate();
	};

	const finishOutput = async () => {
		acceptingOutput = false;
		output.finish();
		clearUpdateTimer();
		emitOutputUpdate();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		return snapshot;
	};

	const formatOutput = (snapshot: ReturnType<OutputAccumulator["snapshot"]>, emptyText = "(no output)") => {
		const truncation = snapshot.truncation;
		let text = snapshot.content || emptyText;
		let details: { truncation?: typeof truncation; fullOutputPath?: string } | undefined;
		if (truncation.truncated) {
			details = { truncation, fullOutputPath: snapshot.fullOutputPath };
			const startLine = truncation.totalLines - truncation.outputLines + 1;
			const endLine = truncation.totalLines;
			if (truncation.lastLinePartial) {
				const lastLineSize = formatSize(output.getLastLineBytes());
				text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
			}
			else if (truncation.truncatedBy === "lines") {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
			}
			else {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(50 * 1024)} limit). Full output: ${snapshot.fullOutputPath}]`;
			}
		}
		return { text, details };
	};

	const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

	try {
		// apply_patch：执行前快照受影响文件，成功后计算守卫 diff。
		const patchFiles = APPLY_PATCH_RE.test(command) ? extractPatchFiles(command) : [];
		const patchBefore = patchFiles.length > 0 ? await snapshotFiles(cwd, patchFiles) : undefined;

		let exitCode: number | null;
		try {
			const result = await operations.exec(spawnContext.command, spawnContext.cwd, {
				onData: handleData,
				signal,
				timeout: timeoutMs,
				env: spawnContext.env,
			});
			exitCode = result.exitCode;
		}
		catch (err) {
			const snapshot = await finishOutput();
			const { text } = formatOutput(snapshot, "");
			if (err instanceof Error && err.message === "aborted") {
				throw new Error(appendStatus(text, "Command aborted"));
			}
			if (err instanceof Error && err.message.startsWith("timeout:")) {
				const timeoutSecs = err.message.split(":")[1];
				throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
			}
			throw err;
		}

		const snapshot = await finishOutput();
		const { text: outputText, details } = formatOutput(snapshot);
		if (exitCode !== 0 && exitCode !== null) {
			throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
		}

		const patchDiffs = patchBefore !== undefined
			? await computeGuardedPatchDiffs(cwd, patchFiles, patchBefore)
			: [];
		if (patchDiffs.length > 0) {
			return {
				content: [{ type: "text", text: outputText }],
				details: { ...details, patchFiles: patchDiffs },
			};
		}
		return { content: [{ type: "text", text: outputText }], details: details ?? {} };
	}
	finally {
		clearUpdateTimer();
	}
}
