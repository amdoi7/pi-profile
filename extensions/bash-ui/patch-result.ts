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
