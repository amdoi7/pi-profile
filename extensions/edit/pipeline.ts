import * as fs from "node:fs";
import * as path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import {
	executeFileEdits,
	isEditToolError,
	type FileEditOperation,
	type RecoverableEditErrorKind,
} from "./edit-engine.ts";
import { normalizeEditInput } from "./input-normalize.ts";

const editOperationSchema = Type.Object(
	{
		oldText: Type.String({ description: "Exact text currently in the file to replace." }),
		newText: Type.String({ description: "Replacement text. Use an empty string to delete oldText." }),
		replaceAll: Type.Optional(Type.Boolean({
			description: "Replace every occurrence of oldText instead of requiring a unique match.",
		})),
	},
	{ additionalProperties: false },
);

// One file per call ({ path, edits }), matching pi's built-in edit tool so
// models never have to learn a second shape. Multi-file edits are done with
// one call per file; pi executes them in parallel.
const editRequestSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
		edits: Type.Array(editOperationSchema, {
			minItems: 1,
			description: "One or more targeted replacements, each matched against the original file.",
		}),
	},
	{ additionalProperties: false },
);

export const editRequestParameters: ToolDefinition["parameters"] = editRequestSchema;

export type EditRequest = Static<typeof editRequestSchema>;

export type EditOutcome =
	| {
			status: "applied";
			path: string;
			previewDisplay: DisplayDiff;
			previewStartLine?: number;
			previewTruncated: boolean;
			changeStats: ChangeStats;
	  }
	| {
			status: "failed";
			path: string;
			error: string;
			errorKind?: RecoverableEditErrorKind;
	  };

export type CallToolViewModel = {
	kind: "call";
	path: string;
	edits: FileEditOperation[];
};

/** 文件结果统一为 _shared 的 FileMutationResult（label="edit"，构建时填入 cwd）。 */
export type FileResultView = FileMutationResult;

export type ResultToolViewModel = {
	kind: "result";
	file: FileResultView;
};

export type CallRenderViewModel =
	| { kind: "invalid"; message: string }
	| CallToolViewModel;

export type ToolViewModel =
	| CallRenderViewModel
	| ResultToolViewModel;

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

/**
 * 手写校验（schema 只做 provider 参数契约）：规则简单、错误消息带字段路径，
 * 模型可直接行动；unknown key 报 "must be removed"（normalize 不吞未知键）。
 */
export function parseEditRequest(input: unknown): EditRequest {
	const normalized = normalizeEditInput(input);
	if (!isRecord(normalized)) invalidEditRequest("path must be a string");
	for (const key of Object.keys(normalized)) {
		if (key !== "path" && key !== "edits") invalidEditRequest(`${key} must be removed`);
	}
	if (typeof normalized.path !== "string") invalidEditRequest("path must be a string");
	if (!Array.isArray(normalized.edits)) invalidEditRequest("edits must be an array");
	if (normalized.edits.length === 0) invalidEditRequest("edits must not be empty");

	const edits = normalized.edits.map((entry, index) => {
		if (!isRecord(entry)) invalidEditRequest(`edits[${index}] must be an object`);
		for (const key of Object.keys(entry)) {
			if (key !== "oldText" && key !== "newText" && key !== "replaceAll") {
				invalidEditRequest(`${key} must be removed`);
			}
		}
		if (typeof entry.oldText !== "string") invalidEditRequest(`edits[${index}].oldText must be a string`);
		if (typeof entry.newText !== "string") invalidEditRequest(`edits[${index}].newText must be a string`);
		if (entry.replaceAll !== undefined && typeof entry.replaceAll !== "boolean") {
			invalidEditRequest(`edits[${index}].replaceAll must be boolean`);
		}
		return {
			oldText: entry.oldText,
			newText: entry.newText,
			...(entry.replaceAll !== undefined ? { replaceAll: entry.replaceAll } : {}),
		};
	});

	return { path: normalized.path, edits };
}

export function buildCallToolViewModel(args: unknown): CallRenderViewModel {
	try {
		const request = parseEditRequest(args);
		return {
			kind: "call",
			path: request.path,
			edits: request.edits.slice(),
		};
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
}

function isOperationAborted(error: unknown): boolean {
	return error instanceof Error && error.message === "Operation aborted";
}

/**
 * Execute the single-file edit request atomically and build its outcome.
 * Aborts rethrow; recoverable edit failures become failed outcomes.
 */
export async function executeSingleFileEdit(
	request: EditRequest,
	cwd: string,
	signal?: AbortSignal,
): Promise<EditOutcome> {
	const targetPath = canonicalizePath(request.path, cwd);

	try {
		const result = await executeFileEdits(targetPath, request.edits, signal);

		const outcome: EditOutcome = {
			path: request.path,
			status: "applied",
			previewDisplay: result.previewDisplay,
			previewTruncated: result.previewTruncated,
			changeStats: result.changeStats,
		};
		if (typeof result.previewStartLine === "number") {
			outcome.previewStartLine = result.previewStartLine;
		}
		return outcome;
	} catch (error) {
		if (signal?.aborted || isOperationAborted(error)) {
			throw error instanceof Error ? error : new Error(String(error));
		}

		const failure = error instanceof Error ? error : new Error(String(error));
		return {
			path: request.path,
			status: "failed",
			error: failure.message,
			errorKind: isEditToolError(failure) ? failure.kind : undefined,
		};
	}
}

export type AgentEditOutcome =
	| {
			status: "applied";
			path: string;
			changes: ChangeStats;
			firstChangedLine?: number;
	  }
	| {
			status: "failed";
			path: string;
			error: {
				kind?: RecoverableEditErrorKind;
				message: string;
			};
	  };

export function buildOutcomeAgentContent(outcome: EditOutcome): string {
	if (outcome.status === "failed") {
		const agentOutcome: AgentEditOutcome = {
			status: "failed",
			path: outcome.path,
			error: {
				kind: outcome.errorKind,
				message: outcome.error,
			},
		};
		return JSON.stringify(agentOutcome);
	}

	const agentOutcome: AgentEditOutcome = {
		status: "applied",
		path: outcome.path,
		changes: outcome.changeStats,
		firstChangedLine: outcome.previewStartLine,
	};
	return JSON.stringify(agentOutcome);
}

function buildFileResultView(outcome: EditOutcome, cwd: string): FileResultView {
	if (outcome.status === "failed") {
		return {
			label: "edit",
			path: outcome.path,
			cwd,
			changeStats: { additions: 0, deletions: 0, changedLines: 0 },
			display: { lineNumberWidth: 1, rows: [] },
			truncated: false,
			status: "failed",
			error: outcome.error,
		};
	}
	return {
		label: "edit",
		path: outcome.path,
		cwd,
		changeStats: outcome.changeStats,
		display: outcome.previewDisplay,
		truncated: outcome.previewTruncated,
	};
}

export function buildOutcomeUiDetails(outcome: EditOutcome, cwd: string): ResultToolViewModel {
	return {
		kind: "result",
		file: buildFileResultView(outcome, cwd),
	};
}
