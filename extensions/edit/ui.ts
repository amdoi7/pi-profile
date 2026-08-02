import { renderDiff, type ToolRenderContext, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Theme } from "@earendil-works/pi-tui";

import { renderDiffSummary, renderHiddenFooter } from "../_shared/code-preview.ts";
import { renderCwdFilePathLink } from "../_shared/file-link.ts";

import type { ResultToolViewModel, ToolViewModel } from "./pipeline.ts";

export type SharedToolRenderConfig = {
	toolLabel?: string;
};

type EditRenderState = {
	pendingCallComponent?: Container;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChangeStats(value: unknown): boolean {
	return isRecord(value) &&
		typeof value.additions === "number" &&
		typeof value.deletions === "number" &&
		typeof value.changedLines === "number";
}

function isFileResult(value: unknown): boolean {
	if (!isRecord(value) || typeof value.path !== "string") return false;
	if (value.status === "failed") {
		return typeof value.error === "string";
	}
	return value.status === "applied" &&
		typeof value.previewText === "string" &&
		typeof value.previewTruncated === "boolean" &&
		isChangeStats(value.changeStats);
}

function isRenderedResultPayload(value: unknown): value is ResultToolViewModel {
	return isRecord(value) &&
		value.kind === "result" &&
		isFileResult(value.file);
}

export function renderCallTitle(theme: Theme, config: SharedToolRenderConfig = {}): string {
	return theme.fg("toolTitle", theme.bold(config.toolLabel ?? "edit"));
}

function reusableContainer(context: ToolRenderContext): Container {
	const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();
	return container;
}

function pendingState(context: ToolRenderContext): EditRenderState {
	return context.state as EditRenderState;
}

export function renderClearedCallState(context: ToolRenderContext): Container {
	const container = reusableContainer(context);
	pendingState(context).pendingCallComponent = container;
	return container;
}

export function renderCallViewModel(
	viewModel: ToolViewModel,
	theme: Theme,
	context: ToolRenderContext,
	config: SharedToolRenderConfig = {},
): Container | Text {
	if (viewModel.kind === "invalid") {
		return new Text(`${renderCallTitle(theme, config)}\n${theme.fg("error", viewModel.message)}`, 0, 0);
	}

	const container = reusableContainer(context);
	container.addChild(new Text(
		`${renderCallTitle(theme, config)} file ${renderCwdFilePathLink(viewModel.path, viewModel.path, context.cwd, theme)}`,
		0,
		0,
	));
	pendingState(context).pendingCallComponent = container;
	return container;
}

function clearPendingCall(context: ToolRenderContext): void {
	pendingState(context).pendingCallComponent?.clear();
}

export function renderToolTextResult(
	result: { content: Array<{ type: string; text?: string }> },
	theme: Theme,
	context: ToolRenderContext,
): Text {
	clearPendingCall(context);
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const body = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
	text.setText(body.length > 0 ? theme.fg("toolOutput", body) : "");
	return text;
}

function renderFileResultTitle(
	file: ResultToolViewModel["file"],
	theme: Theme,
	context: ToolRenderContext,
	config: SharedToolRenderConfig,
): Text {
	const summary = file.status === "applied"
		? renderDiffSummary(file.changeStats, theme)
		: theme.fg("error", "failed");
	return new Text(
		`${renderCallTitle(theme, config)} file ${renderCwdFilePathLink(file.path, file.path, context.cwd, theme)}` +
		`${theme.fg("muted", " · ")}${summary}`,
		0,
		0,
	);
}

function renderFileResultBody(
	file: ResultToolViewModel["file"],
	theme: Theme,
): Text {
	if (file.status === "failed") {
		return new Text(theme.fg("error", file.error), 0, 0);
	}
	const body = file.previewText.length > 0
		? renderDiff(file.previewText)
		: theme.fg("toolOutput", file.summary ?? "");
	return new Text(body, 0, 0);
}

function renderFileResult(
	file: ResultToolViewModel["file"],
	theme: Theme,
	context: ToolRenderContext,
	config: SharedToolRenderConfig,
): Container {
	const block = new Container();
	block.addChild(renderFileResultTitle(file, theme, context, config));
	block.addChild(new Spacer(1));
	block.addChild(renderFileResultBody(file, theme));
	if (file.status === "applied" && file.previewTruncated) {
		block.addChild(new Text(renderHiddenFooter(1, "preview chunk", theme), 0, 0));
	}
	return block;
}

export function parseRenderedResultPayload(result: { details?: unknown }): ResultToolViewModel | undefined {
	return isRenderedResultPayload(result.details) ? result.details : undefined;
}

export function renderResultViewModel(
	viewModel: ResultToolViewModel,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
	config: SharedToolRenderConfig = {},
): Container {
	clearPendingCall(context);
	const container = reusableContainer(context);
	container.addChild(renderFileResult(viewModel.file, theme, context, config));
	return container;
}
