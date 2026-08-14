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
} from "../_shared/file-mutation-view.ts";
import { isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";

import { fileMutationPlanItem, fileResultItem, type FileMutationResult } from "../_shared/file-result.ts";

import type { CallRenderViewModel, ResultToolViewModel } from "./pipeline.ts";

type EditToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFileResult(value: unknown): boolean {
	if (!isRecord(value) || typeof value.label !== "string" || typeof value.path !== "string" || typeof value.cwd !== "string") return false;
	if (value.status === "failed") {
		return typeof value.error === "string";
	}
	return isDisplayDiff(value.display) &&
		typeof value.truncated === "boolean" &&
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
	appendFileMutationBatch(container, [fileMutationPlanItem({
		label: "edit",
		path: viewModel.path,
		cwd: context.cwd,
		changeStats: { additions: 0, deletions: 0, changedLines: 0 },
	}, theme, context.cwd)], theme);
	return container;
}

/** 清 pending 态并复用/新建 Text（contract 诊断与错误结果共享的单出口）。 */
function replaceWithText(context: EditToolRenderContext, value: string): Text {
	clearPendingFileMutationRender(context);
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(value);
	return text;
}

export function renderResultContractError(
	theme: Theme,
	context: EditToolRenderContext,
): Text {
	return replaceWithText(
		context,
		theme.fg(
			"error",
			'edit_result_contract_invalid expected="details.kind=result with one structured file result" action="report the edit extension result payload"',
		),
	);
}

/** 执行错误结果（校验/abort，details 为空）：渲染真实错误文本，不掩盖用户可行动信息。 */
export function renderResultTextContent(
	result: { content: Array<{ type: string; text?: string }> },
	theme: Theme,
	context: EditToolRenderContext,
): Text {
	const message = result.content.map((part) => part.text ?? "").join("\n").trim();
	return replaceWithText(context, `${renderCallTitle(theme)}\n${theme.fg("error", message || "edit failed")}`);
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
	appendFileMutationBatch(
		container,
		[fileResultItem(viewModel.file, theme, context.cwd)],
		theme,
	);
	return container;
}
