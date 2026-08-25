/**
 * ui.ts —— edit 的批次展示：意图头 + 每文件一行（含 diff）。
 *
 * 归因只在批头出现一次（label="edit"），文件行用缩进 rail 归属到这个意图；
 * per-file hint 与「未落盘」状态都走 FileMutationResult.note（muted 行尾）。
 */

import {
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import {
	appendFileMutationBatch,
	beginFileMutationResultRender,
	beginPendingFileMutationRender,
	clearPendingFileMutationRender,
} from "../_shared/file-mutation-view.ts";
import { isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";
import { fileMutationPlanItem, fileResultItem } from "../_shared/file-result.ts";

import type { BatchUiDetails, CallRenderViewModel, FileOutcome } from "./pipeline.ts";

type EditToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** 文件行的缩进：批头承担归因，文件行靠缩进归属。 */
const FILE_RAIL = "  ";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFileOutcome(value: unknown): value is FileOutcome {
	if (!isRecord(value) || typeof value.path !== "string") return false;
	if (value.status === "applied") {
		return isChangeStats(value.changeStats) && isDisplayDiff(value.display);
	}
	if (value.status === "failed") return typeof value.error === "string";
	return value.status === "notWritten" && typeof value.restored === "boolean";
}

function isBatchUiDetails(value: unknown): value is BatchUiDetails {
	if (!isRecord(value)) return false;
	if (value.status !== "applied" && value.status !== "rejected" && value.status !== "partial") return false;
	if (typeof value.intent !== "string" || typeof value.cwd !== "string") return false;
	return Array.isArray(value.files) && value.files.every(isFileOutcome);
}

/** 批头：`edit <intent> · <status>`；applied 时状态位留给文件行的 stats。 */
function renderBatchTitle(intent: string, theme: Theme, status?: string): string {
	const head = `${theme.fg("toolTitle", theme.bold("edit"))} ${intent}`;
	return status === undefined ? head : `${head}${theme.fg("muted", " · ")}${theme.fg("error", status)}`;
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
		return new Text(
			`${theme.fg("toolTitle", theme.bold("edit"))}\n${theme.fg("error", viewModel.message)}`,
			0,
			0,
		);
	}

	const container = beginPendingFileMutationRender(context);
	container.addChild(new Text(renderBatchTitle(viewModel.intent, theme), 0, 0));
	appendFileMutationBatch(
		container,
		viewModel.files.map((file) => fileMutationPlanItem({
			label: "",
			path: file.path,
			cwd: context.cwd,
			changeStats: { additions: 0, deletions: 0, changedLines: 0 },
			...(file.hint !== undefined ? { note: file.hint } : {}),
		}, theme, context.cwd)),
		theme,
		FILE_RAIL,
	);
	return container;
}

/** 清 pending 态并复用/新建 Text（契约诊断与错误结果共享的单出口）。 */
function replaceWithText(context: EditToolRenderContext, value: string): Text {
	clearPendingFileMutationRender(context);
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(value);
	return text;
}

/** 执行错误结果（校验/abort）：渲染真实错误文本。 */
export function renderResultTextContent(
	result: { content: Array<{ type: string; text?: string }> },
	theme: Theme,
	context: EditToolRenderContext,
): Text {
	const message = result.content.map((part) => part.text ?? "").join("\n").trim();
	return replaceWithText(
		context,
		`${theme.fg("toolTitle", theme.bold("edit"))}\n${theme.fg("error", message || "edit failed")}`,
	);
}

/** 未落盘文件的行尾注记：回滚过的说清楚「写过又还原」。 */
function notWrittenNote(file: Extract<FileOutcome, { status: "notWritten" }>): string {
	const state = file.restored ? "restored" : "not written";
	return file.hint === undefined ? state : `${file.hint} · ${state}`;
}

function fileItems(details: BatchUiDetails, theme: Theme) {
	return details.files.map((file) => {
		if (file.status === "applied") {
			return fileResultItem({
				label: "",
				path: file.path,
				cwd: details.cwd,
				changeStats: file.changeStats,
				display: file.display,
				truncated: file.truncated,
				...(file.hint !== undefined ? { note: file.hint } : {}),
			}, theme, details.cwd);
		}
		if (file.status === "failed") {
			return fileResultItem({
				label: "",
				path: file.path,
				cwd: details.cwd,
				changeStats: { additions: 0, deletions: 0, changedLines: 0 },
				display: { lineNumberWidth: 1, rows: [] },
				truncated: false,
				status: "failed",
				error: file.error,
				...(file.hint !== undefined ? { note: file.hint } : {}),
			}, theme, details.cwd);
		}
		return fileMutationPlanItem({
			label: "",
			path: file.path,
			cwd: details.cwd,
			changeStats: { additions: 0, deletions: 0, changedLines: 0 },
			note: notWrittenNote(file),
		}, theme, details.cwd);
	});
}

/** 批次状态词：applied 不加（文件行的 stats 已说明），失败态说清磁盘现状。 */
function batchStatusWord(details: BatchUiDetails): string | undefined {
	if (details.status === "applied") return undefined;
	return details.status === "rejected" ? "rejected · nothing written" : "partial · some files left changed";
}

export function renderResultFromDetails(
	details: unknown,
	theme: Theme,
	context: EditToolRenderContext,
): Container | Text {
	if (!isBatchUiDetails(details)) {
		const debugInfo = isRecord(details)
			? `status=${String(details.status)}, keys=${Object.keys(details).join(",")}`
			: `type=${typeof details}`;
		return replaceWithText(
			context,
			theme.fg("error", `edit_result_contract_invalid: details format unexpected (${debugInfo})`),
		);
	}

	const container = beginFileMutationResultRender(context);
	container.addChild(new Text(renderBatchTitle(details.intent, theme, batchStatusWord(details)), 0, 0));
	appendFileMutationBatch(container, fileItems(details, theme), theme, FILE_RAIL);
	return container;
}
