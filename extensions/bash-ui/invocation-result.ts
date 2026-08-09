import { isRecord, normalizeLines, operationByIndex, type ParsedPatch, type PatchOperation } from "./recognize.ts";

/**
 * invocation-result.ts — 单 invocation 输出解析（执行者架构）。
 *
 * 每个 invocation 的 stdout 隔离捕获（不与其他输出混流），因此只需要识别
 * 两种 canonical 形状：success 块（"Success. Updated the following files:" +
 * A/M/D 行）与 failure JSON 行。混流扫描（mightBeComplete /
 * containsResultBlockMarker / parseApplyPatchResultSequence）随观察者架构
 * 整体删除：这里没有"门卫"，输出就是块本身。
 */

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

/** 执行者架构的 sequence：各 invocation 的 parsed 拼接（trailing 恒空——混流概念已死）。 */
export type ParsedApplyPatchResultSequence = {
	results: ParsedApplyPatchResult[];
	trailing: string;
};


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

/**
 * 单 invocation 输出解析：failure JSON 行（trimStart 后 {）优先，否则 success 块。
 * 无法识别（输出为空 / 与 canonical 形状不符）返回 undefined。
 */
export function parseInvocationResult(text: string): ParsedApplyPatchResult | undefined {
	const failure = parseApplyPatchFailure(text);
	if (failure) return { success: false, failure, text };
	const lines = normalizeLines(text);
	if (lines[0] !== "Success. Updated the following files:") return undefined;
	let cursor = 1;
	while (cursor < lines.length && /^[AMD] .+$/.test(lines[cursor] ?? "")) cursor++;
	const changes = parseSuccessfulChanges(text);
	if (!changes) return undefined;
	return { success: true, changes, text: lines.slice(0, cursor).join("\n") };
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
