import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ParsedPatch, PatchOperation } from "./patch-command.ts";

export type AppliedChange = {
	index: number;
	operation: PatchOperation["kind"];
	path: string;
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
};

export type SuccessfulChange = {
	status: "A" | "M" | "D";
	path: string;
};

function normalizeLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
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

function parseAppliedChange(value: unknown): AppliedChange | undefined {
	if (!isRecord(value)) return undefined;
	if (!Number.isInteger(value.index) || !["add", "delete", "update"].includes(String(value.operation))) return undefined;
	if (typeof value.path !== "string") return undefined;
	return { index: value.index as number, operation: value.operation as AppliedChange["operation"], path: value.path };
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
	return {
		ok: false,
		exitCode: value.exitCode as number,
		error: { code: value.error.code, message: value.error.message, hunk },
		appliedPrefix: appliedPrefix as AppliedChange[],
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
	const operation = patch.operations[change.index];
	return operation !== undefined &&
		operation.kind === change.operation &&
		change.path === (operation.destination ?? operation.path);
}

export function failureMatchesPatch(patch: ParsedPatch, failure: ApplyPatchFailure): boolean {
	if (!failure.appliedPrefix.every((change) => appliedChangeMatchesPatch(patch, change))) return false;
	const hunk = failure.error.hunk;
	if (!hunk) return true;
	const operation = patch.operations[hunk.index];
	if (!operation) return false;
	if (hunk.operation !== undefined && hunk.operation !== operation.kind) return false;
	return hunk.path === undefined || hunk.path === operation.path;
}
