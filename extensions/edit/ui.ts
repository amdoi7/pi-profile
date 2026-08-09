import {
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import {
	appendFileMutationBatch,
	beginFileMutationResultRender,
	beginPendingFileMutationRender,
	clearPendingFileMutationRender,
	type FileMutationRenderItem,
} from "../_shared/file-mutation-view.ts";
import { isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";

import { renderDiffSummary } from "../_shared/code-preview.ts";
import { renderCwdFilePathLink } from "../_shared/file-link.ts";

import type { CallRenderViewModel, ResultToolViewModel } from "./pipeline.ts";

type EditToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFileResult(value: unknown): boolean {
	if (!isRecord(value) || typeof value.path !== "string") return false;
	if (value.status === "failed") {
		return typeof value.error === "string";
	}
	return value.status === "applied" &&
		isDisplayDiff(value.previewDisplay) &&
		typeof value.previewTruncated === "boolean" &&
		isChangeStats(value.changeStats);
}

function isRenderedResultPayload(value: unknown): value is ResultToolViewModel {
	return isRecord(value) &&
		value.kind === "result" &&
		isFileResult(value.file);
}

function renderCallTitle(theme: Theme): string {
	return theme.fg("toolTitle", theme.bold("edit"));
}

export function renderClearedCallState(context: EditToolRenderContext): Container {
	return beginPendingFileMutationRender(context);
}

export function renderCallViewModel(
	viewModel: CallRenderViewModel,
	theme: Theme,
	context: EditToolRenderContext,
): Container | Text {
	if (viewModel.kind === "invalid") {
		return new Text(`${renderCallTitle(theme)}\n${theme.fg("error", viewModel.message)}`, 0, 0);
	}

	const container = beginPendingFileMutationRender(context);
	appendFileMutationBatch(container, [{
		title: `${renderCallTitle(theme)} ${renderCwdFilePathLink(viewModel.path, viewModel.path, context.cwd, theme)}`,
		outcome: "pending",
	}], theme);
	return container;
}

export function renderResultContractError(
	theme: Theme,
	context: EditToolRenderContext,
): Text {
	clearPendingFileMutationRender(context);
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(theme.fg(
		"error",
		'edit_result_contract_invalid expected="details.kind=result with one structured file result" action="report the edit extension result payload"',
	));
	return text;
}

function fileResultTitle(
	file: ResultToolViewModel["file"],
	theme: Theme,
	context: EditToolRenderContext,
): string {
	const summary = file.status === "applied"
		? renderDiffSummary(file.changeStats, theme)
		: theme.fg("error", "failed");
	const suffix = summary.length > 0 ? `${theme.fg("muted", " · ")}${summary}` : "";
	return `${renderCallTitle(theme)} ${renderCwdFilePathLink(file.path, file.path, context.cwd, theme)}` + suffix;
}

function fileResultItem(
	file: ResultToolViewModel["file"],
	theme: Theme,
	context: EditToolRenderContext,
): FileMutationRenderItem {
	const title = fileResultTitle(file, theme, context);
	if (file.status === "failed") {
		return { title, outcome: "failed", message: file.error };
	}
	const hasDiff = file.previewDisplay.rows.length > 0 || file.previewTruncated;
	return {
		title,
		outcome: "applied",
		previews: hasDiff
			? [{ display: file.previewDisplay, truncated: file.previewTruncated }]
			: [],
	};
}

export function parseRenderedResultPayload(result: { details?: unknown }): ResultToolViewModel | undefined {
	return isRenderedResultPayload(result.details) ? result.details : undefined;
}

export function renderResultViewModel(
	viewModel: ResultToolViewModel,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: EditToolRenderContext,
): Container {
	const container = beginFileMutationResultRender(context);
	appendFileMutationBatch(container, [fileResultItem(viewModel.file, theme, context)], theme);
	return container;
}
