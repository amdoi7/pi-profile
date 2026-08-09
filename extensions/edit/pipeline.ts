import * as fs from "node:fs";
import * as path from "node:path";

import { type } from "arktype";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import {
	executeFileEdits,
	isEditToolError,
	type FileEditOperation,
	type RecoverableEditErrorKind,
} from "./edit-engine.ts";
import { normalizeEditInput } from "./input-normalize.ts";

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

/**
 * arktype's toJsonSchema emits no per-field descriptions; inject them so the
 * model sees the required-match and delete semantics before calling.
 */
export const editRequestParameters: ToolDefinition["parameters"] = (() => {
	const schema = editRequestSchema.toJsonSchema() as {
		properties?: Record<string, Record<string, unknown>>;
	};
	const properties = schema.properties;
	if (properties) {
		properties.path.description = "Path to the file to edit (relative or absolute).";
		properties.edits.description =
			"One or more targeted replacements, each matched against the original file.";
		const items = properties.edits.items as Record<string, unknown> | undefined;
		const itemProperties = items?.properties as Record<string, Record<string, unknown>> | undefined;
		if (itemProperties) {
			itemProperties.oldText.description =
				"Exact text currently in the file to replace.";
			itemProperties.newText.description =
				"Replacement text. Use an empty string to delete oldText.";
			itemProperties.replaceAll.description =
				"Replace every occurrence of oldText instead of requiring a unique match.";
		}
	}
	return schema as ToolDefinition["parameters"];
})();

export type EditRequest = typeof editRequestSchema.infer;

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

export type FileResultView =
	| {
			path: string;
			status: "applied";
			previewDisplay: DisplayDiff;
			previewStartLine?: number;
			previewTruncated: boolean;
			changeStats: ChangeStats;
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

export function parseEditRequest(input: unknown): EditRequest {
	return editRequestSchema.assert(normalizeEditInput(input));
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
		previewDisplay: outcome.previewDisplay,
		previewStartLine: outcome.previewStartLine,
		previewTruncated: outcome.previewTruncated,
		changeStats: outcome.changeStats,
	};
}

export function buildOutcomeUiDetails(outcome: EditOutcome): ResultToolViewModel {
	return {
		kind: "result",
		file: buildFileResultView(outcome),
	};
}
