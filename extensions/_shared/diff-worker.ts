/**
 * diff-worker.ts — 串行 diff 执行线程（每个 Pi 进程一个实例）。
 *
 * 一次消息 = 一个 batch：for 循环串行计算每个文件（同步 CPU 任务，
 * Promise.all 不会增加真正并行，只会误导读者）。
 * exact 走 generateFinalDiff（250ms timeout 是 abnormal 输入 tripwire）；
 * rewrite 走 generateRewriteDiff（O(N)，精确 stats，边构建边截断）。
 * Node 主线程（TUI、事件循环）不被 diff 计算阻塞。
 */

import { parentPort } from "node:worker_threads";

import { generateFinalDiff, generateRewriteDiff } from "./final-diff.ts";
import type { DiffBatchRequest, DiffBatchResponse, DiffInput, DiffOutput } from "./diff-service.ts";

function computeDiff(file: DiffInput): DiffOutput {
	if (file.strategy.kind === "rewrite") {
		const diff = generateRewriteDiff(file.oldContent, file.newContent);
		return {
			fileId: file.fileId,
			display: diff.display,
			stats: diff.stats,
			firstChangedLine: diff.firstChangedLine,
			truncated: diff.truncated,
			degraded: diff.degraded,
		};
	}
	const diff = generateFinalDiff(file.oldContent, file.newContent, file.contextLines, {
		timeoutMs: file.timeoutMs,
	});
	return {
		fileId: file.fileId,
		display: diff.display,
		stats: diff.stats,
		firstChangedLine: diff.firstChangedLine,
		truncated: diff.truncated,
		degraded: diff.degraded,
	};
}

parentPort!.on("message", (request: DiffBatchRequest) => {
	const response: DiffBatchResponse = { requestId: request.requestId, files: [] };
	for (const file of request.files) {
		response.files.push(computeDiff(file));
	}
	parentPort!.postMessage(response);
});
