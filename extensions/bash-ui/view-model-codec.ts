import type { PatchOperation } from "./recognize.ts";
import { isRecord } from "./recognize.ts";
import { isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";
import type { FileMutationKind, FileMutationResult } from "../_shared/file-result.ts";
import type { SuccessfulChange } from "./invocation-result.ts";

/**
 * view-model-codec.ts — apply_patch view model 的类型与校验（P4 渲染层唯一可 import 的模块）。
 *
 * 相位纪律从注释变成 import graph：ui.ts / bash-renderer.ts 只 import 本模块与
 * recognize / patch-snapshot 的类型；构建侧（view-model-build.ts）才 import
 * diff-service 与快照。渲染路径零解析、零 IO、零 diff——本模块只有形状校验。
 *
 * 文件结果统一为 _shared 的 FileMutationResult（apply_patch 构建时 label="apply_patch"，
 * in-place edit 用真实工具名）；batch 聚合额外携带 isIntent。
 */

/** apply_patch 的单文件结果：FileMutationResult（kind 由构建方保证必填）。 */
export type ApplyPatchFileDiff = FileMutationResult;

export type ApplyPatchBatchFileDiff = FileMutationResult & {
	/** 聚合 diff 为 intent（无快照，unlocated 行）时 true；渲染层据此决定 expanded 是否展开各 invocation。 */
	isIntent?: boolean;
};

export type ApplyPatchUnapplied = {
	kind: FileMutationKind;
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

/** in-place edit（perl -pi）结果：FileMutationResult，label 归因真实工具（perl edit / sed edit）。 */
export type InPlaceEditFileDiff = FileMutationResult;

export type InPlaceEditResultViewModel = {
	kind: "in-place-edit-result";
	files: InPlaceEditFileDiff[];
	/** 整条命令的原生输出（verbatim 执行，无重建拼接）。 */
	output: string;
};

/** 渲染层消费的 view model 联合：一个 result 只属其一。 */
export type BashResultViewModel = ApplyPatchResultViewModel | InPlaceEditResultViewModel;

function isFileDiff(value: unknown): value is ApplyPatchFileDiff {
	return isRecord(value) &&
		typeof value.label === "string" &&
		["Add", "Update", "Move", "Delete", "Rewrite"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		typeof value.cwd === "string" &&
		isChangeStats(value.changeStats) &&
		isDisplayDiff(value.display) &&
		typeof value.truncated === "boolean";
}

function isBatchFileDiff(value: unknown): value is ApplyPatchBatchFileDiff {
	if (!isRecord(value)) return false;
	const isIntent = value.isIntent;
	return isFileDiff(value) &&
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

function isInPlaceEditFileDiff(value: unknown): value is InPlaceEditFileDiff {
	return isFileDiff(value);
}

/** in-place edit 结果 payload 校验（渲染层唯一入口之一）。 */
export function parseInPlaceEditResultPayload(details: unknown): InPlaceEditResultViewModel | undefined {
	if (
		!isRecord(details) ||
		details.kind !== "in-place-edit-result" ||
		!Array.isArray(details.files) ||
		!details.files.every(isInPlaceEditFileDiff) ||
		typeof details.output !== "string"
	) {
		return undefined;
	}
	return { kind: "in-place-edit-result", files: details.files, output: details.output };
}

export function operationKindWord(operation: Pick<PatchOperation, "kind" | "destination">): Exclude<FileMutationKind, "Rewrite"> {
	if (operation.kind === "add") return "Add";
	if (operation.kind === "delete") return "Delete";
	return operation.destination ? "Move" : "Update";
}

export function changeMatchesOperation(change: SuccessfulChange, operation: Pick<PatchOperation, "kind" | "path" | "destination">): boolean {
	const status = operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M";
	return status === change.status && (operation.destination ?? operation.path) === change.path;
}
