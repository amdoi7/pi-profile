/**
 * diff-service.ts — diff 计算的主线程异步客户端（每进程单例）。
 *
 * 并发接收、受控并行：调用方可以同时提交多个 batch（一次 patch run 一个 batch），
 * 但 CPU 计算有界串行 — 单个长期 worker 一次处理一个 batch（FIFO 队列）。
 * 不同 Pi 进程提供进程级并行（4 窗口 = 最多 4 个 active worker）。
 *
 * worker 是 lazy long-lived：首次识别 apply_patch plan 时 warmUp（与 shell 执行重叠），
 * session_shutdown 时 dispose（generation 失效：在途与排队请求全部 reject）。
 *
 * DiffInput.strategy 必须由上游 mutation owner 提供可证明的语义：
 * - exact：无法证明全量替换（正常 patch / edit）；
 * - rewrite：可证明 old 全部被替换（delete-add pair / 全文件 matched span），
 *   直接走 O(N) generateRewriteDiff，不跑 Myers、不猜阈值。
 */

import { Worker } from "node:worker_threads";

import type { ChangeStats, DisplayDiff } from "./final-diff.ts";

export type DiffStrategy =
	| { kind: "exact" }
	| { kind: "rewrite"; reason: "all-lines-replaced" | "delete-add-pair" };

export type DiffInput = {
	fileId: string;
	oldContent: string;
	newContent: string;
	strategy: DiffStrategy;
	contextLines: number;
	timeoutMs?: number;
};

export type DiffOutput = {
	fileId: string;
	display: DisplayDiff;
	stats: ChangeStats;
	firstChangedLine?: number;
	truncated: boolean;
	degraded: boolean;
};

export type DiffBatchRequest = {
	kind: "batch";
	requestId: string;
	files: readonly DiffInput[];
};

export type DiffBatchResponse = {
	requestId: string;
	files: readonly DiffOutput[];
};

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** 在途请求：dispose 时必须 reject，防止 session 切换后悬挂 promise。 */
let pendingRejects: Array<(error: Error) => void> = [];
/** dispose generation：排队请求真正开始时若已失效则 reject，防止 session 切换后幽灵重建 worker。 */
let generation = 0;

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL("./diff-worker.ts", import.meta.url));
		worker.unref();
		worker.on("error", (error) => {
			// 单条结构化 diagnostic（并发 batch × 文件数时避免每请求重复刷屏）；
			// pending jobs 由各自的 onError reject，调用方降级 intent diff。
			console.error(
				`diff worker crashed ` +
				`error=${error instanceof Error ? error.message : String(error)} ` +
				`action="rebuilding worker on next request; current batch degrades to intent diff"`,
			);
			worker?.terminate().catch(() => {});
			worker = null;
		});
		worker.on("exit", () => {
			worker = null;
		});
	}
	return worker;
}

/** 启动（或复用）长期 worker，不等待：worker cold start 与 shell execution 重叠。幂等。 */
export function warmUpDiffWorker(): void {
	getWorker();
}

/**
 * 提交一个 diff batch（一次 patch run 的所有文件，一次提交）。
 * 串行执行：前一个 batch 完成（或失败）后才开始下一个；batch 内文件在 worker 串行计算。
 * 失败（worker 崩溃 / dispose）reject 当前 batch；不自动重试 — intent diff 是已定义 degradation。
 */
/**
 * batch 超时 watchdog（tripwire，不是设计目标）：worker 内死循环（jsdiff 病态输入 /
 * 引擎 bug）时请求无限悬挂。正常 batch 最坏 250ms（Myers tripwire）× 文件数，
 * 10 文件 = 2.5s；5s 为 2 倍余量。超时终止 worker（后续请求重建）并按既有
 * intent-diff degradation reject 当前 batch。
 */
const BATCH_TIMEOUT_MS = 5_000;

export function requestDiffBatch(files: readonly DiffInput[], requestId: string): Promise<DiffBatchResponse> {
	const request: DiffBatchRequest = { kind: "batch", requestId, files };
	const requestGeneration = generation;
	const run = queue.then(
		() => {
			// dispose 后到达执行点的排队请求失效；新 session 的请求（新 generation）正常执行。
			if (requestGeneration !== generation) {
				return Promise.reject(new Error("diff worker disposed at session shutdown"));
			}
			return new Promise<DiffBatchResponse>((resolve, reject) => {
				const target = getWorker();
				pendingRejects.push(reject);
				const timer = setTimeout(() => {
					cleanup();
					// 死循环守卫：杀掉当前 worker，后续请求 lazy 重建；
					// 当前 batch 走已定义 intent-diff degradation。
					console.error(
						`diff worker batch timed out ` +
						`requestId=${requestId} files=${files.length} timeoutMs=${BATCH_TIMEOUT_MS} ` +
						`action="terminating worker; next request rebuilds"`,
					);
					worker?.terminate().catch(() => {});
					worker = null;
					reject(new Error(`diff worker batch timed out after ${BATCH_TIMEOUT_MS}ms`));
				}, BATCH_TIMEOUT_MS);
				const onMessage = (response: DiffBatchResponse) => {
					cleanup();
					resolve(response);
				};
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				const cleanup = () => {
					clearTimeout(timer);
					target.off("message", onMessage);
					target.off("error", onError);
					const index = pendingRejects.indexOf(reject);
					if (index !== -1) pendingRejects.splice(index, 1);
				};
				target.on("message", onMessage);
				target.on("error", onError);
				target.postMessage(request);
			});
		},
	);
	// 失败不阻塞队列：后续请求照常排队（新 worker 接管或同样被 generation 拒绝）。
	queue = run.catch(() => {});
	return run;
}

/**
 * session_shutdown 时清理：拒绝在途与排队 job（调用方走已定义 intent-diff degradation）并终止 worker。
 * 幂等；下次请求 lazy 重建。
 */
export function disposeDiffService(): void {
	generation += 1;
	const error = new Error("diff worker disposed at session shutdown");
	for (const reject of pendingRejects) reject(error);
	pendingRejects = [];
	if (worker) {
		worker.terminate().catch(() => {});
		worker = null;
	}
}
