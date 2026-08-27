/**
 * transaction.ts —— 多文件原子事务：锁 → 解析面（只读）→ 提交面（写/回滚）。
 *
 * 匹配语义的唯一来源在 match.ts；本文件只消费它的结果。职责边界：
 * - 解析面（尺寸闸门 → 可读写 → 读入 → 内存内应用 edits）不写任何字节，
 *   任一文件失败 → 整批 rejected，全部失败一次性回报；
 * - 提交面写盘失败 → 已写文件按原始字节回滚：全部还原 = rejected，
 *   还原失败的留在盘上 = partial（响亮报出，绝不静默半提交）；
 * - abort 在提交点之前生效；越过提交点后事务必须走完，避免半写状态。
 * - 锁：一次事务持有 batch 内全部文件的 mutation lock，获取顺序 = canonical
 *   path 字典序（全局一致顺序 → 并发 batch 之间无环 → 无死锁）。
 */

import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import {
	applyEditsToNormalizedContent,
	isEditToolError,
	normalizeToLF,
	type FileEditOperation,
	type MatchedEditSpan,
	type RecoverableEditErrorKind,
} from "./match.ts";
import { diffFromSpans } from "./span-diff.ts";

/** preview 的 context 行数（与共享 diff 引擎默认一致）。 */
const EDIT_PREVIEW_CONTEXT_LINES = 4;

// Hard file-size gate. Files larger than this are rejected before reading.
export const MAX_EDIT_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

export function detectLineEnding(content: string): "\r\n" | "\n" {
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

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

export type EditEngineOperations = {
	access: (absolutePath: string) => Promise<void>;
	readFile: (absolutePath: string) => Promise<string>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	stat: (absolutePath: string) => Promise<{ size: number }>;
};

export const defaultEditEngineOperations: EditEngineOperations = {
	access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
	readFile: (absolutePath) => readFile(absolutePath, "utf-8"),
	writeFile: (absolutePath, content) => writeFile(absolutePath, content, "utf-8"),
	stat: (absolutePath) => stat(absolutePath),
};

export type BatchFileEditRequest = {
	/** 已 canonicalize 的绝对路径；同一 batch 内必须互不相同（pipeline 去重）。 */
	absolutePath: string;
	edits: FileEditOperation[];
};

export type FileDiffPreview = {
	previewDisplay: DisplayDiff;
	previewStartLine?: number;
	previewTruncated: boolean;
	changeStats: ChangeStats;
};

export type BatchFileOutcome =
	/** 落盘完成（batch status=partial 时表示回滚失败、内容仍留在盘上）。 */
	| { status: "applied"; preview: FileDiffPreview }
	| { status: "failed"; error: string; errorKind?: RecoverableEditErrorKind }
	/** 匹配无误但整批被拒，未落盘；restored=true 表示写过又被回滚。 */
	| { status: "notWritten"; restored: boolean };

export type BatchEditResult = {
	/** applied=全部落盘；rejected=一个字节都没落；partial=部分留在盘上且无法回滚。 */
	status: "applied" | "rejected" | "partial";
	/** 与输入同序同长。 */
	files: BatchFileOutcome[];
};

type PreparedFile = {
	absolutePath: string;
	/** 原始字节（含 BOM / 原行尾）——回滚按 verbatim 还原，不经归一化往返。 */
	rawContent: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
	normalizedContent: string;
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

type PreparedFileResult =
	| { kind: "prepared"; prepared: PreparedFile }
	| { kind: "failed"; error: string; errorKind?: RecoverableEditErrorKind };

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
 * 一次事务持有 batch 内全部文件的 mutation lock。
 *
 * 获取顺序 = canonical path 字典序（全局一致的顺序 → 并发 batch 之间的等待图
 * 无环 → 无死锁；内置 write/edit 只取单锁，同样不成环）。同一 queue key 重复
 * 获取会自锁，调用方必须先按 canonical path 去重。
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

export type BatchFileEditRequest = {
	/** 已 canonicalize 的绝对路径；同一 batch 内必须互不相同（pipeline 去重）。 */
	absolutePath: string;
	edits: FileEditOperation[];
};

export type FileDiffPreview = {
	previewDisplay: DisplayDiff;
	previewStartLine?: number;
	previewTruncated: boolean;
	changeStats: ChangeStats;
};

export type BatchFileOutcome =
	/** 落盘完成（batch status=partial 时表示回滚失败、内容仍留在盘上）。 */
	| { status: "applied"; preview: FileDiffPreview }
	| { status: "failed"; error: string; errorKind?: RecoverableEditErrorKind }
	/** 匹配无误但整批被拒，未落盘；restored=true 表示写过又被回滚。 */
	| { status: "notWritten"; restored: boolean };

export type BatchEditResult = {
	/** applied=全部落盘；rejected=一个字节都没落；partial=部分留在盘上且无法回滚。 */
	status: "applied" | "rejected" | "partial";
	/** 与输入同序同长。 */
	files: BatchFileOutcome[];
};

type PreparedFile = {
	absolutePath: string;
	/** 原始字节（含 BOM / 原行尾）——回滚按 verbatim 还原，不经归一化往返。 */
	rawContent: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
	normalizedContent: string;
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

type PreparedFileResult =
	| { kind: "prepared"; prepared: PreparedFile }
	| { kind: "failed"; error: string; errorKind?: RecoverableEditErrorKind };

function toFailure(error: unknown): PreparedFileResult {
	if (isEditToolError(error)) {
		return { kind: "failed", error: error.message, errorKind: error.kind };
	}
	return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

/**
 * 解析面（只读）：尺寸闸门 → 可读写 → 读入 → 内存内应用 edits。
 * 不写任何字节；失败作为 per-file 事实返回，abort 直接抛出。
 */
async function prepareFileEdit(
	request: BatchFileEditRequest,
	operations: EditEngineOperations,
	signal: AbortSignal | undefined,
): Promise<PreparedFileResult> {
	throwIfAborted(signal);
	try {
		// Preflight: hard file-size gate before reading content into memory.
		// stat failure falls through to access check for a cleaner error.
		try {
			const fileStat = await operations.stat(request.absolutePath);
			if (fileStat.size > MAX_EDIT_FILE_SIZE_BYTES) {
				throw new Error(
					`File too large: sizeBytes=${fileStat.size} limitBytes=${MAX_EDIT_FILE_SIZE_BYTES}; use a narrower oldText or a streaming tool.`,
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
		// applyEditsToNormalizedContent 是匹配语义的唯一来源。
		const { newContent, matchedSpans } = applyEditsToNormalizedContent(normalizedContent, request.edits);
		return {
			kind: "prepared",
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
		// abort 不是 per-file 事实：直接上抛，整批不落盘。
		if (signal?.aborted || (error instanceof Error && error.message === "Operation aborted")) throw error;
		return toFailure(error);
	}
}

function serializeForDisk(prepared: PreparedFile): string {
	return prepared.bom + restoreLineEndings(prepared.newContent, prepared.lineEnding);
}

/**
 * 展示 diff：用已知的 matched spans 直接构造（span-diff），规模 = 编辑规模。
 * 没有 worker、没有超时 tripwire、没有阈值预算——因为没有要「求解」的东西。
 */
function computePreview(file: PreparedFile): FileDiffPreview {
	const diff = diffFromSpans(
		file.normalizedContent,
		file.newContent,
		file.matchedSpans,
		EDIT_PREVIEW_CONTEXT_LINES,
	);
	return {
		previewDisplay: diff.display,
		previewStartLine: diff.firstChangedLine,
		previewTruncated: diff.truncated,
		changeStats: diff.stats,
	};
}

/**
 * 一个意图 = 一个事务：batch 内全部文件先解析、再整批落盘。
 *
 * - 解析面任一文件失败 → 一个字节都不写，全部失败一次性回报（status=rejected）；
 * - 落盘面 IO 失败 → 已写文件按原始字节回滚；全部还原 = rejected，
 *   还原失败的留在盘上 = partial（响亮报出，绝不静默半提交）；
 * - abort 在提交点之前生效；越过提交点后事务必须走完，避免半写状态。
 */
export async function executeBatchEdits(
	files: readonly BatchFileEditRequest[],
	signal?: AbortSignal,
	operations: EditEngineOperations = defaultEditEngineOperations,
): Promise<BatchEditResult> {
	return withAllFileMutationQueues(files.map((file) => file.absolutePath), async () => {
		throwIfAborted(signal);

		const resolutions: PreparedFileResult[] = [];
		for (const file of files) {
			resolutions.push(await prepareFileEdit(file, operations, signal));
		}

		if (resolutions.some((resolution) => resolution.kind === "failed")) {
			return {
				status: "rejected",
				files: resolutions.map((resolution) =>
					resolution.kind === "failed"
						? { status: "failed", error: resolution.error, errorKind: resolution.errorKind }
						: { status: "notWritten", restored: false }
				),
			};
		}

		const prepared = resolutions.map((resolution) => {
			if (resolution.kind !== "prepared") throw new Error("unreachable: unresolved batch entry");
			return resolution.prepared;
		});

		// 提交点：此后不再检查 abort，事务走完，避免半写状态。
		throwIfAborted(signal);

		const written: PreparedFile[] = [];
		let writeFailure: { index: number; message: string } | undefined;
		for (let index = 0; index < prepared.length; index += 1) {
			const file = prepared[index]!;
			try {
				await operations.writeFile(file.absolutePath, serializeForDisk(file));
				written.push(file);
			} catch (error) {
				writeFailure = { index, message: error instanceof Error ? error.message : String(error) };
				break;
			}
		}

		if (writeFailure === undefined) {
			return {
				status: "applied",
				files: prepared.map((file) => ({ status: "applied" as const, preview: computePreview(file) })),
			};
		}

		// 回滚：逆序写回原始字节（锁仍在手，无第三方写入窗口）。
		const restored = new Set<string>();
		for (const file of [...written].reverse()) {
			try {
				await operations.writeFile(file.absolutePath, file.rawContent);
				restored.add(file.absolutePath);
			} catch {
				// 无法还原 → 该文件留在盘上，由 partial 状态响亮报出。
			}
		}
		const stranded = written.filter((file) => !restored.has(file.absolutePath));
		const strandedPaths = new Set(stranded.map((file) => file.absolutePath));

		return {
			status: stranded.length > 0 ? "partial" : "rejected",
			files: prepared.map((file, index) => {
				if (index === writeFailure.index) {
					return { status: "failed" as const, error: writeFailure.message };
				}
				if (strandedPaths.has(file.absolutePath)) {
					return { status: "applied" as const, preview: computePreview(file) };
				}
				return { status: "notWritten" as const, restored: restored.has(file.absolutePath) };
			}),
		};
	});
}
