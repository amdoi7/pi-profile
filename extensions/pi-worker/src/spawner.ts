import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWorkerPreamble, WORKER_TOOL_ALLOWLIST, workerSessionDir } from "./contract.ts";

export interface SpawnOptions {
	cwd: string;
	id: string;
	name: string;
	model?: string;
	thinking?: string;
	/** run 合约归一化工具面;缺省 = WORKER_TOOL_ALLOWLIST */
	tools?: string;
}

const TERMINATE_GRACE_MS = 2000;

/** 自身 index.ts 的绝对路径(--no-extensions 后显式加载,send_message 工具入口)。 */
const SELF_INDEX_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

/**
 * 子 pi 进程 spawn 参数(纯组装,可单测)。pi CLI 注入面:
 * - AGENTS.md 链/SYSTEM.md/skills 均由 pi 机制加载(与父同),不进 preamble;
 * - --no-extensions -e <自身>:子进程只加载 pi-worker 自身(send_message),
 *   不加载父的扩展列表(btw/context-ui/custom-footer 等,rpc 模式无 UI);
 * - -t 白名单:限制工具面(上下文 + 安全);
 * - --session-dir:审计目录内置约定 <cwd>/.pi/worker-sessions/p<父pid>
 *   (归属命名空间:恢复按目录判定所有者,同 cwd 多窗口互不认领)。
 */
export function buildSpawnArgs(opts: SpawnOptions): string[] {
	const preamble = preambleOverride(() => buildWorkerPreamble({ name: opts.name, id: opts.id }));
	const args = [
		"--mode",
		"rpc",
		"--session-dir",
		workerSessionDir(opts.cwd, process.pid),
		"--name",
		opts.id,
		"--no-extensions",
		"-e",
		SELF_INDEX_PATH,
		"-t",
		opts.tools ?? WORKER_TOOL_ALLOWLIST,
		"--append-system-prompt",
		preamble,
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

/** 拟合循环 A/B 钩子:PI_WORKER_PREAMBLE_FILE 设置时以其文件内容整体替换
 * buildWorkerPreamble(仅 eval 对照实验用;生产环境不设,缺省走 charter)。 */
function preambleOverride(fallback: () => string): string {
	const f = process.env.PI_WORKER_PREAMBLE_FILE;
	return f ? readFileSync(f, "utf8").trim() : fallback();
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
