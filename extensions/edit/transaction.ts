/**
 * transaction.ts —— 脚本执行器：一次调用 = 一个编辑脚本，顺序链式执行。
 *
 * 入口 `executeEditScript`：校验后的请求 + cwd → 条目结局序列。路径解析与
 * 别名闸门在这里（读盘前），随后每条目当作脚本的一行逐行执行：
 * - 每条目独立读-改-写（锁按文件持有，同一文件的连续条目串行化）；
 * - 任一失败 → 该条目零写入并报错，其后条目全部 skipped，已成者保留；
 * - 无回滚、无整段脚本提交：单条 writeFile 是原子的最小单位，失败的文件
 *   状态由错误消息响亮说明。
 */

import * as fs from "node:fs";
import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { generateFinalDiff } from "../_shared/final-diff.ts";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import {
	applyEntryToNormalizedContent,
	isEditToolError,
	normalizeToLF,
	type ClosestText,
	type EditEntry,
	type EditRequest,
	type MatchedEditSpan,
	type RecoverableEditErrorKind,
} from "./match.ts";
import { diffFromSpans } from "./span-diff.ts";

/** preview 的 context 行数（与共享 diff 引擎默认一致）。 */
const EDIT_PREVIEW_CONTEXT_LINES = 4;

// Hard file-size gate. Files larger than this are rejected before reading.
export const MAX_EDIT_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) {
		return "\n";
	}
	if (crlfIdx === -1) {
		return "\n";
	}
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

/** 事务的文件系统端口：测试用内存实现替换它（唯一消费者是 executeEntries）。 */
type EntryOperations = {
	access: (absolutePath: string) => Promise<void>;
	readFile: (absolutePath: string) => Promise<string>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	stat: (absolutePath: string) => Promise<{ size: number }>;
};

const defaultEntryOperations: EntryOperations = {
	access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
	readFile: (absolutePath) => readFile(absolutePath, "utf-8"),
	writeFile: (absolutePath, content) => writeFile(absolutePath, content, "utf-8"),
	stat: (absolutePath) => stat(absolutePath),
};

function formatAccessError(error: unknown): Error {
	if (error instanceof Error) {
		const errorWithCode = error as Error & { code?: string };
		if (errorWithCode.code === "ENOENT") {
			return new Error("File not found.");
		}
		if (errorWithCode.code === "EACCES" || errorWithCode.code === "EPERM") {
			return new Error("File must be readable and writable. Check permissions.");
		}
		return error;
	}
	return new Error(String(error));
}

/**
 * 锁：一次调用持有全部涉及文件的 mutation lock。
 *
 * 获取顺序 = canonical path 字典序（全局一致的顺序 → 并发调用之间的等待图
 * 无环 → 无死锁；built-in write/edit 只取单锁，同样不成环）。同一 queue key
 * 重复获取会自锁，调用方必须先按 canonical path 去重。
 */
async function withAllFileMutationQueues<T>(
	absolutePaths: readonly string[],
	run: () => Promise<T>,
): Promise<T> {
	const ordered = [...absolutePaths].sort();
	const acquire = (index: number): Promise<T> =>
		index === ordered.length
			? run()
			: withFileMutationQueue(ordered[index]!, () => acquire(index + 1));
	return acquire(0);
}

type EntryRequest = {
	/** 已 canonicalize 的绝对路径；序列内可重复（同一文件的多个条目顺序应用）。 */
	absolutePath: string;
	/** 模型发来的条目，原样传入——路径解析是唯一加进来的东西。 */
	entry: EditEntry;
};

/**
 * 一个条目的结局。`entry` 是模型发来的那一条，原样回贴——展示与复述都用它，
 * 不再另造一份 identity。字段名即终局：UI 与 agent 输出直接读这些名字。
 */
export type EntryOutcome = { entry: EditEntry } & (
	| {
			status: "applied";
			changeStats: ChangeStats;
			display: DisplayDiff;
			truncated: boolean;
			firstChangedLine?: number;
	  }
	| { status: "failed"; error: string; errorKind?: RecoverableEditErrorKind; closest?: ClosestText }
	/** 前序条目失败后未尝试的条目。 */
	| { status: "skipped" }
);

/** 整段脚本的结局：applied=全部落盘；rejected=一个字节都没落；partial=部分。 */
export type ScriptOutcome = {
	status: "applied" | "rejected" | "partial";
	note: string;
	/** 一次调用只改这一个文件：path 顶层说一次，条目不再重复。 */
	path: string;
	/** 渲染要用它把绝对路径显示成相对路径。 */
	cwd: string;
	/** 与 `edits` 同序同长。 */
	entries: EntryOutcome[];
};

type PreparedEntry = {
	absolutePath: string;
	rawContent: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
	normalizedContent: string;
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

type ReadOutcome =
	| { kind: "read"; prepared: PreparedEntry }
	| { kind: "failed"; error: string; errorKind?: RecoverableEditErrorKind; closest?: ClosestText };

function toFailure(error: unknown): Extract<ReadOutcome, { kind: "failed" }> {
	if (isEditToolError(error)) {
		return {
			kind: "failed",
			error: error.message,
			errorKind: error.kind,
			...(error.closest !== undefined ? { closest: error.closest } : {}),
		};
	}
	return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

/**
 * 读 + 应用单条编辑条目（解析面，零写入）。失败作为单条目事实返回；abort 上抛。
 */
async function readAndApplyEntry(
	request: EntryRequest,
	operations: EntryOperations,
	signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
	throwIfAborted(signal);
	try {
		// Preflight: hard file-size gate before reading content into memory.
		try {
			const fileStat = await operations.stat(request.absolutePath);
			if (fileStat.size > MAX_EDIT_FILE_SIZE_BYTES) {
				throw new Error(
					`File too large: sizeBytes=${fileStat.size} limitBytes=${MAX_EDIT_FILE_SIZE_BYTES}; use a narrower match or a streaming tool.`,
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("File too large")) throw error;
		}

		try {
			await operations.access(request.absolutePath);
		} catch (error) {
			throw formatAccessError(error);
		}
		throwIfAborted(signal);

		const rawContent = await operations.readFile(request.absolutePath);
		throwIfAborted(signal);

		const { bom, text } = stripBom(rawContent);
		const lineEnding = detectLineEnding(text);
		const normalizedContent = normalizeToLF(text);
		const { newContent, matchedSpans } = applyEntryToNormalizedContent(normalizedContent, request.entry);
		return {
			kind: "read",
			prepared: {
				absolutePath: request.absolutePath,
				rawContent,
				bom,
				lineEnding,
				normalizedContent,
				newContent,
				matchedSpans,
			},
		};
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.message === "Operation aborted")) throw error;
		return toFailure(error);
	}
}

function serializeForDisk(prepared: PreparedEntry): string {
	return prepared.bom + restoreLineEndings(prepared.newContent, prepared.lineEnding);
}

/**
 * 展示 diff：用已知的 matched span 直接构造（span-diff），规模 = 编辑规模。
 */
function computePreview(entry: PreparedEntry) {
	// 无锚 span 时不能裁剪，走整文件 diff。
	const diff = entry.matchedSpans.length > 0
		? diffFromSpans(
			entry.normalizedContent,
			entry.newContent,
			entry.matchedSpans,
			EDIT_PREVIEW_CONTEXT_LINES,
		)
		: generateFinalDiff(entry.normalizedContent, entry.newContent, EDIT_PREVIEW_CONTEXT_LINES);
	return {
		display: diff.display,
		truncated: diff.truncated,
		changeStats: diff.stats,
		...(diff.firstChangedLine !== undefined ? { firstChangedLine: diff.firstChangedLine } : {}),
	};
}

/**
 * 条目序列执行器：顺序链式，失败即停，成功保留。
 *
 * - 每条目独立读-改-写：前一条成功即保留，失败条目零写入并报错；
 * - 失败后所有后续条目标记 skipped（不被尝试）；
 * - status：全成 = applied，零写入全败 = rejected（首条即败），否则 partial。
 */
export async function executeEntries(
	entries: readonly EntryRequest[],
	signal?: AbortSignal,
	operations: EntryOperations = defaultEntryOperations,
): Promise<{ status: ScriptOutcome["status"]; entries: EntryOutcome[] }> {
	if (entries.length === 0) {
		return { status: "applied", entries: [] };
	}
	return withAllFileMutationQueues(
		[...new Set(entries.map((entry) => entry.absolutePath))],
		async () => {
			throwIfAborted(signal);

			const outcomes: EntryOutcome[] = [];
			let stopped = false;
			let appliedCount = 0;

			for (const request of entries) {
				if (stopped) {
					outcomes.push({ entry: request.entry, status: "skipped" });
					continue;
				}
				throwIfAborted(signal);

				const read = await readAndApplyEntry(request, operations, signal);
				if (read.kind === "failed") {
					outcomes.push({
					entry: request.entry,
					status: "failed",
					error: read.error,
					...(read.errorKind !== undefined ? { errorKind: read.errorKind } : {}),
					...(read.closest !== undefined ? { closest: read.closest } : {}),
				});
					stopped = true;
					continue;
				}

				// 提交点：此后不再检查 abort 的幂等性问题——writeFile 是单次原子调用。
				try {
					await operations.writeFile(request.absolutePath, serializeForDisk(read.prepared));
					outcomes.push({ entry: request.entry, status: "applied", ...computePreview(read.prepared) });
					appliedCount += 1;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					// 写失败的文件可能留下不完整字节——无回滚，必须响亮说明。
					outcomes.push({ entry: request.entry, status: "failed", error: `${message}; the file may be partially written` });
					stopped = true;
				}
			}

			const status = appliedCount === entries.length ? "applied" : appliedCount > 0 ? "partial" : "rejected";
			return { status, entries: outcomes };
		},
	);
}
function canonicalizePath(filePath: string, cwd: string): string {
	const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	try {
		return fs.realpathSync.native(resolvedPath);
	} catch {
		return path.normalize(resolvedPath);
	}
}

/**
 * 脚本执行入口：一次调用只改一个文件——path 顶层唯一，同一文件的多个拼法
 * 没有并存的机会，别名歧义在形状上不存在。条目按序链式应用到该文件。
 */
export async function executeEditScript(
	request: EditRequest,
	cwd: string,
	signal?: AbortSignal,
): Promise<ScriptOutcome> {
	const absolutePath = canonicalizePath(request.path, cwd);
	const result = await executeEntries(
		request.edits.map((edit) => ({ absolutePath, entry: edit })),
		signal,
	);
	return { status: result.status, note: request.note, path: request.path, cwd, entries: result.entries };
}
