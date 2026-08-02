import { readFile } from "node:fs/promises";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import { displayDiffFromLines, generateFinalDiff, isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";
import { operationByIndex, type ParsedPatch, type PatchOperation } from "./patch-command.ts";
import {
	type AppliedChange,
	type ApplyPatchFailure,
	failureMatchesPatch,
	parseApplyPatchResultSequence,
	resultText,
	successMatchesPatch,
	type ParsedApplyPatchResult,
	type SuccessfulChange,
} from "./patch-result.ts";

/** execute 前捕获的 before 快照（行号 diff 用）；before=null 表示文件不存在。 */
export type BeforeSnapshots = Map<string, { absolutePath: string; before: string | null }>;

export const PATCH_DIFF_CONTEXT_LINES = 2;

export type ApplyPatchFileDiff = {
	kind: "Add" | "Update" | "Move" | "Delete" | "Rewrite";
	path: string;
	destination?: string;
	changeStats: ChangeStats;
	diffDisplay: DisplayDiff;
	diffTruncated: boolean;
};

export type ApplyPatchBatchFileDiff = ApplyPatchFileDiff & { patchCount: number };

export type ApplyPatchUnapplied = {
	kind: ApplyPatchFileDiff["kind"];
	path: string;
	destination?: string;
};

export type ApplyPatchSingleResultViewModel =
	| {
		kind: "apply-patch-result";
		success: true;
		files: ApplyPatchFileDiff[];
		trailing: string;
	}
	| {
		kind: "apply-patch-result";
		success: false;
		error: {
			code: string;
			message: string;
			path?: string;
			chunkIndex?: number;
		};
		applied: ApplyPatchFileDiff[];
		skipped: ApplyPatchSkipped[];
		contextMismatch?: ApplyPatchContextMismatch;
		unapplied: ApplyPatchUnapplied[];
		trailing: string;
	};

export type ApplyPatchSkipped = {
	operation?: string;
	path?: string;
	message: string;
};

export type ApplyPatchContextMismatch = {
	expectedLines: string[];
	actualLines: string[];
	actualTruncated: boolean;
};

export type ApplyPatchResultViewModel =
	| ApplyPatchSingleResultViewModel
	| {
		kind: "apply-patch-batch-result";
		results: ApplyPatchSingleResultViewModel[];
		finalFiles?: ApplyPatchBatchFileDiff[];
		trailing: string;
	};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFileDiff(value: unknown): value is ApplyPatchFileDiff {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete", "Rewrite"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		isChangeStats(value.changeStats) &&
		isDisplayDiff(value.diffDisplay) &&
		typeof value.diffTruncated === "boolean";
}

function isBatchFileDiff(value: unknown): value is ApplyPatchBatchFileDiff {
	if (!isRecord(value)) return false;
	const patchCount = value.patchCount;
	return isFileDiff(value) &&
		typeof patchCount === "number" &&
		Number.isInteger(patchCount) &&
		patchCount > 0;
}

function isUnapplied(value: unknown): value is ApplyPatchUnapplied {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string");
}

function isSkipped(value: unknown): value is ApplyPatchSkipped {
	return isRecord(value) &&
		(value.operation === undefined || typeof value.operation === "string") &&
		(value.path === undefined || typeof value.path === "string") &&
		typeof value.message === "string";
}

function parseContextMismatch(value: unknown): ApplyPatchContextMismatch | undefined {
	if (!isRecord(value) || !Array.isArray(value.expectedLines) || !Array.isArray(value.actualLines)) return undefined;
	if (!value.expectedLines.every((line) => typeof line === "string")) return undefined;
	if (!value.actualLines.every((line) => typeof line === "string")) return undefined;
	return {
		expectedLines: value.expectedLines,
		actualLines: value.actualLines,
		actualTruncated: value.actualTruncated === true,
	};
}

function parseSingleRenderedResultPayload(details: unknown): ApplyPatchSingleResultViewModel | undefined {
	if (!isRecord(details) || details.kind !== "apply-patch-result" || typeof details.success !== "boolean") return undefined;
	if (details.success === true) {
		if (!Array.isArray(details.files) || !details.files.every(isFileDiff) || typeof details.trailing !== "string") return undefined;
		return { kind: "apply-patch-result", success: true, files: details.files, trailing: details.trailing };
	}
	if (
		!isRecord(details.error) ||
		typeof details.error.code !== "string" ||
		typeof details.error.message !== "string" ||
		!Array.isArray(details.applied) ||
		!details.applied.every(isFileDiff) ||
		!Array.isArray(details.skipped) ||
		!details.skipped.every(isSkipped) ||
		!Array.isArray(details.unapplied) ||
		!details.unapplied.every(isUnapplied) ||
		typeof details.trailing !== "string"
	) return undefined;
	const contextMismatch = details.contextMismatch === undefined ? undefined : parseContextMismatch(details.contextMismatch);
	if (details.contextMismatch !== undefined && !contextMismatch) return undefined;
	return {
		kind: "apply-patch-result",
		success: false,
		error: {
			code: details.error.code,
			message: details.error.message,
			path: typeof details.error.path === "string" ? details.error.path : undefined,
			chunkIndex: typeof details.error.chunkIndex === "number" ? details.error.chunkIndex : undefined,
		},
		applied: details.applied,
		skipped: details.skipped,
		contextMismatch,
		unapplied: details.unapplied,
		trailing: details.trailing,
	};
}

/** 从 result.details 解析结构化结果（tool_result 注入），渲染层只消费它。 */
export function parseRenderedResultPayload(details: unknown): ApplyPatchResultViewModel | undefined {
	const single = parseSingleRenderedResultPayload(details);
	if (single) return single;
	if (
		!isRecord(details) ||
		details.kind !== "apply-patch-batch-result" ||
		!Array.isArray(details.results) ||
		(details.finalFiles !== undefined && (!Array.isArray(details.finalFiles) || !details.finalFiles.every(isBatchFileDiff))) ||
		typeof details.trailing !== "string"
	) {
		return undefined;
	}
	const results = details.results.map(parseSingleRenderedResultPayload);
	return results.some((result) => result === undefined)
		? undefined
		: {
			kind: "apply-patch-batch-result",
			results: results as ApplyPatchSingleResultViewModel[],
			finalFiles: details.finalFiles as ApplyPatchBatchFileDiff[] | undefined,
			trailing: details.trailing,
		};
}

export function operationKindWord(operation: PatchOperation): Exclude<ApplyPatchFileDiff["kind"], "Rewrite"> {
	if (operation.kind === "add") return "Add";
	if (operation.kind === "delete") return "Delete";
	return operation.destination ? "Move" : "Update";
}

export function changeMatchesOperation(change: SuccessfulChange, operation: PatchOperation): boolean {
	const status = operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M";
	return status === change.status && (operation.destination ?? operation.path) === change.path;
}

type BuiltFileDiff = Pick<
	ApplyPatchFileDiff,
	"changeStats" | "diffDisplay" | "diffTruncated"
>;

async function buildFileDiff(
	before: BeforeSnapshots | undefined,
	operation: PatchOperation,
	content?: AppliedChange,
): Promise<BuiltFileDiff | undefined> {
	if (content?.oldContent !== undefined && content.newContent !== undefined) {
		const diff = generateFinalDiff(content.oldContent, content.newContent, PATCH_DIFF_CONTEXT_LINES);
		if (diff.stats.changedLines === 0) return undefined;
		return {
			changeStats: diff.stats,
			diffDisplay: diff.display,
			diffTruncated: diff.truncated,
		};
	}
	const beforeSnapshot = before?.get(operation.path);
	if (!beforeSnapshot) return undefined;
	if (!before) return undefined;
	const afterPath = operation.destination ?? operation.path;
	const afterSnapshot = before.get(afterPath);
	let after: string | null = null;
	if (afterSnapshot) {
		try {
			after = await readFile(afterSnapshot.absolutePath, "utf8");
		} catch {
			// 文件不存在（delete 目标等）：after 为 null。
		}
	}
	const diff = generateFinalDiff(beforeSnapshot.before ?? "", after ?? "", PATCH_DIFF_CONTEXT_LINES);
	if (diff.stats.changedLines === 0) return undefined;
	return {
		changeStats: diff.stats,
		diffDisplay: diff.display,
		diffTruncated: diff.truncated,
	};
}

/** delete 后第一个同 path 的 add 是重写配对（引擎按序应用）。 */
function findRewritePartner(operations: PatchOperation[], start: number): number | undefined {
	const operation = operations[start]!;
	if (operation.kind !== "delete") return undefined;
	for (let i = start + 1; i < operations.length; i++) {
		const candidate = operations[i]!;
		if (candidate.kind === "add" && candidate.path === operation.path) return i;
	}
	return undefined;
}

async function buildRewriteFileDiff(
	before: BeforeSnapshots | undefined,
	deleteOp: PatchOperation,
	addOp: PatchOperation,
): Promise<ApplyPatchFileDiff> {
	const oldSnapshot = before?.get(deleteOp.path);
	const oldContent = oldSnapshot?.before ?? "";
	let after: string | null = null;
	if (oldSnapshot) {
		try {
			after = await readFile(oldSnapshot.absolutePath, "utf8");
		} catch {
			// 文件不存在：after 为 null。
		}
	}
	const diff = generateFinalDiff(oldContent, after ?? "", PATCH_DIFF_CONTEXT_LINES);
	return {
		kind: "Rewrite",
		path: addOp.path,
		changeStats: diff.stats,
		diffDisplay: diff.display,
		diffTruncated: diff.truncated,
	};
}

function fileDiffOf(
	operation: PatchOperation,
	diff: BuiltFileDiff | undefined,
): ApplyPatchFileDiff {
	const additions = operation.lines.filter((line) => line.prefix === "+").length;
	const deletions = operation.lines.filter((line) => line.prefix === "-").length;
	return {
		kind: operationKindWord(operation),
		path: operation.path,
		destination: operation.destination,
		changeStats: diff?.changeStats ?? { additions, deletions, changedLines: additions + deletions },
		diffDisplay: diff?.diffDisplay ?? displayDiffFromLines(operation.lines),
		diffTruncated: diff?.diffTruncated ?? false,
	};
}

async function buildSingleResultViewModel(
	patch: ParsedPatch,
	parsed: ParsedApplyPatchResult,
	before: BeforeSnapshots | undefined,
): Promise<ApplyPatchSingleResultViewModel | undefined> {
	if (parsed.success) {
		if (!successMatchesPatch(patch, parsed.changes)) return undefined;
		const files: ApplyPatchFileDiff[] = [];
		const used = new Set<number>();
		for (let i = 0; i < patch.operations.length; i++) {
			if (used.has(i)) continue;
			const operation = patch.operations[i]!;
			const partner = findRewritePartner(patch.operations, i);
			if (partner !== undefined) {
				used.add(i);
				used.add(partner);
				files.push(await buildRewriteFileDiff(before, operation, patch.operations[partner]!));
				continue;
			}
			files.push(fileDiffOf(operation, await buildFileDiff(before, operation)));
		}
		return { kind: "apply-patch-result", success: true, files, trailing: "" };
	}
	const failure = parsed.failure;
	if (!failureMatchesPatch(patch, failure)) return undefined;
	const applied: ApplyPatchFileDiff[] = [];
	const appliedDiffs = new Map<number, ApplyPatchFileDiff>();
	for (const change of failure.appliedPrefix) {
		const operation = operationByIndex(patch, change.index);
		if (!operation) return undefined;
		appliedDiffs.set(change.index, fileDiffOf(operation, await buildFileDiff(before, operation, change)));
	}
	const used = new Set<number>();
	for (const change of failure.appliedPrefix) {
		if (used.has(change.index)) continue;
		if (change.operation === "delete") {
			const partner = failure.appliedPrefix.find((candidate) =>
				candidate.index !== change.index && candidate.operation === "add" && candidate.path === change.path);
			if (partner !== undefined) {
				used.add(change.index);
				used.add(partner.index);
				const deleteOp = operationByIndex(patch, change.index)!;
				const addOp = operationByIndex(patch, partner.index)!;
				applied.push(await buildRewriteFileDiff(before, deleteOp, addOp));
				continue;
			}
		}
		applied.push(appliedDiffs.get(change.index)!);
	}
	const appliedIndexes = new Set(failure.appliedPrefix.map((change) => change.index));
	const skippedIndexes = new Set(failure.skipped.map((skip) => skip.index));
	const skipped: ApplyPatchSkipped[] = failure.skipped.map((skip) => ({
		operation: skip.operation,
		path: skip.path,
		message: skip.message,
	}));
	const unapplied: ApplyPatchUnapplied[] = patch.operations
		.filter((operation) => !appliedIndexes.has(operation.index) && !skippedIndexes.has(operation.index))
		.map((operation) => ({ kind: operationKindWord(operation), path: operation.path, destination: operation.destination }));
	const contextMismatch = buildContextMismatch(patch, failure, before);
	return {
		kind: "apply-patch-result",
		success: false,
		error: {
			code: failure.error.code,
			message: failure.error.message,
			path: failure.error.hunk?.path,
			chunkIndex: failure.error.hunk?.chunkIndex,
		},
		applied,
		skipped,
		contextMismatch,
		unapplied,
		trailing: "",
	};
}

function buildContextMismatch(
	patch: ParsedPatch,
	failure: ApplyPatchFailure,
	before: BeforeSnapshots | undefined,
): ApplyPatchContextMismatch | undefined {
	if (failure.error.code !== "CONTEXT_NOT_FOUND" || !failure.error.hunk?.path) return undefined;
	const hunk = failure.error.hunk;
	if (hunk.index === undefined || hunk.chunkIndex === undefined) return undefined;
	const path = hunk.path;
	if (path === undefined) return undefined;
	const operation = operationByIndex(patch, hunk.index);
	const chunk = operation?.chunks?.[hunk.chunkIndex];
	if (!chunk) return undefined;
	const expectedLines = chunk.lines.filter((line) => line.prefix !== "+").map((line) => line.text);
	const beforeContent = before?.get(path)?.before ?? null;
	if (beforeContent === null) return undefined;
	const actual = truncateHead(beforeContent, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return {
		expectedLines,
		actualLines: actual.content.split("\n"),
		actualTruncated: actual.truncated,
	};
}

type BatchGroup =
	| { kind: Exclude<ApplyPatchFileDiff["kind"], "Rewrite">; operation: PatchOperation; patchCount: number }
	| { kind: "Rewrite"; deleteOp: PatchOperation; addOp: PatchOperation; patchCount: number };

async function buildBatchFinalFiles(
	patches: ParsedPatch[],
	before: BeforeSnapshots | undefined,
): Promise<ApplyPatchBatchFileDiff[] | undefined> {
	if (!before) return undefined;
	const grouped = new Map<string, BatchGroup>();
	for (const patch of patches) {
		const used = new Set<number>();
		for (let i = 0; i < patch.operations.length; i++) {
			if (used.has(i)) continue;
			const operation = patch.operations[i]!;
			const partner = findRewritePartner(patch.operations, i);
			if (partner !== undefined) {
				used.add(i);
				used.add(partner);
				const key = JSON.stringify(["Rewrite", operation.path, undefined]);
				const current = grouped.get(key);
				if (current && current.kind === "Rewrite") current.patchCount += 1;
				else grouped.set(key, { kind: "Rewrite", deleteOp: operation, addOp: patch.operations[partner]!, patchCount: 1 });
				continue;
			}
			const key = JSON.stringify([operationKindWord(operation), operation.path, operation.destination]);
			const current = grouped.get(key);
			if (current && current.kind !== "Rewrite") current.patchCount += 1;
			else grouped.set(key, { kind: operationKindWord(operation), operation, patchCount: 1 });
		}
	}
	mergeCrossPatchRewrites(grouped);
	const files: ApplyPatchBatchFileDiff[] = [];
	for (const group of grouped.values()) {
		if (group.kind === "Rewrite") {
			const diff = await buildRewriteFileDiff(before, group.deleteOp, group.addOp);
			files.push({ ...diff, patchCount: group.patchCount });
			continue;
		}
		const diff = await buildFileDiff(before, group.operation);
		if (!diff) return undefined;
		files.push({ ...fileDiffOf(group.operation, diff), patchCount: group.patchCount });
	}
	return files;
}

function mergeCrossPatchRewrites(grouped: Map<string, BatchGroup>): void {
	for (const [deleteKey, group] of [...grouped.entries()]) {
		if (group.kind !== "Delete") continue;
		const addKey = JSON.stringify(["Add", group.operation.path, undefined]);
		const addGroup = grouped.get(addKey);
		if (!addGroup || addGroup.kind !== "Add") continue;
		grouped.set(deleteKey, {
			kind: "Rewrite",
			deleteOp: group.operation,
			addOp: addGroup.operation,
			patchCount: group.patchCount + addGroup.patchCount,
		});
		grouped.delete(addKey);
	}
}

/** Build one result per invocation; mixed patch outcomes remain independently addressable. */
export async function buildResultViewModel(
	patches: ParsedPatch[],
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	before: BeforeSnapshots | undefined,
): Promise<ApplyPatchResultViewModel | undefined> {
	const text = resultText(result);
	const parsed = parseApplyPatchResultSequence(text);
	if (!parsed || parsed.results.length !== patches.length) return undefined;
	const snapshot = patches.length === 1 ? before : undefined;
	const results: ApplyPatchSingleResultViewModel[] = [];
	for (const [index, patch] of patches.entries()) {
		const single = await buildSingleResultViewModel(patch, parsed.results[index]!, snapshot);
		if (!single) return undefined;
		results.push(single);
	}
	if (results.length === 1) return { ...results[0]!, trailing: parsed.trailing };
	const finalFiles = results.every((entry) => entry.success)
		? await buildBatchFinalFiles(patches, before)
		: undefined;
	return { kind: "apply-patch-batch-result", results, finalFiles, trailing: parsed.trailing };
}
