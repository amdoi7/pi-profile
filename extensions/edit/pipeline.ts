import * as fs from "node:fs";
import * as path from "node:path";

import { type } from "arktype";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	executeFileEdits,
	isEditToolError,
	type FileEditOperation,
	type RecoverableEditErrorKind,
} from "./edit-engine.ts";
import type { ChangeStats } from "./preview.ts";

const editOperationSchema = type({
	oldText: "string",
	newText: "string",
	"replaceAll?": "boolean",
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
			previewText: string;
			previewStartLine?: number;
			previewTruncated: boolean;
			changeStats: ChangeStats;
			summary?: string;
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

export type FileResultView =
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
	  };

export type ResultToolViewModel = {
	kind: "result";
	file: FileResultView;
};

export type ToolViewModel =
	| { kind: "invalid"; message: string }
	| CallToolViewModel
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

export function parseEditRequest(input: unknown): EditRequest {
	return editRequestSchema.assert(normalizeEditInput(input));
}

/**
 * Tolerate two input shapes models keep producing despite the public
 * { path, edits } contract:
 * - edits as a JSON string (same tolerance as pi's built-in edit tool)
 * - a single-file { files: [...] } wrapper, which models learned from
 *   session history predating the grouped-contract removal
 * Anything else is left untouched so the schema rejects it loudly.
 */
function normalizeEditInput(input: unknown): unknown {
	if (!input || typeof input !== "object") {
		return input;
	}
	const request = input as Record<string, unknown>;

	if (typeof request.edits === "string") {
		try {
			const parsed = JSON.parse(request.edits);
			if (Array.isArray(parsed)) {
				return { ...request, edits: parsed };
			}
		} catch {
			// fall through to the schema error for a non-array edits
		}
	}

	if (Array.isArray(request.files) && !("path" in request)) {
		if (request.files.length !== 1) {
			throw new Error(
				`edit accepts one file per call ({ path, edits }); received ${request.files.length} files in the legacy "files" wrapper — make one call per file`,
			);
		}
		const legacyFile = request.files[0];
		if (legacyFile && typeof legacyFile === "object") {
			return legacyFile;
		}
	}

	return input;
}

export function buildCallToolViewModel(args: unknown): ToolViewModel {
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

function buildFileResultView(outcome: EditOutcome): FileResultView {
	if (outcome.status === "failed") {
		return {
			path: outcome.path,
			status: "failed",
			error: outcome.error,
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
		file: buildFileResultView(outcome),
	};
}
