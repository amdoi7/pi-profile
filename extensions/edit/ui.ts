/**
 * ui.ts —— edit 的条目展示：每条目一行（含 diff）。
 *
 * 归因只在工具名出现一次（label="edit"），条目行用缩进 rail 归属到这个调用；
 * 每条目显示 path + op 摘要，
 * 成功条目的 diff 嵌在行后。
 */

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
import { fileMutationPlanItem, fileResultItem } from "../_shared/file-result.ts";

import type { EditEntry, EditRequest } from "./match.ts";
import type { EntryOutcome, ScriptOutcome } from "./transaction.ts";

type EditToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** 条目行的缩进：工具名承担归因，条目行靠缩进归属。 */
const ENTRY_RAIL = "  ";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isEntryOutcome(value: unknown): value is EntryOutcome {
	if (!isRecord(value) || !isRecord(value.entry)) return false;
	if (typeof value.entry.match !== "string") return false;
	if (value.status === "applied") {
		return isChangeStats(value.changeStats) && isDisplayDiff(value.display);
	}
	if (value.status === "failed") {
		if (typeof value.error !== "string") return false;
		// closest 是失败载荷的一部分(不进门面渲染,门面用 message 单行 pointer)
		const closest = value.closest;
		if (closest !== undefined && (!isRecord(closest) || typeof closest.text !== "string")) return false;
		return true;
	}
	return value.status === "skipped";
}

/** details 是不是本扩展写的结局：读不懂就降级渲染工具自己的 content 文本。 */
export function isScriptOutcome(value: unknown): value is ScriptOutcome {
	if (!isRecord(value)) return false;
	if (value.status !== "applied" && value.status !== "rejected" && value.status !== "partial") return false;
	if (typeof value.note !== "string" || typeof value.path !== "string" || typeof value.cwd !== "string") return false;
	return Array.isArray(value.entries) && value.entries.every(isEntryOutcome);
}

/** 脚本头：`edit <note>`——note 是脚本的 why，像脚本的 docstring 一样显眼；非 applied 时状态位跟在后。 */
function renderScriptTitle(note: string, theme: Theme, status?: string): string {
	const head = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("text", note)}`;
	return status === undefined ? head : `${head}${theme.fg("muted", " · ")}${theme.fg("error", status)}`;
}

export function renderClearedCallState(context: EditToolRenderContext): Container {
	return beginPendingFileMutationRender(context);
}

function truncate(text: string, max = 24): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 条目摘要：pending 阶段一行说清这一步要做什么（非执行语义）。 */
export function entryLabel(entry: EditEntry): string {
	const suffix = entry.replace_all === true ? " [all]" : "";
	if (entry.new_str === undefined) {
		return `delete "${truncate(entry.match)}"${suffix}`;
	}
	return `${truncate(entry.match)} → ${truncate(entry.new_str)}${suffix}`;
}

/** 校验没过：能给用户的唯一真实信息就是这条消息。 */
export function renderInvalidCall(message: string, theme: Theme): Text {
	return new Text(`${theme.fg("toolTitle", theme.bold("edit"))}\n${theme.fg("error", message)}`, 0, 0);
}

export function renderCallView(
	request: EditRequest,
	theme: Theme,
	context: EditToolRenderContext,
): Container {
	const container = beginPendingFileMutationRender(context);
	container.addChild(new Text(renderScriptTitle(request.note, theme), 0, 0));
	appendFileMutationBatch(
		container,
		request.edits.map((entry) => fileMutationPlanItem({
			label: "",
			path: request.path,
			cwd: context.cwd,
			changeStats: { additions: 0, deletions: 0, changedLines: 0 },
			note: entryLabel(entry),
		}, theme, context.cwd)),
		theme,
		ENTRY_RAIL,
	);
	return container;
}

/** 清 pending 态并复用/新建 Text（文本态结果的单出口）。 */
function replaceWithText(context: EditToolRenderContext, value: string): Text {
	clearPendingFileMutationRender(context);
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(value);
	return text;
}

/**
 * 非条目 payload 的落地渲染：显示工具自己的 content 文本。
 *
 * 覆盖 pi 的执行前失败信封（createErrorToolResult → details={}，execute 从未运行）
 * 与历史版本记录的旧 payload。渲染层不做契约裁判：读不懂 payload 时，能给用户的
 * 唯一真实信息就是这条消息，掩盖它等于把可行动信息换成作者向诊断。
 */
function renderResultTextContent(
	result: { content: Array<{ type: string; text?: string }> },
	theme: Theme,
	context: EditToolRenderContext,
): Text {
	const message = result.content.map((part) => part.text ?? "").join("\n").trim();
	const title = theme.fg("toolTitle", theme.bold("edit"));
	return replaceWithText(context, message === "" ? title : `${title}\n${theme.fg("error", message)}`);
}

function entryItems(details: ScriptOutcome, theme: Theme) {
	return details.entries.map((entry) => {
		if (entry.status === "applied") {
			return fileResultItem({
				label: "",
				path: details.path,
				cwd: details.cwd,
				changeStats: entry.changeStats,
				display: entry.display,
				truncated: entry.truncated,
			}, theme, details.cwd);
		}
		if (entry.status === "failed") {
			return fileResultItem({
				label: "",
				path: details.path,
				cwd: details.cwd,
				changeStats: { additions: 0, deletions: 0, changedLines: 0 },
				display: { lineNumberWidth: 1, rows: [] },
				truncated: false,
				status: "failed",
				error: entry.error,
			}, theme, details.cwd);
		}
		return fileMutationPlanItem({
			label: "",
			path: details.path,
			cwd: details.cwd,
			changeStats: { additions: 0, deletions: 0, changedLines: 0 },
			note: "skipped",
		}, theme, details.cwd);
	});
}

/** 脚本状态词：applied 不加（条目行的 stats 已说明），失败态说清计数。 */
function scriptStatusWord(details: ScriptOutcome): string | undefined {
	if (details.status === "applied") return undefined;
	if (details.status === "rejected") return "rejected · nothing written";
	const applied = details.entries.filter((entry) => entry.status === "applied").length;
	const failed = details.entries.filter((entry) => entry.status === "failed").length;
	return `partial · ${applied} applied · ${failed} failed`;
}

/**
 * 结果渲染的唯一分流点。顺序即优先级：流式未完成 → 保持 pending；本扩展的条目
 * payload → 条目视图；其余（信封错误 / 旧版本 payload）→ 工具文本。
 */
export function renderResultView(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: EditToolRenderContext,
): Container | Text {
	if (options.isPartial && !isScriptOutcome(result.details)) return renderClearedCallState(context);
	if (!isScriptOutcome(result.details)) return renderResultTextContent(result, theme, context);
	return renderScriptResult(result.details, theme, context);
}

function renderScriptResult(
	details: ScriptOutcome,
	theme: Theme,
	context: EditToolRenderContext,
): Container | Text {
	const container = beginFileMutationResultRender(context);
	container.addChild(new Text(renderScriptTitle(details.note, theme, scriptStatusWord(details)), 0, 0));
	appendFileMutationBatch(container, entryItems(details, theme), theme, ENTRY_RAIL);
	return container;
}