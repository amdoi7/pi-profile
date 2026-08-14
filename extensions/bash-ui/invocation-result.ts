import { normalizeLines, operationByIndex, type ParsedPatch, type PatchOperation } from "./recognize.ts";

/**
 * invocation-result.ts — 单 invocation 输出解析（执行者架构）。
 *
 * 每个 invocation 的 stdout 隔离捕获（不与其他输出混流），因此只需要识别
 * 两种 canonical 形状：success 文本块（marker 行 + 每行一条 `A|M|D path`）与
 * failure 文本块（error[CODE] + hunk/applied/skipped 行 + message 段殿后至 EOF）——
 * CLI 恒定文本输出契约（见 cli/apply-patch/README.md）。混流扫描（mightBeComplete /
 * containsResultBlockMarker / parseApplyPatchResultSequence）随观察者架构
 * 整体删除：这里没有“门卫”，输出就是块本身。
 */

export type AppliedChange = {
	index: number;
	operation: PatchOperation["kind"];
	path: string;
};

export type SkippedHunk = {
	index: number;
	operation?: PatchOperation["kind"];
	path?: string;
	chunkIndex?: number;
	message: string;
};

export type ApplyPatchFailure = {
	ok: false;
	error: {
		code: string;
		message: string;
		hunk?: {
			index: number;
			operation?: PatchOperation["kind"];
			path?: string;
			chunkIndex?: number;
		};
	};
	appliedPrefix: AppliedChange[];
	skipped: SkippedHunk[];
};

export type SuccessfulChange = {
	status: "A" | "M" | "D";
	path: string;
};

export type ParsedApplyPatchResult =
	| { success: true; changes: SuccessfulChange[]; text: string }
	| { success: false; failure: ApplyPatchFailure; text: string };

/** 执行者架构的 sequence：各 invocation 的 parsed 拼接（trailing 恒空——混流概念已死）。 */
export type ParsedApplyPatchResultSequence = {
	results: ParsedApplyPatchResult[];
	trailing: string;
};


const SUCCESS_MARKER = "Success. Updated the following files:";
const CHANGE_LINE = /^([AMD]) (.+)$/;
const ERROR_HEADER = /^error\[([A-Z_]+)\]$/;
const HUNK_INDEX = /^#(\d+)/;
const APPLIED_LINE = /^#(\d+) (add|delete|update) (.+)$/;
const SKIPPED_SEPARATOR = " — ";

/**
 * hunk 引用文本：`#<index>[ <operation>][ chunk <n>][ <path>]`（字段顺序固定，
 * path 恒为行尾可含空格）。operation 槽位的词法歧义（路径恰为 add/delete/update）
 * 按 operation 解析——encoder 恒在已知时输出 operation，误配只弱化 match guard，
 * 诚实降级不撒谎。
 */
type HunkReferenceText = {
	index: number;
	operation: PatchOperation["kind"] | undefined;
	path: string | undefined;
	chunkIndex: number | undefined;
};

function parseHunkReferenceText(text: string): HunkReferenceText | undefined {
	const indexMatch = HUNK_INDEX.exec(text);
	if (!indexMatch) return undefined;
	const reference: HunkReferenceText = { index: Number(indexMatch[1]), operation: undefined, path: undefined, chunkIndex: undefined };
	let rest = text.slice(indexMatch[0].length);
	if (rest === "") return reference;
	if (!rest.startsWith(" ")) return undefined;
	rest = rest.slice(1);
	for (const word of ["add", "delete", "update"] as const) {
		if (rest === word || rest.startsWith(`${word} `)) {
			reference.operation = word;
			rest = rest.slice(word.length);
			if (rest !== "") rest = rest.slice(1);
			break;
		}
	}
	if (rest.startsWith("chunk ")) {
		const after = rest.slice("chunk ".length);
		const spaceAt = after.indexOf(" ");
		const digits = spaceAt === -1 ? after : after.slice(0, spaceAt);
		if (!/^\d+$/.test(digits)) return undefined;
		reference.chunkIndex = Number(digits);
		rest = spaceAt === -1 ? "" : after.slice(spaceAt + 1);
	}
	if (rest !== "") reference.path = rest;
	return reference;
}

/** success 文本块：marker 行 + 每行一条 `A|M|D path`（marker 后全为 change 行）。 */
export function parseApplyPatchSuccess(text: string): SuccessfulChange[] | undefined {
	const lines = normalizeLines(text);
	const markerAt = lines.indexOf(SUCCESS_MARKER);
	if (markerAt === -1) return undefined;
	const changes: SuccessfulChange[] = [];
	for (const line of lines.slice(markerAt + 1)) {
		const match = CHANGE_LINE.exec(line);
		if (!match) return undefined;
		changes.push({ status: match[1] as SuccessfulChange["status"], path: match[2]! });
	}
	return changes;
}

/**
 * 单 invocation 输出解析：failure 文本块（error[CODE] 头）优先，否则 success 文本块。
 * 无法识别（输出为空 / 与 canonical 形状不符）返回 undefined。
 */
export function parseInvocationResult(text: string): ParsedApplyPatchResult | undefined {
	const failure = parseApplyPatchFailure(text);
	if (failure) return { success: false, failure, text };
	const success = parseApplyPatchSuccess(text);
	if (!success) return undefined;
	return { success: true, changes: success, text };
}

/**
 * failure 文本块：`error[<CODE>]` 头 + 至多一条 `hunk: ` + 若干 `applied: `/`skipped: `
 * + `message: ` 段（殿后至 EOF，可多行）。任何一行形状不符 → undefined。
 */
export function parseApplyPatchFailure(text: string): ApplyPatchFailure | undefined {
	const lines = normalizeLines(text);
	const headerAt = lines.findIndex((line) => ERROR_HEADER.test(line));
	if (headerAt === -1) return undefined;
	const code = ERROR_HEADER.exec(lines[headerAt]!)![1]!;
	let hunk: ApplyPatchFailure["error"]["hunk"];
	const appliedPrefix: AppliedChange[] = [];
	const skipped: SkippedHunk[] = [];
	for (let cursor = headerAt + 1; cursor < lines.length; cursor++) {
		const line = lines[cursor]!;
		if (line.startsWith("hunk: ")) {
			if (hunk !== undefined) return undefined;
			const reference = parseHunkReferenceText(line.slice("hunk: ".length));
			if (!reference) return undefined;
			hunk = reference;
			continue;
		}
		if (line.startsWith("applied: ")) {
			const match = APPLIED_LINE.exec(line.slice("applied: ".length));
			if (!match) return undefined;
			appliedPrefix.push({ index: Number(match[1]), operation: match[2] as AppliedChange["operation"], path: match[3]! });
			continue;
		}
		if (line.startsWith("skipped: ")) {
			const body = line.slice("skipped: ".length);
			const separatorAt = body.indexOf(SKIPPED_SEPARATOR);
			if (separatorAt === -1) return undefined;
			const reference = parseHunkReferenceText(body.slice(0, separatorAt));
			if (!reference) return undefined;
			skipped.push({ ...reference, message: body.slice(separatorAt + SKIPPED_SEPARATOR.length) });
			continue;
		}
		if (line.startsWith("message: ")) {
			const message = [line.slice("message: ".length), ...lines.slice(cursor + 1)].join("\n");
			return { ok: false, error: { code, message, hunk }, appliedPrefix, skipped };
		}
		return undefined;
	}
	return undefined;
}

function expectedSuccessfulChange(operation: PatchOperation): SuccessfulChange {
	return {
		status: operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M",
		path: operation.destination ?? operation.path,
	};
}

/**
 * CLI 按文件去重输出：一个文件的多 chunk 修改只打一行（如 `M module.ts`）。
 * 因此按 (status, path) 去重集合匹配，而不是按 operation 一一对应。
 */
export function successMatchesPatch(patch: ParsedPatch, changes: SuccessfulChange[]): boolean {
	const expected = new Set(patch.operations.map((operation) => {
		const change = expectedSuccessfulChange(operation);
		return `${change.status} ${change.path}`;
	}));
	if (expected.size !== changes.length) return false;
	for (const change of changes) {
		if (!expected.has(`${change.status} ${change.path}`)) return false;
	}
	return true;
}

function appliedChangeMatchesPatch(patch: ParsedPatch, change: AppliedChange): boolean {
	const operation = operationByIndex(patch, change.index);
	return operation !== undefined &&
		operation.kind === change.operation &&
		change.path === (operation.destination ?? operation.path);
}

export function failureMatchesPatch(patch: ParsedPatch, failure: ApplyPatchFailure): boolean {
	if (!failure.appliedPrefix.every((change) => appliedChangeMatchesPatch(patch, change))) return false;
	const hunk = failure.error.hunk;
	if (!hunk) return true;
	const operation = operationByIndex(patch, hunk.index);
	if (!operation) return false;
	if (hunk.operation !== undefined && hunk.operation !== operation.kind) return false;
	return hunk.path === undefined || hunk.path === operation.path;
}
