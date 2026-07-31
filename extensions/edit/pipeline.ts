import * as fs from "node:fs";
import * as path from "node:path";

import { type } from "arktype";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	executeFileGroupEdits,
	isEditToolError,
	type FileEditOperation,
	type RecoverableEditErrorKind,
} from "./edit-engine.ts";
import type { ChangeStats } from "./preview.ts";

const editOperationSchema = type({
	oldText: "string",
	newText: "string",
	"expectedOccurrences?": "number.integer>=1",
}).onDeepUndeclaredKey("reject");

// One file per call ({ path, edits }), matching pi's built-in edit tool so
// models never have to learn a second shape. Multi-file edits are done with
// one call per file; pi executes them in parallel.
const editRequestSchema = type({
	path: "string",
	edits: editOperationSchema.array().atLeastLength(1),
}).onDeepUndeclaredKey("reject");

export const editRequestParameters: ToolDefinition["parameters"] = editRequestSchema.toJsonSchema() as ToolDefinition["parameters"];

export type EditRequest = typeof editRequestSchema.infer;

export type EditOutcome =
	| {
			status: "applied";
			path: string;
			canonicalPath: string;
			edits: FileEditOperation[];
			editCount: number;
			previewText: string;
			previewStartLine?: number;
			previewTruncated: boolean;
			changeStats: ChangeStats;
			summary?: string;
	  }
	| {
			status: "failed";
			path: string;
			canonicalPath: string;
			edits: FileEditOperation[];
			editCount: number;
			error: string;
			errorKind?: RecoverableEditErrorKind;
	  };

export type CallToolViewModel = {
	kind: "call";
	path: string;
	edits: FileEditOperation[];
};

export type ResultToolViewGroup =
	| {
			path: string;
			status: "applied";
			previewText: string;
			previewStartLine?: number;
			previewTruncated: boolean;
			changeStats: ChangeStats;
			summary?: string;
	  }
	| {
			path: string;
			status: "failed";
			error: string;
			errorKind?: RecoverableEditErrorKind;
	  };

export type ResultToolViewModel = {
	kind: "result";
	summary: string;
	group: ResultToolViewGroup;
};

export type ToolViewModel =
	| { kind: "invalid"; message: string }
	| CallToolViewModel
	| ResultToolViewModel;

function resolvePath(filePath: string, cwd: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function canonicalizePath(filePath: string, cwd: string): string {
	const resolvedPath = resolvePath(filePath, cwd);
	try {
		return fs.realpathSync.native(resolvedPath);
	} catch {
		return path.normalize(resolvedPath);
	}
}

function cloneEdits(edits: FileEditOperation[]): FileEditOperation[] {
	return edits.slice();
}

export function parseEditRequest(args: unknown): EditRequest {
	return editRequestSchema.assert(normalizeLegacyShapes(args));
}

/**
 * Tolerate two input shapes models keep producing despite the public
 * { path, edits } contract:
 * - edits as a JSON string (same tolerance as pi's built-in edit tool)
 * - a single-file { files: [...] } wrapper, which models learned from
 *   session history predating the grouped-contract removal
 * Anything else is left untouched so the schema rejects it loudly.
 */
function normalizeLegacyShapes(args: unknown): unknown {
	if (!args || typeof args !== "object") {
		return args;
	}
	const obj = args as Record<string, unknown>;

	if (typeof obj.edits === "string") {
		try {
			const parsed = JSON.parse(obj.edits);
			if (Array.isArray(parsed)) {
				return { ...obj, edits: parsed };
			}
		} catch {
			// fall through to the schema error for a non-array edits
		}
	}

	if (Array.isArray(obj.files) && !("path" in obj)) {
		if (obj.files.length !== 1) {
			throw new Error(
				`edit accepts one file per call ({ path, edits }); received ${obj.files.length} files in the legacy "files" wrapper — make one call per file`,
			);
		}
		const file = obj.files[0];
		if (file && typeof file === "object") {
			return file;
		}
	}

	return args;
}

export function buildCallToolViewModel(args: unknown): ToolViewModel {
	try {
		const request = parseEditRequest(args);
		return {
			kind: "call",
			path: request.path,
			edits: cloneEdits(request.edits),
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
	const canonicalPath = canonicalizePath(request.path, cwd);

	try {
		const result = await executeFileGroupEdits(canonicalPath, request.path, request.edits, signal);

		const outcome: EditOutcome = {
			path: request.path,
			canonicalPath,
			edits: request.edits,
			editCount: request.edits.length,
			status: "applied",
			previewText: result.previewText,
			previewTruncated: result.previewTruncated,
			changeStats: result.changeStats,
		};
		if (typeof result.previewStartLine === "number") {
			outcome.previewStartLine = result.previewStartLine;
		}
		if (result.summary.trim().length > 0) {
			outcome.summary = result.summary.trim();
		}
		return outcome;
	} catch (error) {
		if (signal?.aborted || isOperationAborted(error)) {
			throw error instanceof Error ? error : new Error(String(error));
		}

		const baseError = error instanceof Error ? error : new Error(String(error));
		return {
			path: request.path,
			canonicalPath,
			edits: request.edits,
			editCount: request.edits.length,
			status: "failed",
			error: baseError.message,
			errorKind: isEditToolError(baseError) ? baseError.kind : undefined,
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

function buildResultToolViewGroup(outcome: EditOutcome): ResultToolViewGroup {
	if (outcome.status === "failed") {
		return {
			path: outcome.path,
			status: "failed",
			error: outcome.error,
			errorKind: outcome.errorKind,
		};
	}
	return {
		path: outcome.path,
		status: "applied",
		previewText: outcome.previewText,
		previewStartLine: outcome.previewStartLine,
		previewTruncated: outcome.previewTruncated,
		changeStats: outcome.changeStats,
		summary: outcome.summary,
	};
}

export function buildOutcomeUiDetails(outcome: EditOutcome): ResultToolViewModel {
	return {
		kind: "result",
		summary: outcome.status === "applied" ? "Applied." : "Failed.",
		group: buildResultToolViewGroup(outcome),
	};
}
