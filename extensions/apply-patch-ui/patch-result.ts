import { operationByIndex, type ParsedPatch, type PatchOperation } from "./patch-command.ts";

export type AppliedChange = {
	index: number;
	operation: PatchOperation["kind"];
	path: string;
	oldContent?: string;
	newContent?: string;
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
	exitCode: number;
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

export type ParsedApplyPatchResultSequence = {
	results: ParsedApplyPatchResult[];
	trailing: string;
};

function normalizeLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

export function parseElapsedSeconds(text: string): number | undefined {
	const match = text.match(/Elapsed\s+([\d.]+)\s*s/);
	if (!match) return undefined;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) ? seconds : undefined;
}

// 结果之后的后续命令输出（如 apply_patch 后的 uv run pytest），供 trailing 渲染。
// 成功：文件列表之后的全部内容（排除 CLI 的 Elapsed 行，耗时由独立行表达）。
// 失败：JSON 行之后的全部内容。
const ELAPSED_LINE = /^Elapsed\s+[\d.]+\s*s$/;

export function trailingAfterSuccess(text: string): string {
	const lines = normalizeLines(text);
	const headerIndex = lines.findIndex((line) => line === "Success. Updated the following files:");
	if (headerIndex === -1) return "";
	let cursor = headerIndex + 1;
	while (cursor < lines.length && /^[AMD] .+$/.test(lines[cursor] ?? "")) cursor += 1;
	return lines.slice(cursor).filter((line) => !ELAPSED_LINE.test(line)).join("\n");
}

export function trailingAfterFailure(text: string): string {
	const lines = normalizeLines(text);
	const jsonIndex = lines.findIndex((line) => line.trim().startsWith("{"));
	if (jsonIndex === -1) return "";
	return lines.slice(jsonIndex + 1).join("\n");
}

export function parseSuccessfulChanges(text: string): SuccessfulChange[] | undefined {
	const lines = normalizeLines(text);
	const changes: SuccessfulChange[] = [];
	let inHeader = false;
	for (const line of lines) {
		if (line === "Success. Updated the following files:") {
			inHeader = true;
			continue;
		}
		if (!inHeader) continue;
		const match = line.match(/^([AMD]) (.+)$/);
		if (!match) {
			inHeader = false;
			continue;
		}
		changes.push({ status: match[1] as SuccessfulChange["status"], path: match[2] });
	}
	return changes.length > 0 ? changes : undefined;
}

/** Parse consecutive apply_patch invocations at the start of one shell result. */
export function parseApplyPatchResultSequence(text: string): ParsedApplyPatchResultSequence | undefined {
	const lines = normalizeLines(text);
	const results: ParsedApplyPatchResult[] = [];
	let cursor = 0;
	while (cursor < lines.length) {
		const failure = parseApplyPatchFailure(lines[cursor] ?? "");
		if (failure) {
			results.push({ success: false, failure, text: lines[cursor] ?? "" });
			cursor += 1;
			continue;
		}
		if (lines[cursor] !== "Success. Updated the following files:") break;
		const start = cursor;
		cursor += 1;
		while (cursor < lines.length && /^[AMD] .+$/.test(lines[cursor] ?? "")) cursor += 1;
		const resultBlock = lines.slice(start, cursor).join("\n");
		const changes = parseSuccessfulChanges(resultBlock);
		if (!changes) return undefined;
		results.push({ success: true, changes, text: resultBlock });
	}
	return results.length > 0 ? { results, trailing: lines.slice(cursor).join("\n") } : undefined;
}

function parseAppliedChange(value: unknown): AppliedChange | undefined {
	if (!isRecord(value)) return undefined;
	if (!Number.isInteger(value.index) || !["add", "delete", "update"].includes(String(value.operation))) return undefined;
	if (typeof value.path !== "string") return undefined;
	if (value.oldContent !== undefined && typeof value.oldContent !== "string") return undefined;
	if (value.newContent !== undefined && typeof value.newContent !== "string") return undefined;
	return {
		index: value.index as number,
		operation: value.operation as AppliedChange["operation"],
		path: value.path,
		oldContent: typeof value.oldContent === "string" ? value.oldContent : undefined,
		newContent: typeof value.newContent === "string" ? value.newContent : undefined,
	};
}

function parseFailureHunk(value: unknown): ApplyPatchFailure["error"]["hunk"] | undefined {
	if (!isRecord(value) || !Number.isInteger(value.index)) return undefined;
	if (value.operation !== undefined && !["add", "delete", "update"].includes(String(value.operation))) return undefined;
	if (value.path !== undefined && typeof value.path !== "string") return undefined;
	if (value.chunkIndex !== undefined && !Number.isInteger(value.chunkIndex)) return undefined;
	return {
		index: value.index as number,
		operation: value.operation as PatchOperation["kind"] | undefined,
		path: value.path as string | undefined,
		chunkIndex: value.chunkIndex as number | undefined,
	};
}

function parseSkippedHunk(value: unknown): SkippedHunk | undefined {
	if (!isRecord(value) || typeof value.message !== "string") return undefined;
	const hunk = parseFailureHunk(value.hunk);
	if (!hunk) return undefined;
	return {
		...hunk,
		message: value.message,
	};
}

export function parseApplyPatchFailure(text: string): ApplyPatchFailure | undefined {
	const jsonLine = normalizeLines(text).find((line) => line.trim().startsWith("{"));
	if (!jsonLine) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(jsonLine);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.ok !== false || !Number.isInteger(value.exitCode)) return undefined;
	if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") return undefined;
	if (!Array.isArray(value.appliedPrefix)) return undefined;
	const hunk = value.error.hunk === undefined ? undefined : parseFailureHunk(value.error.hunk);
	if (value.error.hunk !== undefined && !hunk) return undefined;
	const appliedPrefix = value.appliedPrefix.map(parseAppliedChange);
	if (appliedPrefix.some((change) => change === undefined)) return undefined;
	const skipped = value.skipped === undefined
		? []
		: (Array.isArray(value.skipped) ? value.skipped.map(parseSkippedHunk) : undefined);
	if (skipped === undefined || skipped.some((skip) => skip === undefined)) return undefined;
	return {
		ok: false,
		exitCode: value.exitCode as number,
		error: { code: value.error.code, message: value.error.message, hunk },
		appliedPrefix: appliedPrefix as AppliedChange[],
		skipped: skipped as SkippedHunk[],
	};
}

function expectedSuccessfulChange(operation: PatchOperation): SuccessfulChange {
	return {
		status: operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M",
		path: operation.destination ?? operation.path,
	};
}

export function successMatchesPatch(patch: ParsedPatch, changes: SuccessfulChange[]): boolean {
	const expected = patch.operations.map(expectedSuccessfulChange);
	if (expected.length !== changes.length) return false;
	const remaining = [...expected];
	for (const change of changes) {
		const index = remaining.findIndex(
			(c) => c.status === change.status && c.path === change.path,
		);
		if (index === -1) return false;
		remaining.splice(index, 1);
	}
	return remaining.length === 0;
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
