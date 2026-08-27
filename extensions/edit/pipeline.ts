/**
 * pipeline.ts —— edit 的适配层：参数契约 → 事务执行 → agent/UI payload。
 *
 * 契约核心：一个意图 = 一次调用 = 一个事务。`intent` 是这批修改存在的理由，
 * `files[]` 是这个意图触碰的全部文件；整批要么全部落盘，要么一个字节都不落
 * （engine 保证）。模型因此不需要在「多次单文件调用」之间自己维护一致性，
 * 也不会在半应用状态上重试。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import {
	executeBatchEdits,
	type FileEditOperation,
	type RecoverableEditErrorKind,
} from "./edit-engine.ts";
import { normalizeEditInput } from "./input-normalize.ts";
import { rememberEdited, wasEditedThisSession } from "./session-edits.ts";

const editOperationSchema = Type.Object(
	{
		// 两条规则都挂在这个字段上，因为它们都只管这个字段（语料 2026-08-27）：
		// 来源——475 个可复核失败锚里 89% 是重构而非复制；
		// 长度——54% 的锚超过 3 行，第 4 行之后的部分占全部 oldText 字节的 63%
		// （4.68M 字符 ≈ 1.34M token），不承担任何定位工作；且相邻性幻觉只发生在长锚上。
		oldText: Type.String({
			description: "Exact text currently in the file to replace. Copy it from tool output, not from memory,"
				+ " and keep it short — 1-3 lines is usually enough to be unique.",
		}),
		newText: Type.String({ description: "Replacement text. Use an empty string to delete oldText." }),
		replaceAll: Type.Optional(Type.Boolean({
			description: "Replace every occurrence of oldText instead of requiring a unique match.",
		})),
	},
	{ additionalProperties: false },
);

const fileEditsSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
		hint: Type.Optional(Type.String({
			description: "Short note on this file's role in the intent, e.g. 'compile site picks ctx by outlet'.",
		})),
		edits: Type.Array(editOperationSchema, {
			minItems: 1,
			description: "Targeted replacements for this file, each matched against the file's original content.",
		}),
	},
	{ additionalProperties: false },
);

// 一次调用 = 一个意图 = 一个事务：意图触碰的每个文件都进 files[]，
// 不拆成多次调用（多次调用之间没有事务边界，失败会留下半应用状态）。
const editRequestSchema = Type.Object(
	{
		intent: Type.String({
			description: "One line: the single change this batch delivers, e.g. 'split ToolCtx into PullCtx/ActCtx'.",
		}),
		files: Type.Array(fileEditsSchema, {
			minItems: 1,
			description: "Every file this intent touches; the whole batch applies atomically or not at all.",
		}),
	},
	{ additionalProperties: false },
);

export const editRequestParameters: ToolDefinition["parameters"] = editRequestSchema;

export type EditRequest = Static<typeof editRequestSchema>;
export type FileEditRequest = Static<typeof fileEditsSchema>;

/** 文件在本次事务中的结局；path 回报模型给的原始路径（展示与定位都用它）。 */
export type FileOutcome = { path: string; hint?: string } & (
	| {
			status: "applied";
			changeStats: ChangeStats;
			display: DisplayDiff;
			truncated: boolean;
			firstChangedLine?: number;
	  }
	/** editedEarlierThisSession：本 session 自己改过它，锚多半抄自改动之前。 */
	| {
			status: "failed";
			error: string;
			errorKind?: RecoverableEditErrorKind;
			editedEarlierThisSession?: true;
	  }
	/** 匹配无误但未落盘；restored=true 表示写过又被回滚。 */
	| { status: "notWritten"; restored: boolean }
);

export type BatchOutcome = {
	status: "applied" | "rejected" | "partial";
	intent: string;
	files: FileOutcome[];
};

export type CallToolViewModel = {
	kind: "call";
	intent: string;
	files: Array<{ path: string; hint?: string; editCount: number }>;
};

export type CallRenderViewModel =
	| { kind: "invalid"; message: string }
	| CallToolViewModel;

function resolveFilePath(filePath: string, cwd: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function canonicalizePath(filePath: string, cwd: string): string {
	const resolvedPath = resolveFilePath(filePath, cwd);
	try {
		return fs.realpathSync.native(resolvedPath);
	} catch {
		return path.normalize(resolvedPath);
	}
}

function invalidEditRequest(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 报错要带当前值：“must be a string” 不告诉模型它实际发了什么。 */
function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * edits 以文本到达 = normalize 已经试过 JSON.parse 并失败（或解出非数组）。
 * 重新 parse 一次取回那个被丢弃的原因：实测语料里这里几乎都是传输截断，
 * 而不是模型搞错形状——报错说错了原因，模型就会去改一个本来就对的东西。
 */
function textEditsFailure(rawEdits: string, filePath: string): never {
	try {
		JSON.parse(rawEdits);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		invalidEditRequest(
			`${filePath}.edits arrived as text that is not valid JSON (${reason}); the call was likely cut off mid-emit — re-send it.`,
		);
	}
	invalidEditRequest(`${filePath}.edits arrived as JSON text for a non-array value; it must be an array of edits`);
}

function parseEditOperations(rawEdits: unknown, filePath: string): FileEditOperation[] {
	if (typeof rawEdits === "string") textEditsFailure(rawEdits, filePath);
	if (rawEdits === undefined) {
		invalidEditRequest(`${filePath}.edits is missing: this file entry carries only a path — re-send the call with its edits.`);
	}
	if (!Array.isArray(rawEdits)) invalidEditRequest(`${filePath}.edits must be an array`);
	if (rawEdits.length === 0) invalidEditRequest(`${filePath}.edits must not be empty`);
	return rawEdits.map((entry, index) => {
		if (!isRecord(entry)) invalidEditRequest(`${filePath}.edits[${index}] must be an object`);
		for (const key of Object.keys(entry)) {
			if (key !== "oldText" && key !== "newText" && key !== "replaceAll") {
				invalidEditRequest(`${filePath}.edits[${index}].${key} must be removed`);
			}
		}
		if (typeof entry.oldText !== "string") {
			invalidEditRequest(`${filePath}.edits[${index}].oldText must be a string, got ${describeType(entry.oldText)}`);
		}
		if (typeof entry.newText !== "string") {
			invalidEditRequest(`${filePath}.edits[${index}].newText must be a string, got ${describeType(entry.newText)}`);
		}
		if (entry.replaceAll !== undefined && typeof entry.replaceAll !== "boolean") {
			invalidEditRequest(`${filePath}.edits[${index}].replaceAll must be boolean`);
		}
		return {
			oldText: entry.oldText,
			newText: entry.newText,
			...(entry.replaceAll !== undefined ? { replaceAll: entry.replaceAll } : {}),
		};
	});
}

/**
 * 手写校验（schema 只做 provider 参数契约）：错误消息带字段路径，模型可直接
 * 行动。unknown key 报 "must be removed"（normalize 不吞未知键）。
 */
export function parseEditRequest(input: unknown): EditRequest {
	const normalized = normalizeEditInput(input);
	if (!isRecord(normalized)) invalidEditRequest("intent must be a string");
	for (const key of Object.keys(normalized)) {
		if (key !== "intent" && key !== "files") invalidEditRequest(`${key} must be removed`);
	}
	if (typeof normalized.intent !== "string") invalidEditRequest("intent must be a string");
	// 换行/连续空白折叠：intent 是一行标签，折叠语义无歧义。
	const intent = normalized.intent.replace(/\s+/g, " ").trim();
	if (intent === "") invalidEditRequest("intent must not be empty");
	if (!Array.isArray(normalized.files)) invalidEditRequest("files must be an array");
	if (normalized.files.length === 0) invalidEditRequest("files must not be empty");

	const seenPaths = new Set<string>();
	const files = normalized.files.map((entry, index) => {
		if (!isRecord(entry)) invalidEditRequest(`files[${index}] must be an object`);
		for (const key of Object.keys(entry)) {
			if (key !== "path" && key !== "hint" && key !== "edits") {
				invalidEditRequest(`files[${index}].${key} must be removed`);
			}
		}
		if (typeof entry.path !== "string") {
			invalidEditRequest(`files[${index}].path must be a string, got ${describeType(entry.path)}`);
		}
		if (entry.hint !== undefined && typeof entry.hint !== "string") {
			invalidEditRequest(`files[${index}].hint must be a string`);
		}
		if (seenPaths.has(entry.path)) {
			invalidEditRequest(`files[${index}].path repeats ${entry.path}; merge its edits into one entry`);
		}
		seenPaths.add(entry.path);
		return {
			path: entry.path,
			...(entry.hint !== undefined ? { hint: entry.hint } : {}),
			edits: parseEditOperations(entry.edits, `files[${index}]`),
		};
	});

	return { intent, files };
}

export function buildCallToolViewModel(args: unknown): CallRenderViewModel {
	try {
		const request = parseEditRequest(args);
		return {
			kind: "call",
			intent: request.intent,
			files: request.files.map((file) => ({
				path: file.path,
				...(file.hint !== undefined ? { hint: file.hint } : {}),
				editCount: file.edits.length,
			})),
		};
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 执行整批：canonical path 去重后交给 engine 的事务。
 * 文件级失败进 outcome（软失败）；abort 与重复路径等硬失败上抛。
 */
export async function executeEditBatch(
	request: EditRequest,
	cwd: string,
	signal?: AbortSignal,
): Promise<BatchOutcome> {
	const canonicalPaths = request.files.map((file) => canonicalizePath(file.path, cwd));
	// 同一物理文件出现两次 → 事务会自锁，且第二份 edits 会针对已改内容匹配：
	// 结构上不可执行，响亮拒绝而不是猜测合并顺序。
	const firstIndexByPath = new Map<string, number>();
	canonicalPaths.forEach((canonicalPath, index) => {
		const first = firstIndexByPath.get(canonicalPath);
		if (first !== undefined) {
			invalidEditRequest(
				`files[${index}].path and files[${first}].path are the same file; merge their edits into one entry`,
			);
		}
		firstIndexByPath.set(canonicalPath, index);
	});

	const result = await executeBatchEdits(
		request.files.map((file, index) => ({
			absolutePath: canonicalPaths[index]!,
			edits: file.edits,
		})),
		signal,
	);

	return {
		status: result.status,
		intent: request.intent,
		files: result.files.map((fileResult, index) => {
			const source = request.files[index]!;
			const identity = { path: source.path, ...(source.hint !== undefined ? { hint: source.hint } : {}) };
			if (fileResult.status === "applied") {
				rememberEdited(canonicalPaths[index]!);
				return {
					...identity,
					status: "applied",
					changeStats: fileResult.preview.changeStats,
					display: fileResult.preview.previewDisplay,
					truncated: fileResult.preview.previewTruncated,
					...(fileResult.preview.previewStartLine !== undefined
						? { firstChangedLine: fileResult.preview.previewStartLine }
						: {}),
				};
			}
			if (fileResult.status === "failed") {
				return {
					...identity,
					status: "failed",
					error: fileResult.error,
					...(fileResult.errorKind !== undefined ? { errorKind: fileResult.errorKind } : {}),
					...(wasEditedThisSession(canonicalPaths[index]!) ? { editedEarlierThisSession: true as const } : {}),
				};
			}
			return { ...identity, status: "notWritten", restored: fileResult.restored };
		}),
	};
}

/**
 * agent 结果：只传事实。成功列每个文件的 stats/定位；失败列磁盘现状
 * （written = 仍被改动的文件，rejected 时为空数组）+ 每个失败点。
 */
export function buildOutcomeAgentContent(outcome: BatchOutcome): string {
	if (outcome.status === "applied") {
		return JSON.stringify({
			status: "applied",
			files: outcome.files.map((file) => {
				if (file.status !== "applied") throw new Error("unreachable: applied batch with unapplied file");
				return {
					path: file.path,
					changes: file.changeStats,
					...(file.firstChangedLine !== undefined ? { firstChangedLine: file.firstChangedLine } : {}),
				};
			}),
		});
	}

	return JSON.stringify({
		status: outcome.status,
		written: outcome.files.filter((file) => file.status === "applied").map((file) => file.path),
		failed: outcome.files
			.filter((file): file is Extract<FileOutcome, { status: "failed" }> => file.status === "failed")
			.map((file) => ({
				path: file.path,
				...(file.errorKind !== undefined ? { kind: file.errorKind } : {}),
				...(file.editedEarlierThisSession === true ? { editedEarlierThisSession: true } : {}),
				message: file.error,
			})),
	});
}

/** UI details：renderResult 从这里重建整批展示（execute 的唯一 UI 出口）。 */
export type BatchUiDetails = {
	status: BatchOutcome["status"];
	intent: string;
	cwd: string;
	files: FileOutcome[];
};

export function buildOutcomeUiDetails(outcome: BatchOutcome, cwd: string): BatchUiDetails {
	return { status: outcome.status, intent: outcome.intent, cwd, files: outcome.files };
}
