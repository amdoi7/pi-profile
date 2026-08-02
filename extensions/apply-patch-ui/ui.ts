import { readFileSync } from "node:fs";

import { type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

import { renderDiffSummary, renderShellCommandCall } from "../_shared/code-preview.ts";
import type { DiffPreview } from "../_shared/diff-view.ts";
import {
	appendFileMutationBatch,
	beginFileMutationResultRender,
	beginPendingFileMutationRender,
	type FileMutationRenderItem,
} from "../_shared/file-mutation-view.ts";
import { renderCwdFilePathLink } from "../_shared/file-link.ts";
import { displayDiffFromLines, generateFinalDiff } from "../_shared/final-diff.ts";
import { operationByIndex, trailingCommandAfterApplyPatches, type ParsedPatch, type PatchOperation } from "./patch-command.ts";
import {
	changeMatchesOperation,
	parseRenderedResultPayload,
	operationKindWord,
	type ApplyPatchUnapplied,
	type ApplyPatchFileDiff,
	type ApplyPatchSingleResultViewModel,
	type ApplyPatchResultViewModel,
	type BeforeSnapshots,
	PATCH_DIFF_CONTEXT_LINES,
} from "./view-model.ts";
import {
	failureMatchesPatch,
	parseApplyPatchFailure,
	parseElapsedSeconds,
	parseSuccessfulChanges,
	resultText,
	successMatchesPatch,
	trailingAfterFailure,
	trailingAfterSuccess,
	type ApplyPatchFailure,
	parseApplyPatchResultSequence,
	type SuccessfulChange,
} from "./patch-result.ts";

// 耗时显示阈值：正常本地 apply_patch 是毫秒级文件写，远低于 1s；
// 超过 2s 说明大 patch / 慢盘 / 锁竞争，值得作为诊断信号显示（tripwire，正常流量不触发）。
const ELAPSED_SHOW_THRESHOLD_S = 2;

// 后续命令输出（pytest 等）预览：总量沿用 20 行，首尾各半以同时保留失败标题与 summary。
const TRAILING_PREVIEW_LINES = 20;

export type PatchRenderContext = {
	args: { command: string };
	cwd: string;
	expanded: boolean;
	isError: boolean;
	state: Record<string, unknown>;
	lastComponent?: unknown;
	/** execute 前捕获的 before 快照（行号 diff 用）；undefined = 未捕获（非 TUI / 未识别）。 */
	beforeSnapshots?: BeforeSnapshots;
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

/**
 * 一行一个操作，edit 风格：`apply_patch <Kind> file <path> · N changed · +A · -D`。
 * confirmed=false 时 Kind muted（计划，未发生）；true 时 success（CLI 已确认）。
 */
function renderOperationRow(
	operation: PatchOperation,
	theme: Theme,
	context: PatchRenderContext,
	options: { confirmed: boolean; indent: boolean },
): string {
	const word = theme.fg(options.confirmed ? "success" : "muted", operationKindWord(operation));
	const parts = [
		`${options.indent ? "  " : ""}${theme.fg("toolTitle", theme.bold("apply_patch"))}`,
		word,
		"file",
		renderOperationPath(operation, theme, context),
	];
	const stats = operationStats(operation);
	if (stats.changedLines > 0) parts.push(renderDiffSummary(stats, theme));
	return parts.join(" ");
}

function operationIntentPreview(operation: PatchOperation): DiffPreview | undefined {
	if (operation.lines.length === 0) return undefined;
	return {
		display: displayDiffFromLines(operation.lines),
		truncated: false,
	};
}

/**
 * 行号 diff：before 来自 execute 前快照，after 实时读取当前文件。
 * 快照缺失（渲染时文件不可读）时回退意图 diff。
 */
function operationPreview(
	operation: PatchOperation,
	context: PatchRenderContext,
): DiffPreview | undefined {
	const snapshots = context.beforeSnapshots;
	const beforeSnapshot = snapshots?.get(operation.path);
	if (!beforeSnapshot || !snapshots) return operationIntentPreview(operation);
	const afterPath = operation.destination ?? operation.path;
	const afterSnapshot = snapshots.get(afterPath);
	let after: string | null = null;
	if (afterSnapshot) {
		try {
			after = readFileSync(afterSnapshot.absolutePath, "utf8");
		} catch {
			// 文件不存在（delete 目标等）：after 为 null。
		}
	}
	const diff = generateFinalDiff(beforeSnapshot.before ?? "", after ?? "", PATCH_DIFF_CONTEXT_LINES);
	if (diff.stats.changedLines === 0) return operationIntentPreview(operation);
	return { display: diff.display, truncated: diff.truncated };
}

function operationRenderItem(
	operation: PatchOperation,
	theme: Theme,
	context: PatchRenderContext,
	options: { confirmed: boolean; indent: boolean; preview: boolean },
): FileMutationRenderItem {
	const preview = options.preview ? operationPreview(operation, context) : undefined;
	const title = renderOperationRow(operation, theme, context, options);
	if (!options.confirmed) {
		return { title, outcome: "pending" };
	}
	return {
		title,
		outcome: "applied",
		previews: preview ? [preview] : [],
	};
}

function renderTrailing(
	container: Container,
	trailing: string,
	expanded: boolean,
	theme: Theme,
	command = "",
): void {
	const lines = trailing.split("\n");
	container.addChild(new Spacer(1));
	if (command) container.addChild(new Text(renderShellCommandCall({ command }, theme), 0, 0));
	if (expanded || lines.length <= TRAILING_PREVIEW_LINES) {
		container.addChild(new Text(theme.fg("toolOutput", lines.join("\n")), 0, 0));
		return;
	}
	const head = Math.ceil(TRAILING_PREVIEW_LINES / 2);
	const tail = TRAILING_PREVIEW_LINES - head;
	const skipped = lines.length - TRAILING_PREVIEW_LINES;
	container.addChild(new Text(theme.fg("toolOutput", lines.slice(0, head).join("\n")), 0, 0));
	container.addChild(new Text(theme.fg("muted", `... ${skipped} output lines hidden in middle, expand to view`), 0, 0));
	container.addChild(new Text(theme.fg("toolOutput", lines.slice(-tail).join("\n")), 0, 0));
}

export function renderPendingApplyPatch(
	patch: ParsedPatch,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = beginPendingFileMutationRender(context);
	const multiple = patch.operations.length > 1;
	for (const operation of patch.operations) {
		appendFileMutationBatch(container, [
			operationRenderItem(operation, theme, context, { confirmed: false, indent: multiple, preview: false }),
		], theme);
		for (const chunk of operation.chunks ?? []) {
			if (chunk.lines.some((line) => line.prefix === "+" || line.prefix === "-")) continue;
			container.addChild(new Text(
				theme.fg("warning", `  chunk ${chunk.index} · no +/- lines · must contain an insertion or deletion`),
				0,
				0,
			));
		}
	}
	return container;
}

function filePreview(file: ApplyPatchFileDiff): DiffPreview {
	return { display: file.diffDisplay, truncated: file.diffTruncated };
}

function fileResultItem(
	file: ApplyPatchFileDiff,
	theme: Theme,
	context: PatchRenderContext,
	patchCount = 1,
	previews?: DiffPreview[],
): FileMutationRenderItem {
	const defaultPreview = filePreview(file);
	const resolvedPreviews = previews ?? [defaultPreview];
	const displayPath = file.destination ? `${file.path}${theme.fg("muted", " -> ")}${file.destination}` : file.path;
	const linkTarget = file.destination ?? file.path;
	const count = patchCount > 1 ? theme.fg("muted", ` · ${patchCount} patches`) : "";
	return {
		title: `${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("success", file.kind)} file ` +
		`${renderCwdFilePathLink(displayPath, linkTarget, context.cwd, theme)}` +
		`${theme.fg("muted", " · ")}${renderDiffSummary(file.changeStats, theme)}${count}`,
		outcome: "applied",
		previews: resolvedPreviews,
	};
}

type AggregatedSuccessfulFile = {
	file: ApplyPatchFileDiff;
	patchCount: number;
	previews: DiffPreview[];
};

function aggregateSuccessfulFiles(files: ApplyPatchFileDiff[]): AggregatedSuccessfulFile[] {
	const aggregated = new Map<string, AggregatedSuccessfulFile>();
	for (const file of files) {
		const key = JSON.stringify([file.kind, file.path, file.destination]);
		const current = aggregated.get(key);
		if (!current) {
			const preview = filePreview(file);
			aggregated.set(key, { file: { ...file }, patchCount: 1, previews: [preview] });
			continue;
		}
		current.file.changeStats = {
			additions: current.file.changeStats.additions + file.changeStats.additions,
			deletions: current.file.changeStats.deletions + file.changeStats.deletions,
			changedLines: current.file.changeStats.changedLines + file.changeStats.changedLines,
		};
		const preview = filePreview(file);
		current.previews.push(preview);
		current.patchCount += 1;
	}
	return [...aggregated.values()];
}

function renderUnappliedRow(
	item: ApplyPatchUnapplied,
	theme: Theme,
	context: PatchRenderContext,
): Text {
	const displayPath = item.destination ? `${item.path} -> ${item.destination}` : item.path;
	return new Text(
		`  ${theme.fg("muted", item.kind)} file ${renderCwdFilePathLink(displayPath, item.destination ?? item.path, context.cwd, theme)}`,
		0,
		0,
	);
}

function renderFailureViewModel(
	container: Container,
	viewModel: Extract<ApplyPatchSingleResultViewModel, { success: false }>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
): void {
	container.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("error", `failed ${viewModel.error.code}`)}`,
		0,
		0,
	));
	container.addChild(new Text(theme.fg("error", viewModel.error.message), 0, 0));
	if (viewModel.error.path) {
		const chunk = viewModel.error.chunkIndex === undefined ? "" : ` ${theme.fg("muted", `· chunk ${viewModel.error.chunkIndex}`)}`;
		container.addChild(new Text(
			`${theme.fg("error", "failed update")} ${renderCwdFilePathLink(viewModel.error.path, viewModel.error.path, context.cwd, theme)}${chunk}`,
			0,
			0,
		));
	}
	if (viewModel.applied.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("success", "applied:"), 0, 0));
		appendFileMutationBatch(container, viewModel.applied.map((file) => fileResultItem(file, theme, context)), theme);
	}
	if (viewModel.skipped.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("error", "skipped:"), 0, 0));
		for (const item of viewModel.skipped) {
			const operation = item.operation ? `${item.operation[0]!.toUpperCase()}${item.operation.slice(1)}` : "Operation";
			const path = item.path ? ` ${renderCwdFilePathLink(item.path, item.path, context.cwd, theme)}` : "";
			container.addChild(new Text(`  ${theme.fg("error", `${operation} file`)}${path}`, 0, 0));
			container.addChild(new Text(`    ${theme.fg("muted", item.message)}`, 0, 0));
		}
	}
	if (viewModel.contextMismatch && options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("warning", "expected:"), 0, 0));
		for (const line of viewModel.contextMismatch.expectedLines) {
			container.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
		}
		container.addChild(new Text(theme.fg("warning", "actual:"), 0, 0));
		for (const line of viewModel.contextMismatch.actualLines) {
			container.addChild(new Text(theme.fg("toolOutput", `  ${line}`), 0, 0));
		}
		if (viewModel.contextMismatch.actualTruncated) {
			container.addChild(new Text(theme.fg("muted", "  ... file truncated"), 0, 0));
		}
	}
	if (viewModel.unapplied.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "unapplied:"), 0, 0));
		for (const item of viewModel.unapplied) {
			container.addChild(renderUnappliedRow(item, theme, context));
		}
	}
}

function renderSingleResultViewModel(
	container: Container,
	viewModel: ApplyPatchSingleResultViewModel,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
): void {
	if (viewModel.success) {
		appendFileMutationBatch(container, viewModel.files.map((file) => fileResultItem(file, theme, context)), theme);
		return;
	}
	renderFailureViewModel(container, viewModel, options, theme, context);
}

/** 结果渲染主入口：消费 tool_result 注入的结构化 view model。 */
export function renderResultViewModel(
	viewModel: ApplyPatchResultViewModel,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = beginFileMutationResultRender(context);
	if (viewModel.kind === "apply-patch-batch-result" && options.expanded) {
		viewModel.results.forEach((result, index) => {
			if (index > 0) container.addChild(new Spacer(1));
			renderSingleResultViewModel(container, result, options, theme, context);
		});
	} else if (viewModel.kind === "apply-patch-batch-result" && viewModel.finalFiles) {
		appendFileMutationBatch(
			container,
			viewModel.finalFiles.map((file) => fileResultItem(file, theme, context, file.patchCount)),
			theme,
		);
	} else if (viewModel.kind === "apply-patch-batch-result") {
		const successfulFiles: ApplyPatchFileDiff[] = [];
		let hasRendered = false;
		const flushSuccessfulFiles = () => {
			if (successfulFiles.length === 0) return;
			if (hasRendered) container.addChild(new Spacer(1));
			appendFileMutationBatch(
				container,
				aggregateSuccessfulFiles(successfulFiles)
					.map(({ file, patchCount, previews }) => fileResultItem(file, theme, context, patchCount, previews)),
				theme,
			);
			successfulFiles.length = 0;
			hasRendered = true;
		};
		for (const result of viewModel.results) {
			if (result.success) {
				successfulFiles.push(...result.files);
				continue;
			}
			flushSuccessfulFiles();
			if (hasRendered) container.addChild(new Spacer(1));
			renderFailureViewModel(container, result, options, theme, context);
			hasRendered = true;
		}
		flushSuccessfulFiles();
	} else {
		renderSingleResultViewModel(container, viewModel, options, theme, context);
	}
	if (viewModel.trailing.trim().length > 0) {
		renderTrailing(container, viewModel.trailing, options.expanded, theme, trailingCommandAfterApplyPatches(context.args.command));
	}
	return container;
}

export function parseRenderedResultPayloadFromDetails(details: unknown): ApplyPatchResultViewModel | undefined {
	return parseRenderedResultPayload(details);
}

// ============================================================================
// isPartial 流式回退：text 解析渲染（bash 长尾期间及时显示）
// ============================================================================

function renderSuccess(
	patch: ParsedPatch,
	changes: SuccessfulChange[],
	options: ToolRenderResultOptions,
	text: string,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = new Container();
	const multiple = patch.operations.length > 1;
	const items: FileMutationRenderItem[] = [];
	for (const change of changes) {
		const operation = patch.operations.find((op) => changeMatchesOperation(change, op));
		if (!operation) continue;
		items.push(operationRenderItem(operation, theme, context, { confirmed: true, indent: multiple, preview: true }));
	}
	appendFileMutationBatch(container, items, theme);
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", text), 0, 0));
		return container;
	}
	const elapsed = parseElapsedSeconds(text);
	if (elapsed !== undefined && elapsed > ELAPSED_SHOW_THRESHOLD_S) {
		container.addChild(new Text(theme.fg("muted", `elapsed ${elapsed.toFixed(1)}s`), 0, 0));
	}
	const trailing = trailingAfterSuccess(text);
	if (trailing.trim().length > 0) {
		renderTrailing(container, trailing, false, theme, trailingCommandAfterApplyPatches(context.args.command));
	}
	return container;
}

function renderFailure(
	patch: ParsedPatch,
	failure: ApplyPatchFailure,
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
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("success", "applied:"), 0, 0));
		container.addChild(new Spacer(1));
		appendFileMutationBatch(
			container,
			failure.appliedPrefix.map((change) => operationRenderItem(
				operationByIndex(patch, change.index)!,
				theme,
				context,
				{ confirmed: true, indent: true, preview: true },
			)),
			theme,
		);
	}
	if (failure.skipped.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("error", "skipped:"), 0, 0));
		container.addChild(new Spacer(1));
		for (const skip of failure.skipped) {
			const operation = skip.operation ? `${skip.operation[0]!.toUpperCase()}${skip.operation.slice(1)}` : "Operation";
			const path = skip.path ? ` ${renderCwdFilePathLink(skip.path, skip.path, context.cwd, theme)}` : "";
			container.addChild(new Text(`  ${theme.fg("error", `${operation} file`)}${path}`, 0, 0));
			container.addChild(new Text(`    ${theme.fg("muted", skip.message)}`, 0, 0));
		}
	}
	const appliedIndexes = new Set(failure.appliedPrefix.map((change) => change.index));
	const skippedIndexes = new Set(failure.skipped.map((skip) => skip.index));
	const unapplied = patch.operations.filter(
		(operation) => !appliedIndexes.has(operation.index) && !skippedIndexes.has(operation.index),
	);
	if (unapplied.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "unapplied:"), 0, 0));
		container.addChild(new Spacer(1));
		for (const operation of unapplied) {
			container.addChild(new Text(renderOperationRow(operation, theme, context, { confirmed: false, indent: true }), 0, 0));
		}
	}
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", text), 0, 0));
		return container;
	}
	const trailing = trailingAfterFailure(text);
	if (trailing.trim().length > 0) {
		renderTrailing(container, trailing, false, theme, trailingCommandAfterApplyPatches(context.args.command));
	}
	return container;
}

/** isPartial 流式回退：无 view model（tool_result 未触发）时解析文本渲染。 */
export function renderApplyPatchResult(
	patches: ParsedPatch[],
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
): Container | undefined {
	const text = resultText(result);
	if (patches.length > 1) {
		const sequence = parseApplyPatchResultSequence(text);
		if (!sequence || sequence.results.length !== patches.length) return undefined;
		const container = new Container();
		for (const [index, parsed] of sequence.results.entries()) {
			if (index > 0) container.addChild(new Spacer(1));
			const patch = patches[index]!;
			const matches = parsed.success
				? successMatchesPatch(patch, parsed.changes)
				: failureMatchesPatch(patch, parsed.failure);
			if (!matches) return undefined;
			container.addChild(parsed.success
				? renderSuccess(patch, parsed.changes, options, parsed.text, theme, context)
				: renderFailure(patch, parsed.failure, options, parsed.text, theme, context));
		}
		if (sequence.trailing.trim().length > 0) {
			renderTrailing(container, sequence.trailing, options.expanded, theme, trailingCommandAfterApplyPatches(context.args.command));
		}
		return container;
	}
	const patch = patches[0];
	if (!patch) return undefined;
	// 失败识别不依赖 isError：apply_patch 失败后后续命令（echo/cat 等）可能让 bash
	// 整体 exit 0（isError=false），但 CLI 失败 JSON 仍是事实，必须渲染失败 UI。
	const failure = parseApplyPatchFailure(text);
	if (failure && failureMatchesPatch(patch, failure)) {
		return renderFailure(patch, failure, options, text, theme, context);
	}
	if (context.isError) return undefined;
	const changes = parseSuccessfulChanges(text);
	return changes && successMatchesPatch(patch, changes)
		? renderSuccess(patch, changes, options, text, theme, context)
		: undefined;
}
