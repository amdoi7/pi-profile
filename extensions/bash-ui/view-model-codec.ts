import type { PatchOperation } from "./recognize.ts";
import { isRecord } from "./recognize.ts";
import { isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import type { SuccessfulChange } from "./invocation-result.ts";

/**
 * view-model-codec.ts — apply_patch view model 的类型与校验（P4 渲染层唯一可 import 的模块）。
 *
 * 相位纪律从注释变成 import graph：ui.ts / bash-renderer.ts 只 import 本模块与
 * recognize / patch-snapshot 的类型；构建侧（view-model-build.ts）才 import
 * diff-service 与快照。渲染路径零解析、零 IO、零 diff——本模块只有形状校验。
 */

export type ApplyPatchFileDiff = {
	kind: "Add" | "Update" | "Move" | "Delete" | "Rewrite";
	/** 展示用原始 relative path（UI 文字）。 */
	path: string;
	destination?: string;
	/** 所属 invocation 的 cwd：renderer 不再猜路径基础目录。 */
	cwd: string;
	changeStats: ChangeStats;
	diffDisplay: DisplayDiff;
	diffTruncated: boolean;
};

export type ApplyPatchBatchFileDiff = ApplyPatchFileDiff & {
	patchCount: number;
	/** 聚合 diff 为 intent（无快照，unlocated 行）时 true；渲染层据此决定 expanded 是否展开各 invocation。 */
	isIntent?: boolean;
};

export type ApplyPatchUnapplied = {
	kind: ApplyPatchFileDiff["kind"];
	path: string;
	destination?: string;
	cwd: string;
};

export type ApplyPatchSkipped = {
	operation?: string;
	path?: string;
	cwd?: string;
	message: string;
};

export type ApplyPatchContextMismatch = {
	expectedLines: string[];
	actualLines: string[];
	actualTruncated: boolean;
};

export type ApplyPatchSingleResultViewModel =
	| {
		kind: "apply-patch-result";
		success: true;
		files: ApplyPatchFileDiff[];
		trailing: string;
		/** 计划中 trailing command（渲染 `$ <cmd>` 头用；standalone patch 无 trailing 时缺省）。 */
		trailingCommand?: string;
	}
	| {
		kind: "apply-patch-result";
		success: false;
		error: {
			code: string;
			message: string;
			path?: string;
			cwd?: string;
			chunkIndex?: number;
		};
		applied: ApplyPatchFileDiff[];
		skipped: ApplyPatchSkipped[];
		contextMismatch?: ApplyPatchContextMismatch;
		unapplied: ApplyPatchUnapplied[];
		trailing: string;
		trailingCommand?: string;
	};

export type ApplyPatchResultViewModel =
	| ApplyPatchSingleResultViewModel
	| {
		kind: "apply-patch-batch-result";
		results: ApplyPatchSingleResultViewModel[];
		finalFiles?: ApplyPatchBatchFileDiff[];
		trailing: string;
		trailingCommand?: string;
	};

function isFileDiff(value: unknown): value is ApplyPatchFileDiff {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete", "Rewrite"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		typeof value.cwd === "string" &&
		isChangeStats(value.changeStats) &&
		isDisplayDiff(value.diffDisplay) &&
		typeof value.diffTruncated === "boolean";
}

function isBatchFileDiff(value: unknown): value is ApplyPatchBatchFileDiff {
	if (!isRecord(value)) return false;
	const patchCount = value.patchCount;
	const isIntent = value.isIntent;
	return isFileDiff(value) &&
		typeof patchCount === "number" &&
		Number.isInteger(patchCount) &&
		patchCount > 0 &&
		(isIntent === undefined || typeof isIntent === "boolean");
}

function isUnapplied(value: unknown): value is ApplyPatchUnapplied {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		typeof value.cwd === "string";
}

function isSkipped(value: unknown): value is ApplyPatchSkipped {
	return isRecord(value) &&
		(value.operation === undefined || typeof value.operation === "string") &&
		(value.path === undefined || typeof value.path === "string") &&
		(value.cwd === undefined || typeof value.cwd === "string") &&
		typeof value.message === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
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
	if (!isOptionalString(details.trailingCommand)) return undefined;
	if (details.success === true) {
		if (!Array.isArray(details.files) || !details.files.every(isFileDiff) || typeof details.trailing !== "string") return undefined;
		return {
			kind: "apply-patch-result",
			success: true,
			files: details.files,
			trailing: details.trailing,
			trailingCommand: details.trailingCommand,
		};
	}
	if (
		!isRecord(details.error) ||
		typeof details.error.code !== "string" ||
		typeof details.error.message !== "string" ||
		!isOptionalString(details.error.cwd) ||
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
			cwd: typeof details.error.cwd === "string" ? details.error.cwd : undefined,
			chunkIndex: typeof details.error.chunkIndex === "number" ? details.error.chunkIndex : undefined,
		},
		applied: details.applied,
		skipped: details.skipped,
		contextMismatch,
		unapplied: details.unapplied,
		trailing: details.trailing,
		trailingCommand: details.trailingCommand,
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
		typeof details.trailing !== "string" ||
		!isOptionalString(details.trailingCommand)
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
			trailingCommand: details.trailingCommand,
		};
}

export function operationKindWord(operation: Pick<PatchOperation, "kind" | "destination">): Exclude<ApplyPatchFileDiff["kind"], "Rewrite"> {
	if (operation.kind === "add") return "Add";
	if (operation.kind === "delete") return "Delete";
	return operation.destination ? "Move" : "Update";
}

export function changeMatchesOperation(change: SuccessfulChange, operation: Pick<PatchOperation, "kind" | "path" | "destination">): boolean {
	const status = operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M";
	return status === change.status && (operation.destination ?? operation.path) === change.path;
}
