import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWorkerCharter } from "./contract.ts";

export interface SpawnOptions {
	cwd: string;
	sessionDir: string;
	id: string;
	name: string;
	model?: string;
	thinking?: string;
}

const TERMINATE_GRACE_MS = 2000;

/** 自身 index.ts 的绝对路径(--no-extensions 后显式加载,send_message 工具入口)。 */
const SELF_INDEX_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

/**
 * 子进程工具白名单:基础工作面(read/bash/edit/write)+ 通信(send_message)。
 * 排除父环境的扩展工具(pi_worker/uv 等)——worker 不需要,且限面即安全。
 */
const WORKER_TOOL_ALLOWLIST = "read,bash,edit,write,send_message";

/**
 * 子 pi 进程 spawn 参数(纯组装,可单测)。借鉴 pi CLI 注入面做 worker 瘦身:
 * - --no-skills / --no-context-files:worker 不加载父的 skills/AGENTS.md,
 *   治理由 --append-system-prompt 注入的 worker 宪法(buildWorkerCharter)承担;
 * - --no-extensions -e <自身>:子进程只加载 pi-worker 自身(send_message),
 *   不加载父的扩展列表(btw/context-ui/custom-footer 等,rpc 模式无 UI);
 * - -t 白名单:限制工具面(上下文 + 安全);
 * - --append-system-prompt:worker 宪法(身份/四要素/先回执/失败归因/事实核验)。
 */
export function buildSpawnArgs(opts: SpawnOptions): string[] {
	const args = [
		"--mode",
		"rpc",
		"--session-dir",
		opts.sessionDir,
		"--name",
		opts.id,
		"--no-skills",
		"--no-context-files",
		"--no-extensions",
		"-e",
		SELF_INDEX_PATH,
		"-t",
		WORKER_TOOL_ALLOWLIST,
		"--append-system-prompt",
		buildWorkerCharter({ name: opts.name, id: opts.id, sessionDir: opts.sessionDir }),
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	return args;
}

/**
 * spawn 子 pi 进程(--mode rpc)。PI_WORKER_CHILD=1 是区分子进程的唯一标记:
 * 父自身可能是 tui 或 rpc,不能靠 mode 区分。
 */
export function spawnChild(opts: SpawnOptions): ChildProcess {
	return spawn("pi", buildSpawnArgs(opts), {
		cwd: opts.cwd,
		env: { ...process.env, PI_WORKER_CHILD: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

/** SIGTERM,宽限期后 SIGKILL。对已退出进程无操作。 */
export function terminate(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	proc.kill("SIGTERM");
	const timer = setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
	}, TERMINATE_GRACE_MS);
	timer.unref();
}
