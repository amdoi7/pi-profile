import { type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
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
import { isRecord, type ApplyPatchPlan, type PatchOperation, type PlannedPatchOperation } from "./recognize.ts";
import {
	parseRenderedResultPayload,
	operationKindWord,
	type ApplyPatchUnapplied,
	type ApplyPatchFileDiff,
	type ApplyPatchSingleResultViewModel,
	type ApplyPatchResultViewModel,
} from "./view-model-codec.ts";

// 后续命令输出（pytest 等）预览：总量沿用 20 行，首尾各半以同时保留失败标题与 summary。
const TRAILING_PREVIEW_LINES = 20;

/**
 * 命令的 shell 前缀：heredoc body（`*** Begin Patch` 起）之前的 shell 部分。
 * 结构化 UI 已用操作头展示 patch 内容，command 行只显示 shell 命令（避免刷屏）。
 */
function shellPrefix(command: string): string {
	const bodyIndex = command.indexOf("*** Begin Patch");
	if (bodyIndex === -1) return command;
	const head = command.slice(0, bodyIndex);
	// heredoc：body 前是换行结尾的 shell 行；单引号形式：body 紧跟引号（截断后补 …）。
	return head.endsWith("\n") ? head.slice(0, -1) : `${head}…`;
}

export type PatchRenderContext = {
	args: { command: string };
	cwd: string;
	expanded: boolean;
	isError: boolean;
	state: Record<string, unknown>;
	lastComponent?: unknown;
};

/** 渲染态中读取 wall-clock 耗时（ms）。startedAt 缺失（session restore 等无渲染态场景）时不显示。 */
function elapsedMs(state: Record<string, unknown>, isPartial: boolean): number | undefined {
	const startedAt = state.startedAt;
	if (typeof startedAt !== "number") return undefined;
	const endedAt = state.endedAt;
	return (typeof endedAt === "number" ? endedAt : Date.now()) - startedAt;
}

function operationStats(operation: PatchOperation) {
	const additions = operation.lines.filter((line) => line.prefix === "+").length;
	const deletions = operation.lines.filter((line) => line.prefix === "-").length;
	return { additions, deletions, changedLines: additions + deletions };
}

function renderOperationPath(operation: PatchOperation, cwd: string, theme: Theme): string {
	const source = renderCwdFilePathLink(operation.path, operation.path, cwd, theme);
	if (!operation.destination) return source;
	const destination = renderCwdFilePathLink(operation.destination, operation.destination, cwd, theme);
	return `${source}${theme.fg("muted", " -> ")}${destination}`;
}

/**
 * 一行一个操作，edit 风格：`apply_patch <Kind> file <path> · +A -D`。
 * confirmed=false 时 Kind muted（计划，未发生）；true 时 success（CLI 已确认）。
 */
function renderOperationRow(
	operation: PatchOperation,
	cwd: string,
	theme: Theme,
	options: { indent: boolean },
): string {
	const parts = [
		`${options.indent ? "  " : ""}${theme.fg("toolTitle", theme.bold("apply_patch"))}`,
		theme.fg("muted", operationKindWord(operation)),
		"file",
		renderOperationPath(operation, cwd, theme),
	];
	const stats = operationStats(operation);
	if (stats.changedLines > 0) parts.push(renderDiffSummary(stats, theme));
	return parts.join(" ");
}

function operationRenderItem(
	planned: PlannedPatchOperation,
	cwd: string,
	theme: Theme,
	options: { indent: boolean },
): FileMutationRenderItem {
	return {
		title: renderOperationRow(planned.operation, cwd, theme, options),
		outcome: "pending",
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

/** pending UI：每行操作使用自己 invocation 的 cwd 做 file link。 */
export function renderPendingApplyPatch(
	plan: ApplyPatchPlan,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = beginPendingFileMutationRender(context);
	// 主命令行（pending 状态也保留 `$ <cmd>` 头，与 built-in 一致；heredoc body 用操作头展示）。
	const command = shellPrefix(context.args.command);
	if (command.length > 0) {
		container.addChild(new Text(renderShellCommandCall({ command }, theme), 0, 0));
		container.addChild(new Spacer(1));
	}
	const rows = plan.invocations.flatMap((invocation) =>
		invocation.operations.map((planned) => ({ planned, cwd: invocation.cwd })));
	const multiple = rows.length > 1;
	for (const { planned, cwd } of rows) {
		appendFileMutationBatch(container, [
			operationRenderItem(planned, cwd, theme, { indent: multiple }),
		], theme);
		for (const chunk of planned.operation.chunks ?? []) {
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
		`${renderCwdFilePathLink(displayPath, linkTarget, file.cwd, theme)}` +
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
		// key 含 cwd：不同 invocation 目录下同名 relative path 不聚合。
		const key = JSON.stringify([file.kind, file.path, file.destination, file.cwd]);
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
): Text {
	const displayPath = item.destination ? `${item.path} -> ${item.destination}` : item.path;
	return new Text(
		`  ${theme.fg("muted", item.kind)} file ${renderCwdFilePathLink(displayPath, item.destination ?? item.path, item.cwd, theme)}`,
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
			`${theme.fg("error", "failed update")} ${renderCwdFilePathLink(viewModel.error.path, viewModel.error.path, viewModel.error.cwd ?? context.cwd, theme)}${chunk}`,
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
			const path = item.path
				? ` ${renderCwdFilePathLink(item.path, item.path, item.cwd ?? context.cwd, theme)}`
				: "";
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
			container.addChild(renderUnappliedRow(item, theme));
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
	// 主命令行（与 built-in bash 一致：结果上方保留 `$ <cmd>` 头；heredoc body 用操作头展示）。
	const command = shellPrefix(context.args.command);
	if (command.length > 0) {
		container.addChild(new Text(renderShellCommandCall({ command }, theme), 0, 0));
		container.addChild(new Spacer(1));
	}
	// 聚合 diff 是 intent（无快照）时无净变更可展示，expanded 展开每个 invocation；
	// located 聚合（有快照，净 diff）在 collapsed 与 expanded 都显示聚合。
	const aggregatedIsIntent = viewModel.kind === "apply-patch-batch-result" && viewModel.finalFiles !== undefined &&
		viewModel.finalFiles.some((file) => file.isIntent === true);
	if (viewModel.kind === "apply-patch-batch-result" && viewModel.finalFiles && (!options.expanded || !aggregatedIsIntent)) {
		appendFileMutationBatch(
			container,
			viewModel.finalFiles.map((file) => fileResultItem(file, theme, context, file.patchCount)),
			theme,
		);
	} else if (viewModel.kind === "apply-patch-batch-result" && options.expanded) {
		viewModel.results.forEach((result, index) => {
			if (index > 0) container.addChild(new Spacer(1));
			renderSingleResultViewModel(container, result, options, theme, context);
		});
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
	// 耗时独立行（wall-clock，与 built-in 一致：partial 时 Elapsed + 1s tick，最终/错误 Took）。
	// 渲染态缺失时无耗时行；不解析 CLI 输出文本（apply_patch 从不自报耗时）。
	if (viewModel.trailing.trim().length > 0) {
		renderTrailing(container, viewModel.trailing, options.expanded, theme, viewModel.trailingCommand ?? "");
	}
	const ms = elapsedMs(context.state, options.isPartial);
	if (ms !== undefined) {
		container.addChild(new Text(theme.fg("muted", `${options.isPartial ? "Elapsed" : "Took"} ${(ms / 1000).toFixed(1)}s`), 0, 0));
	}
	return container;
}

export function parseRenderedResultPayloadFromDetails(details: unknown): ApplyPatchResultViewModel | undefined {
	// tool_result 注入契约：{ ...builtinDetails, bashUi: { applyPatch: viewModel } }。
	// 无 bashUi 命名空间（普通命令 / 未识别结果）时返回 undefined，渲染层 delegate built-in。
	if (!isRecord(details) || !isRecord(details.bashUi)) return undefined;
	return parseRenderedResultPayload(details.bashUi.applyPatch);
}
