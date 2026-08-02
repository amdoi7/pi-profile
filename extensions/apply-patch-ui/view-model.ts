import { readFile } from "node:fs/promises";

import type { ChangeStats } from "../_shared/final-diff.ts";
import { generateFinalDiff } from "../_shared/final-diff.ts";
import { analyzeAstScopes, type AstScope, type AstScopeAnalysis } from "./ast-scope.ts";
import type { ParsedPatch, PatchOperation } from "./patch-command.ts";
import {
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
	kind: "Add" | "Update" | "Move" | "Delete";
	path: string;
	destination?: string;
	changeStats: ChangeStats;
	diffText: string;
	diffTruncated: boolean;
	astScopes?: AstScope[];
	astDiagnostic?: string;
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
		unapplied: ApplyPatchUnapplied[];
		trailing: string;
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

function isChangeStats(value: unknown): value is ChangeStats {
	return isRecord(value) &&
		typeof value.additions === "number" &&
		typeof value.deletions === "number" &&
		typeof value.changedLines === "number";
}

function isFileDiff(value: unknown): value is ApplyPatchFileDiff {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		isChangeStats(value.changeStats) &&
		typeof value.diffText === "string" &&
		typeof value.diffTruncated === "boolean" &&
		(value.astScopes === undefined || (Array.isArray(value.astScopes) && value.astScopes.every(isAstScope))) &&
		(value.astDiagnostic === undefined || typeof value.astDiagnostic === "string");
}

function isAstScope(value: unknown): value is AstScope {
	return isRecord(value) &&
		typeof value.startLine === "number" &&
		typeof value.endLine === "number" &&
		typeof value.label === "string";
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
		!Array.isArray(details.unapplied) ||
		!details.unapplied.every(isUnapplied) ||
		typeof details.trailing !== "string"
	) return undefined;
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

export function operationKindWord(operation: PatchOperation): ApplyPatchFileDiff["kind"] {
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
	"changeStats" | "diffText" | "diffTruncated" | "astScopes" | "astDiagnostic"
>;

async function buildFileDiff(
	before: BeforeSnapshots | undefined,
	operation: PatchOperation,
): Promise<BuiltFileDiff | undefined> {
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
	if (diff.text.length === 0) return undefined;
	const ast: AstScopeAnalysis = after === null
		? { scopes: [] }
		: await analyzeAstScopes(afterPath, after, changedNewLines(diff.text));
	return {
		changeStats: diff.stats,
		diffText: diff.text,
		diffTruncated: diff.truncated,
		astScopes: ast.scopes,
		astDiagnostic: ast.diagnostic,
	};
}

function changedNewLines(diffText: string): number[] {
	return diffText.split("\n").flatMap((line) => {
		if (!line.startsWith("+")) return [];
		const matched = line.match(/^\+\s*(\d+)\s/);
		return matched ? [Number(matched[1])] : [];
	});
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
		diffText: diff?.diffText ?? operation.lines.map((line) => `${line.prefix}${line.text}`).join("\n"),
		diffTruncated: diff?.diffTruncated ?? false,
		astScopes: diff?.astScopes,
		astDiagnostic: diff?.astDiagnostic,
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
		for (const change of parsed.changes) {
			const operation = patch.operations.find((candidate) => changeMatchesOperation(change, candidate));
			if (!operation) return undefined;
			files.push(fileDiffOf(operation, await buildFileDiff(before, operation)));
		}
		return { kind: "apply-patch-result", success: true, files, trailing: "" };
	}
	const failure = parsed.failure;
	if (!failureMatchesPatch(patch, failure)) return undefined;
	const applied: ApplyPatchFileDiff[] = [];
	for (const change of failure.appliedPrefix) {
		const operation = patch.operations[change.index];
		if (!operation) return undefined;
		applied.push(fileDiffOf(operation, await buildFileDiff(before, operation)));
	}
	const appliedIndexes = new Set(failure.appliedPrefix.map((change) => change.index));
	const unapplied: ApplyPatchUnapplied[] = patch.operations
		.filter((operation) => !appliedIndexes.has(operation.index))
		.map((operation) => ({ kind: operationKindWord(operation), path: operation.path, destination: operation.destination }));
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
		unapplied,
		trailing: "",
	};
}

async function buildBatchFinalFiles(
	patches: ParsedPatch[],
	before: BeforeSnapshots | undefined,
): Promise<ApplyPatchBatchFileDiff[] | undefined> {
	if (!before) return undefined;
	const grouped = new Map<string, { operation: PatchOperation; patchCount: number }>();
	for (const patch of patches) {
		for (const operation of patch.operations) {
			const key = JSON.stringify([operationKindWord(operation), operation.path, operation.destination]);
			const current = grouped.get(key);
			if (current) current.patchCount += 1;
			else grouped.set(key, { operation, patchCount: 1 });
		}
	}
	const files: ApplyPatchBatchFileDiff[] = [];
	for (const { operation, patchCount } of grouped.values()) {
		const diff = await buildFileDiff(before, operation);
		if (!diff) return undefined;
		files.push({ ...fileDiffOf(operation, diff), patchCount });
	}
	return files;
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
