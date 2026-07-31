import * as fs from "node:fs";
import * as path from "node:path";

import { type } from "arktype";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FileEditOperation, RecoverableEditErrorKind } from "./edit-engine.ts";
import type { ChangeStats } from "./preview.ts";

const editOperationSchema = type({
	oldText: "string",
	newText: "string",
	"expectedOccurrences?": "number.integer>=1",
}).onDeepUndeclaredKey("reject");

const editFileSchema = type({
	path: "string",
	edits: editOperationSchema.array().atLeastLength(1),
}).onDeepUndeclaredKey("reject");

const editRequestSchema = type({
	files: editFileSchema.array().atLeastLength(1),
}).onDeepUndeclaredKey("reject");

export const editRequestParameters: ToolDefinition["parameters"] = editRequestSchema.toJsonSchema() as ToolDefinition["parameters"];

export type EditRequest = typeof editRequestSchema.infer;
export type EditRequestFile = EditRequest["files"][number];

export type ExecutionPlanGroup = {
	path: string;
	canonicalPath: string;
	edits: FileEditOperation[];
};

export type ExecutionPlan = {
	groups: ExecutionPlanGroup[];
	totalEdits: number;
	maxConcurrency: number;
};

type ExecutionOutcomeGroupBase = {
	path: string;
	canonicalPath: string;
	edits: FileEditOperation[];
	editCount: number;
};

export type SuccessfulExecutionOutcomeGroup = ExecutionOutcomeGroupBase & {
	status: "applied";
	operation: "replace";
	previewText: string;
	previewStartLine?: number;
	previewTruncated: boolean;
	changeStats: ChangeStats;
	summary?: string;
};

export type FailedExecutionOutcomeGroup = ExecutionOutcomeGroupBase & {
	status: "failed";
	error: string;
	errorKind?: RecoverableEditErrorKind;
};

export type ExecutionOutcomeGroup = SuccessfulExecutionOutcomeGroup | FailedExecutionOutcomeGroup;
export type ExecutionOutcomeStatus = "success" | "partial_failure" | "failure";

export type ExecutionOutcome = {
	overallStatus: ExecutionOutcomeStatus;
	appliedCount: number;
	failedCount: number;
	groups: ExecutionOutcomeGroup[];
};

export type CallToolViewModel = {
	kind: "call";
	groups: EditRequestFile[];
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
	groups: ResultToolViewGroup[];
};

export type ToolViewModel =
	| { kind: "invalid"; message: string }
	| CallToolViewModel
	| ResultToolViewModel;

export const DEFAULT_PLAN_MAX_CONCURRENCY = 4;

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
	return editRequestSchema.assert(args);
}

export function buildCallToolViewModel(args: unknown): ToolViewModel {
	try {
		const request = parseEditRequest(args);
		return {
			kind: "call",
			groups: request.files.map((group) => ({ path: group.path, edits: cloneEdits(group.edits) })),
		};
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
}

export function createExecutionPlan(
	request: EditRequest,
	cwd: string,
	options: {
		maxConcurrency?: number;
		canonicalize?: (filePath: string, cwd: string) => string;
	} = {},
): ExecutionPlan {
	const canonicalize = options.canonicalize ?? canonicalizePath;
	const canonicalPathMemo = new Map<string, string>();
	const groups: ExecutionPlanGroup[] = [];
	const seenCanonicalPaths = new Map<string, ExecutionPlanGroup>();
	let totalEdits = 0;

	for (const file of request.files) {
		const resolvedPath = resolvePath(file.path, cwd);
		let canonicalPath = canonicalPathMemo.get(resolvedPath);
		if (canonicalPath === undefined) {
			canonicalPath = canonicalize(file.path, cwd);
			canonicalPathMemo.set(resolvedPath, canonicalPath);
		}

		const existing = seenCanonicalPaths.get(canonicalPath);
		if (existing) {
			existing.edits.push(...cloneEdits(file.edits));
			totalEdits += file.edits.length;
			continue;
		}

		const planGroup = {
			path: file.path,
			canonicalPath,
			edits: cloneEdits(file.edits),
		};
		groups.push(planGroup);
		seenCanonicalPaths.set(canonicalPath, planGroup);
		totalEdits += file.edits.length;
	}

	const configuredConcurrency = options.maxConcurrency ?? DEFAULT_PLAN_MAX_CONCURRENCY;
	const maxConcurrency = groups.length === 0
		? 1
		: Math.max(1, Math.min(configuredConcurrency, groups.length));

	return {
		groups,
		totalEdits,
		maxConcurrency,
	};
}

export function determineOverallStatus(appliedCount: number, failedCount: number): ExecutionOutcomeStatus {
	if (failedCount === 0) return "success";
	if (appliedCount === 0) return "failure";
	return "partial_failure";
}

export function buildExecutionOutcome(groups: ExecutionOutcomeGroup[]): ExecutionOutcome {
	const appliedCount = groups.filter((group) => group.status === "applied").length;
	const failedCount = groups.length - appliedCount;
	return {
		overallStatus: determineOverallStatus(appliedCount, failedCount),
		appliedCount,
		failedCount,
		groups,
	};
}

function fileLabel(count: number): string {
	return `${count} file${count === 1 ? "" : "s"}`;
}

export function buildOutcomeSummary(outcome: ExecutionOutcome): string {
	if (outcome.failedCount === 0) {
		return `Applied ${fileLabel(outcome.appliedCount)}.`;
	}
	if (outcome.appliedCount === 0) {
		return `Failed ${fileLabel(outcome.failedCount)}.`;
	}
	return `Applied ${fileLabel(outcome.appliedCount)}; ${outcome.failedCount} failed.`;
}

function buildAppliedAgentGroupPayload(group: SuccessfulExecutionOutcomeGroup): AgentAppliedExecutionOutcomeGroup {
	return {
		path: group.path,
		changes: group.changeStats,
		firstChangedLine: group.previewStartLine,
	};
}

function buildFailedAgentGroupPayload(group: FailedExecutionOutcomeGroup): AgentFailedExecutionOutcomeGroup {
	return {
		path: group.path,
		error: {
			kind: group.errorKind,
			message: group.error,
		},
	};
}

export type AgentAppliedExecutionOutcomeGroup = {
	path: string;
	changes: ChangeStats;
	firstChangedLine?: number;
};

export type AgentFailedExecutionOutcomeGroup = {
	path: string;
	error: {
		kind?: RecoverableEditErrorKind;
		message: string;
	};
};

export type AgentExecutionOutcome = {
	counts: {
		applied: number;
		failed: number;
	};
	applied: AgentAppliedExecutionOutcomeGroup[];
	failed: AgentFailedExecutionOutcomeGroup[];
};

export function buildOutcomeAgentContent(outcome: ExecutionOutcome): string {
	return JSON.stringify({
		counts: {
			applied: outcome.appliedCount,
			failed: outcome.failedCount,
		},
		applied: outcome.groups
			.filter((group): group is SuccessfulExecutionOutcomeGroup => group.status === "applied")
			.map(buildAppliedAgentGroupPayload),
		failed: outcome.groups
			.filter((group): group is FailedExecutionOutcomeGroup => group.status === "failed")
			.map(buildFailedAgentGroupPayload),
	} satisfies AgentExecutionOutcome);
}

function buildResultToolViewGroup(group: ExecutionOutcomeGroup): ResultToolViewGroup {
	if (group.status === "failed") {
		return {
			path: group.path,
			status: "failed",
			error: group.error,
			errorKind: group.errorKind,
		};
	}
	return {
		path: group.path,
		status: "applied",
		previewText: group.previewText,
		previewStartLine: group.previewStartLine,
		previewTruncated: group.previewTruncated,
		changeStats: group.changeStats,
		summary: group.summary,
	};
}

export function buildResultToolViewModel(input: {
	groups: ResultToolViewGroup[];
	summary: string;
}): ResultToolViewModel {
	return {
		kind: "result",
		summary: input.summary,
		groups: input.groups,
	};
}

export function buildOutcomeUiDetails(outcome: ExecutionOutcome): ResultToolViewModel {
	return buildResultToolViewModel({
		summary: buildOutcomeSummary(outcome),
		groups: outcome.groups.map(buildResultToolViewGroup),
	});
}
