/**
 * pipeline.ts —— edit 的输入契约与适配层：容错归一 → 校验 → 合并 → 事务执行
 * → agent/UI payload。输入形状的全部 owner 在这一个文件。
 *
 * 契约核心：一个意图 = 一次调用 = 一个事务。`intent` 是这批修改存在的理由，
 * `files[]` 是这个意图触碰的全部文件；整批要么全部落盘，要么一个字节都不落
 * （transaction 保证）。模型因此不需要在「多次单文件调用」之间自己维护一致性，
 * 也不会在半应用状态上重试。
 *
 * 容错归一只接受语义无歧义的形状（JSON 字符串退化、内置单文件形状、flat 形状）；
 * `intent` 从不代为编造，其余形状原样留给校验响亮拒绝。
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
} from "./transaction.ts";

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
			description: "Targeted replacements for this file, each matched against the file's original content.\n"
				+ "This is the only entry allowed for this path: a later entry with the same path is merged into this one,\n"
				+ "keeping the first path/hint spelling.",
		}),
	},
	{ additionalProperties: false },
);

// 一次调用 = 一个意图 = 一个事务：意图触碰的每个文件都进 files[]，
// 不拆成多次调用（多次调用之间没有事务边界，失败会留下半应用状态）。
const editRequestSchema = Type.Object(
	{
		intent: Type.String({
			description: "The intent for this batch of edits.",
		}),
		files: Type.Array(fileEditsSchema, {
			minItems: 1,
			description: "Every file this intent touches; the whole batch applies atomically or not at all.\n"
				+ "One entry per file: a repeated path is merged into the first entry — different files must not alias to"
				+ " the same physical file (symlink/./ prefix), that is rejected.",
		}),
	},
	{ additionalProperties: false },
);

export const editRequestParameters: ToolDefinition["parameters"] = editRequestSchema;

export type EditRequest = Static<typeof editRequestSchema>;

/** 文件在本次事务中的结局；path 回报模型给的原始路径（展示与定位都用它）。 */
export type FileOutcome = { path: string; hint?: string } & (
	| {
			status: "applied";
			changeStats: ChangeStats;
			display: DisplayDiff;
			truncated: boolean;
			firstChangedLine?: number;
	  }
	| { status: "failed"; error: string; errorKind?: RecoverableEditErrorKind }
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

function canonicalizePath(filePath: string, cwd: string): string {
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

/**
 * 同一 path 的字面重复是模型的包装错误：合并进首次出现的条目，而不是打回
 * 重发——每个条目自己的 edits[] 都被完整保留，合并语义无歧义。合并保留首个
 * path/hint 写法；别名（./a.ts vs a.ts、symlink）不在字符串层判定，由
 * executeEditBatch 在 canonicalize 之后响亮拒绝（合并会隐式选定一个写法
 * 并丢弃另一个的意图，模型知道 path 才能修对）。
 */
function mergeDuplicatePathEntries(
	files: Array<{ path: string; hint?: string; edits: FileEditOperation[] }>,
): Array<{ path: string; hint?: string; edits: FileEditOperation[] }> {
	const merged: Array<{ path: string; hint?: string; edits: FileEditOperation[] }> = [];
	const firstIndexByPath = new Map<string, number>();
	for (const file of files) {
		const firstIndex = firstIndexByPath.get(file.path);
		if (firstIndex === undefined) {
			firstIndexByPath.set(file.path, merged.length);
			merged.push(file);
			continue;
		}
		const first = merged[firstIndex]!;
		first.edits = [...first.edits, ...file.edits];
		if (first.hint === undefined && file.hint !== undefined) first.hint = file.hint;
	}
	return merged;
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

function parseJsonArray(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : value;
	} catch {
		// fall through to the validation error for a non-array value
		return value;
	}
}

/**
 * 单文件形状（内置 edit / 旧契约）→ files[0]；flat oldText/newText 同理。
 *
 * 抬升只看形状不看值是否合法：edits 是一段坏文本时也要抬，否则它会留在顶层
 * 被当成未知键，报出「path must be removed」——把模型指向删掉唯一正确的字段。
 */
function liftSingleFileShape(request: Record<string, unknown>): void {
	if (typeof request.path !== "string") return;

	const hasFlatReplacement = typeof request.oldText === "string" && typeof request.newText === "string";
	if (typeof request.edits === "string") {
		if (request.files !== undefined) return;
		request.files = [{ path: request.path, edits: request.edits }];
		delete request.path;
		delete request.edits;
		return;
	}

	const edits = Array.isArray(request.edits) ? request.edits : [];
	if (hasFlatReplacement) {
		edits.push({
			oldText: request.oldText,
			newText: request.newText,
			...(typeof request.replaceAll === "boolean" ? { replaceAll: request.replaceAll } : {}),
		});
	}
	if (edits.length === 0) return;

	const file: Record<string, unknown> = { path: request.path, edits };
	if (typeof request.hint === "string") file.hint = request.hint;
	request.files = [file, ...(Array.isArray(request.files) ? request.files : [])];
	delete request.path;
	delete request.edits;
	delete request.oldText;
	delete request.newText;
	delete request.replaceAll;
	delete request.hint;
}

export function normalizeEditInput(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}
	const request = { ...input };

	request.files = parseJsonArray(request.files);
	request.edits = parseJsonArray(request.edits);
	if (request.files === undefined) delete request.files;
	if (request.edits === undefined) delete request.edits;

	liftSingleFileShape(request);

	if (Array.isArray(request.files)) {
		request.files = request.files.map((entry) =>
			isRecord(entry) && entry.edits !== undefined
				? { ...entry, edits: parseJsonArray(entry.edits) }
				: entry
		);
	}
	return request;
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
		return {
			path: entry.path,
			...(entry.hint !== undefined ? { hint: entry.hint } : {}),
			edits: parseEditOperations(entry.edits, `files[${index}]`),
		};
	});
	const mergedFiles = mergeDuplicatePathEntries(files);

	return { intent, files: mergedFiles };
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
 * 执行整批：canonical path 去重后交给 transaction 的事务。
 * 文件级失败进 outcome（软失败）；abort 与别名路径等硬失败上抛。
 */
export async function executeEditBatch(
	request: EditRequest,
	cwd: string,
	signal?: AbortSignal,
): Promise<BatchOutcome> {
	const canonicalPaths = request.files.map((file) => canonicalizePath(file.path, cwd));
	// 字面重复已在 parseEditRequest 合并；这里挡住 canonical 别名（./a.ts、
	// symlink、大小写不敏感盘上的变体），带两个下标响亮拒绝。在读盘前拒绝：
	// 此时合并会隐式选定一个 path/hint 写法并丢弃另一个的意图，语义不无歧义。
	const firstIndexByPath = new Map<string, number>();
	canonicalPaths.forEach((canonicalPath, index) => {
		const first = firstIndexByPath.get(canonicalPath);
		if (first !== undefined) {
			invalidEditRequest(
				`files[${index}].path is an alias of files[${first}].path (${canonicalPath}); merge their edits into one entry`,
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
