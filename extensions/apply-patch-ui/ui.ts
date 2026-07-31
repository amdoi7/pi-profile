import { renderDiff, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

import { renderDiffSummary, renderHiddenFooter } from "../_shared/code-preview.ts";
import { renderCwdFilePathLink } from "../_shared/file-link.ts";
import { generateFinalDiff, type FinalDiff } from "../_shared/final-diff.ts";
import {
	EphemeralPatchRuns,
	snapshotContent,
	type EphemeralPatchRun,
	type SnapshotDiagnostic,
} from "./ephemeral-patch-runs.ts";
import type { ParsedPatch, PatchOperation } from "./patch-command.ts";
import {
	failureMatchesPatch,
	parseApplyPatchFailure,
	parseSuccessfulChanges,
	resultText,
	successMatchesPatch,
	type AppliedChange,
	type ApplyPatchFailure,
	type SuccessfulChange,
} from "./patch-result.ts";

export type PatchRenderContext = {
	cwd: string;
	expanded: boolean;
	lastComponent?: unknown;
	toolCallId: string;
	state: Record<string, unknown>;
	isError: boolean;
};

type ApplyPatchRenderState = {
	ephemeralRun?: EphemeralPatchRun | null;
};

function operationStats(operation: PatchOperation) {
	const additions = operation.lines.filter((line) => line.prefix === "+").length;
	const deletions = operation.lines.filter((line) => line.prefix === "-").length;
	return { additions, deletions, changedLines: additions + deletions };
}

function renderOperationPath(operation: PatchOperation, theme: Theme, context: PatchRenderContext): string {
	const source = renderCwdFilePathLink(operation.path, operation.path, context.cwd, theme);
	if (!operation.destination) return source;
	const destination = renderCwdFilePathLink(operation.destination, operation.destination, context.cwd, theme);
	return `${source}${theme.fg("muted", " -> ")}${destination}`;
}

function renderOperationHeader(operation: PatchOperation, theme: Theme, context: PatchRenderContext): string {
	const label = operation.destination ? "move" : operation.kind;
	const stats = operationStats(operation);
	const summary = stats.changedLines > 0 ? ` ${theme.fg("muted", "·")} ${renderDiffSummary(stats, theme)}` : "";
	return [
		theme.fg("toolTitle", theme.bold("apply_patch")),
		theme.fg("muted", label),
		renderOperationPath(operation, theme, context),
	].join(" ") + summary;
}

export function renderPendingApplyPatch(
	patch: ParsedPatch,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = new Container();
	for (const operation of patch.operations) {
		container.addChild(new Text(renderOperationHeader(operation, theme, context), 0, 0));
	}
	return container;
}

function resultPathLine(change: SuccessfulChange | AppliedChange, theme: Theme, context: PatchRenderContext): string {
	const status = "status" in change ? change.status : change.operation === "add" ? "A" : change.operation === "delete" ? "D" : "M";
	const verb = status === "A" ? "added" : status === "D" ? "deleted" : "modified";
	return `${theme.fg("muted", verb)} ${renderCwdFilePathLink(change.path, change.path, context.cwd, theme)}`;
}

function operationFinalDiff(run: EphemeralPatchRun, operation: PatchOperation): FinalDiff | undefined {
	const oldContent = snapshotContent(run, "before", operation.path);
	const finalPath = operation.destination ?? operation.path;
	const newContent = snapshotContent(run, "after", finalPath);
	if (oldContent === undefined || newContent === undefined) return undefined;
	return generateFinalDiff(oldContent, newContent);
}

function diagnosticText(diagnostic: SnapshotDiagnostic): string {
	return [
		`code=${diagnostic.code}`,
		`path=${JSON.stringify(diagnostic.path)}`,
		`phase=${diagnostic.phase}`,
		`message=${JSON.stringify(diagnostic.message)}`,
		`remediation=${JSON.stringify(diagnostic.remediation)}`,
	].join(" ");
}

function renderConfirmedOperationDiffs(
	container: Container,
	operations: readonly PatchOperation[],
	run: EphemeralPatchRun,
	theme: Theme,
	context: PatchRenderContext,
): void {
	for (const operation of operations) {
		container.addChild(new Spacer(1));
		const diff = operationFinalDiff(run, operation);
		if (!diff) {
			container.addChild(new Text(renderOperationHeader(operation, theme, context), 0, 0));
			continue;
		}
		const label = operation.destination ? "move" : operation.kind;
		container.addChild(new Text(
			[
				theme.fg("toolTitle", theme.bold("apply_patch")),
				theme.fg("muted", label),
				renderOperationPath(operation, theme, context),
				theme.fg("muted", "·"),
				renderDiffSummary(diff.stats, theme),
			].join(" "),
			0,
			0,
		));
		if (diff.text.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(renderDiff(diff.text), 0, 0));
		}
		if (diff.truncated) {
			container.addChild(new Text(renderHiddenFooter(1, "diff preview", theme), 0, 0));
		}
	}
	for (const diagnostic of run.diagnostics) {
		container.addChild(new Text(theme.fg("warning", diagnosticText(diagnostic)), 0, 0));
	}
}

function renderSuccess(
	patch: ParsedPatch,
	changes: SuccessfulChange[],
	run: EphemeralPatchRun | undefined,
	options: ToolRenderResultOptions,
	text: string,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = new Container();
	const count = patch.operations.length;
	container.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("success", `applied ${count} operation${count === 1 ? "" : "s"}`)}`,
		0,
		0,
	));
	if (run) renderConfirmedOperationDiffs(container, patch.operations, run, theme, context);
	else for (const change of changes) container.addChild(new Text(resultPathLine(change, theme, context), 0, 0));
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", text), 0, 0));
	}
	return container;
}

function renderFailure(
	patch: ParsedPatch,
	failure: ApplyPatchFailure,
	run: EphemeralPatchRun | undefined,
	options: ToolRenderResultOptions,
	text: string,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = new Container();
	container.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("error", `failed ${failure.error.code}`)}`,
		0,
		0,
	));
	container.addChild(new Text(theme.fg("error", failure.error.message), 0, 0));
	const hunk = failure.error.hunk;
	if (hunk) {
		const operation = hunk.operation ?? "operation";
		const path = hunk.path ? ` ${renderCwdFilePathLink(hunk.path, hunk.path, context.cwd, theme)}` : "";
		const chunk = hunk.chunkIndex === undefined ? "" : ` ${theme.fg("muted", `· chunk ${hunk.chunkIndex}`)}`;
		container.addChild(new Text(`${theme.fg("error", `failed ${operation}`)}${path}${chunk}`, 0, 0));
	}
	if (failure.appliedPrefix.length > 0) {
		container.addChild(new Text(theme.fg("warning", `applied before failure ${failure.appliedPrefix.length}`), 0, 0));
		if (run) {
			const operations = failure.appliedPrefix.map((change) => patch.operations[change.index]!);
			renderConfirmedOperationDiffs(container, operations, run, theme, context);
		} else {
			for (const change of failure.appliedPrefix) {
				container.addChild(new Text(resultPathLine(change, theme, context), 0, 0));
			}
		}
	}
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", text), 0, 0));
	}
	return container;
}

export function ephemeralRunForContext(
	runs: EphemeralPatchRuns,
	context: PatchRenderContext,
): EphemeralPatchRun | undefined {
	const state = context.state as ApplyPatchRenderState;
	if (state.ephemeralRun === undefined) state.ephemeralRun = runs.take(context.toolCallId) ?? null;
	return state.ephemeralRun ?? undefined;
}

export function renderApplyPatchResult(
	patch: ParsedPatch,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
	run?: EphemeralPatchRun,
): Container | undefined {
	const text = resultText(result);
	if (!context.isError) {
		const changes = parseSuccessfulChanges(text);
		return changes && successMatchesPatch(patch, changes)
			? renderSuccess(patch, changes, run, options, text, theme, context)
			: undefined;
	}
	const failure = parseApplyPatchFailure(text);
	return failure && failureMatchesPatch(patch, failure)
		? renderFailure(patch, failure, run, options, text, theme, context)
		: undefined;
}
