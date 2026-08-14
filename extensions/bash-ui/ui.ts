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
import { fileMutationPlanItem, fileResultItem } from "../_shared/file-result.ts";
import { renderCwdFilePathLink } from "../_shared/file-link.ts";
import { isRecord, type ApplyPatchPlan, type BashCommandPlan, type InPlaceEditPlan, type PatchOperation, type PlannedPatchOperation } from "./recognize.ts";
import {
	parseInPlaceEditResultPayload,
	parseRenderedResultPayload,
	operationKindWord,
	type ApplyPatchUnapplied,
	type ApplyPatchFileDiff,
	type ApplyPatchSingleResultViewModel,
	type ApplyPatchResultViewModel,
	type BashResultViewModel,
	type InPlaceEditResultViewModel,
} from "./view-model-codec.ts";

// 后续命令输出（pytest 等）预览：总量沿用 20 行，首尾各半以同时保留失败标题与 summary。
const TRAILING_PREVIEW_LINES = 20;

/** 段状态：决定段背景色与徽标标记。in-place edit 无显式 success 字段：有快照 diff 即成功。 */
type SegmentStatus = "success" | "error" | "neutral";

function segmentStatus(viewModel: BashResultViewModel): SegmentStatus {
	if (viewModel.kind === "in-place-edit-result") {
		return viewModel.files.length > 0 ? "success" : "neutral";
	}
	if (viewModel.kind === "apply-patch-batch-result") {
		return viewModel.results.some((result) => !result.success) ? "error" : "success";
	}
	return viewModel.success ? "success" : "error";
}

function segmentBgFn(status: SegmentStatus, theme: Theme): ((text: string) => string) | undefined {
	if (status === "success") return (text) => theme.bg("toolSuccessBg", text);
	if (status === "error") return (text) => theme.bg("toolErrorBg", text);
	return undefined;
}

/**
 * 段体行左侧状态色条（2 格）：段状态可见而内容行保持无背景，
 * diff/命令高亮不被段背景色淹没。段头徽标行才用整行背景。
 */
function segmentRail(bgFn: ((text: string) => string) | undefined): string {
	return bgFn ? bgFn("  ") : "";
}

function pluralInvocation(n: number): string {
	return ` · ${n} ${n === 1 ? "invocation" : "invocations"}`;
}

/** 段头徽标行（多段时）：`[apply_patch · 2 invocations] ✓` / `✗ CONTEXT_NOT_FOUND`。 */
function segmentHeaderLine(
	viewModel: BashResultViewModel,
	count: number,
	theme: Theme,
): string | undefined {
	if (count <= 1) return undefined;
	const label = viewModel.kind === "in-place-edit-result" ? "in-place edit" : "apply_patch";
	const invocations = viewModel.kind === "apply-patch-batch-result"
		? pluralInvocation(viewModel.results.length)
		: viewModel.kind === "apply-patch-result"
			? pluralInvocation(1)
			: "";
	const badge = theme.fg("toolTitle", `[${label}${invocations}]`);
	const status = segmentStatus(viewModel);
	if (status === "neutral") return badge;
	if (status === "success") return `${badge} ${theme.fg("success", "✓")}`;
	const errorCode = viewModel.kind === "apply-patch-batch-result"
		? viewModel.results.find((result) => !result.success)?.error.code
		: viewModel.kind === "apply-patch-result" && !viewModel.success
			? viewModel.error.code
			: undefined;
	const code = errorCode === undefined ? "" : ` ${errorCode}`;
	return `${badge} ${theme.fg("error", `✗${code}`)}`;
}

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

/** 一行一个操作的计划项（pending）：`apply_patch <Kind> file <path> · +A -D`（Kind muted，计划未发生）。 */
function operationRenderItem(
	planned: PlannedPatchOperation,
	cwd: string,
	theme: Theme,
	options: { indent: boolean },
): FileMutationRenderItem {
	const operation = planned.operation;
	return fileMutationPlanItem({
		label: "apply_patch",
		kind: operationKindWord(operation),
		path: operation.path,
		destination: operation.destination,
		cwd,
		changeStats: operationStats(operation),
	}, theme, cwd, options.indent);
}

function renderTrailing(
	container: Container,
	trailing: string,
	expanded: boolean,
	theme: Theme,
	command = "",
	bgFn?: (text: string) => string,
): void {
	const rail = segmentRail(bgFn);
	const lines = trailing.split("\n");
	container.addChild(new Spacer(1));
	if (command) container.addChild(new Text(rail + renderShellCommandCall({ command }, theme), 0, 0));
	if (expanded || lines.length <= TRAILING_PREVIEW_LINES) {
		container.addChild(new Text(rail + theme.fg("toolOutput", lines.join("\n")), 0, 0));
		return;
	}
	const head = Math.ceil(TRAILING_PREVIEW_LINES / 2);
	const tail = TRAILING_PREVIEW_LINES - head;
	const skipped = lines.length - TRAILING_PREVIEW_LINES;
	container.addChild(new Text(rail + theme.fg("toolOutput", lines.slice(0, head).join("\n")), 0, 0));
	container.addChild(new Text(rail + theme.fg("muted", `... ${skipped} output lines hidden in middle, expand to view`), 0, 0));
	container.addChild(new Text(rail + theme.fg("toolOutput", lines.slice(-tail).join("\n")), 0, 0));
}

/** pending 段行（apply_patch 段）：每行操作使用自己 invocation 的 cwd 做 file link。 */
function appendPendingApplyPatchRows(container: Container, plan: ApplyPatchPlan, theme: Theme): void {
	const rows = plan.invocations.flatMap((invocation) =>
		invocation.operations.map((planned) => ({ planned, cwd: invocation.cwd })));
	const multiple = plan.invocations.length > 1 || rows.length > 1;
	for (const invocation of plan.invocations) {
		if (invocation.operations.length === 0) {
			// 形态合法但内容无法解析（bash 语法层不承诺 apply_patch 格式层）：原样执行，CLI 裁决。
			container.addChild(new Text(theme.fg("warning", `${multiple ? "  " : ""}apply_patch · patch 内容无法解析（原样执行）`), 0, 0));
			continue;
		}
		for (const planned of invocation.operations) {
			appendFileMutationBatch(container, [
				operationRenderItem(planned, invocation.cwd, theme, { indent: multiple }),
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
	}
}

/** pending 段行（in-place edit 段）：每行一个编辑，文件链接用 edit 自己的 cwd。 */
function appendPendingInPlaceEditRows(container: Container, plan: InPlaceEditPlan, theme: Theme): void {
	const multiple = plan.edits.length > 1;
	for (const edit of plan.edits) {
		const files = edit.displayFiles.map((file) => renderCwdFilePathLink(file, file, edit.cwd, theme)).join(" ");
		container.addChild(new Text([
			`${multiple ? "  " : ""}${theme.fg("toolTitle", theme.bold(edit.displayCommand))}`,
			"file",
			files,
		].join(" "), 0, 0));
	}
}

/** pending 段头（多段时）：`[apply_patch · 2 invocations] …`。 */
function pendingSegmentHeaderLine(
	plan: BashCommandPlan,
	count: number,
	theme: Theme,
): string | undefined {
	if (count <= 1) return undefined;
	const label = plan.kind === "apply-patch" ? "apply_patch" : "in-place edit";
	const units = plan.kind === "apply-patch" ? plan.invocations.length : plan.edits.length;
	const unitWord = plan.kind === "apply-patch"
		? units === 1 ? "invocation" : "invocations"
		: units === 1 ? "edit" : "edits";
	return `${theme.fg("toolTitle", `[${label} · ${units} ${unitWord}]`)} ${theme.fg("muted", "…")}`;
}

/** pending UI：段队列一个容器一个 `$ <cmd>` 头（heredoc body 用操作头展示），段行按队列顺序追加。 */
export function renderPendingPlans(
	plans: readonly BashCommandPlan[],
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = beginPendingFileMutationRender(context);
	const command = shellPrefix(context.args.command);
	if (command.length > 0) {
		container.addChild(new Text(renderShellCommandCall({ command }, theme), 0, 0));
		container.addChild(new Spacer(1));
	}
	for (const [index, plan] of plans.entries()) {
		const header = pendingSegmentHeaderLine(plan, plans.length, theme);
		if (header !== undefined) container.addChild(new Text(header, 0, 0));
		if (plan.kind === "apply-patch") appendPendingApplyPatchRows(container, plan, theme);
		else appendPendingInPlaceEditRows(container, plan, theme);
	}
	return container;
}

function filePreview(file: ApplyPatchFileDiff): DiffPreview {
	return { display: file.display, truncated: file.truncated };
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
	bgFn?: (text: string) => string,
): Text {
	const rail = segmentRail(bgFn);
	const displayPath = item.destination ? `${item.path} -> ${item.destination}` : item.path;
	return new Text(
		rail + `  ${theme.fg("muted", item.kind)} file ${renderCwdFilePathLink(displayPath, item.destination ?? item.path, item.cwd, theme)}`,
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
	bgFn?: (text: string) => string,
): void {
	const rail = segmentRail(bgFn);
	container.addChild(new Text(
		rail + `${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("error", `failed ${viewModel.error.code}`)}`,
		0,
		0,
	));
	container.addChild(new Text(rail + theme.fg("error", viewModel.error.message), 0, 0));
	if (viewModel.error.path) {
		const chunk = viewModel.error.chunkIndex === undefined ? "" : ` ${theme.fg("muted", `· chunk ${viewModel.error.chunkIndex}`)}`;
		container.addChild(new Text(
			rail + `${theme.fg("error", "failed update")} ${renderCwdFilePathLink(viewModel.error.path, viewModel.error.path, viewModel.error.cwd ?? context.cwd, theme)}${chunk}`,
			0,
			0,
		));
	}
	if (viewModel.applied.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(rail + theme.fg("success", "applied:"), 0, 0));
		appendFileMutationBatch(container, viewModel.applied.map((file) => fileResultItem(file, theme, file.cwd)), theme, rail);
	}
	if (viewModel.skipped.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(rail + theme.fg("error", "skipped:"), 0, 0));
		for (const item of viewModel.skipped) {
			const operation = item.operation ? `${item.operation[0]!.toUpperCase()}${item.operation.slice(1)}` : "Operation";
			const path = item.path
				? ` ${renderCwdFilePathLink(item.path, item.path, item.cwd ?? context.cwd, theme)}`
				: "";
			container.addChild(new Text(rail + `  ${theme.fg("error", `${operation} file`)}${path}`, 0, 0));
			container.addChild(new Text(rail + `    ${theme.fg("muted", item.message)}`, 0, 0));
		}
	}
	if (viewModel.contextMismatch && options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(rail + theme.fg("warning", "expected:"), 0, 0));
		for (const line of viewModel.contextMismatch.expectedLines) {
			container.addChild(new Text(rail + theme.fg("dim", `  ${line}`), 0, 0));
		}
		container.addChild(new Text(rail + theme.fg("warning", "actual:"), 0, 0));
		for (const line of viewModel.contextMismatch.actualLines) {
			container.addChild(new Text(rail + theme.fg("toolOutput", `  ${line}`), 0, 0));
		}
		if (viewModel.contextMismatch.actualTruncated) {
			container.addChild(new Text(rail + theme.fg("muted", "  ... file truncated"), 0, 0));
		}
	}
	if (viewModel.unapplied.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(rail + theme.fg("muted", "unapplied:"), 0, 0));
		for (const item of viewModel.unapplied) {
			container.addChild(renderUnappliedRow(item, theme, bgFn));
		}
	}
}

function renderSingleResultViewModel(
	container: Container,
	viewModel: ApplyPatchSingleResultViewModel,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
	bgFn?: (text: string) => string,
): void {
	const rail = segmentRail(bgFn);
	if (viewModel.success) {
		appendFileMutationBatch(container, viewModel.files.map((file) => fileResultItem(file, theme, file.cwd)), theme, rail);
		return;
	}
	renderFailureViewModel(container, viewModel, options, theme, context, bgFn);
}

/** in-place-edit 段结果 body：快照真实 diff 行 + 原生命令输出；label 归因真实工具（perl edit / sed edit）。 */
function appendInPlaceEditResultBody(
	container: Container,
	viewModel: InPlaceEditResultViewModel,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
	bgFn?: (text: string) => string,
): void {
	const rail = segmentRail(bgFn);
	appendFileMutationBatch(container, viewModel.files.map((file) => fileResultItem(file, theme, file.cwd)), theme, rail);
	if (viewModel.output.trim().length > 0) {
		renderTrailing(container, viewModel.output, options.expanded, theme, "", bgFn);
	}
}

/** apply_patch 段结果 body：聚合/展开/单结果分支 + trailing 输出。 */
function appendApplyPatchResultBody(
	container: Container,
	viewModel: ApplyPatchResultViewModel,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
	bgFn?: (text: string) => string,
): void {
	const rail = segmentRail(bgFn);
	// 聚合 diff 是 intent（无快照）时无净变更可展示，expanded 展开每个 invocation；
	// located 聚合（有快照，净 diff）在 collapsed 与 expanded 都显示聚合。
	const aggregatedIsIntent = viewModel.kind === "apply-patch-batch-result" && viewModel.finalFiles !== undefined &&
		viewModel.finalFiles.some((file) => file.isIntent === true);
	if (viewModel.kind === "apply-patch-batch-result" && viewModel.finalFiles && (!options.expanded || !aggregatedIsIntent)) {
		appendFileMutationBatch(
			container,
			viewModel.finalFiles.map((file) => fileResultItem(file, theme, file.cwd)),
			theme,
			rail,
		);
	} else if (viewModel.kind === "apply-patch-batch-result" && options.expanded) {
		viewModel.results.forEach((result, index) => {
			if (index > 0) container.addChild(new Spacer(1));
			renderSingleResultViewModel(container, result, options, theme, context, bgFn);
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
					.map(({ file, previews }) => fileResultItem(file, theme, file.cwd, previews)),
				theme,
				rail,
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
			renderFailureViewModel(container, result, options, theme, context, bgFn);
			hasRendered = true;
		}
		flushSuccessfulFiles();
	} else {
		renderSingleResultViewModel(container, viewModel, options, theme, context, bgFn);
	}
	if (viewModel.trailing.trim().length > 0) {
		renderTrailing(container, viewModel.trailing, options.expanded, theme, viewModel.trailingCommand ?? "", bgFn);
	}
}

/** 结果渲染主入口：段队列一个容器一个 `$ <cmd>` 头，段 VM body 按队列顺序堆叠，耗时独立一行。 */
export function renderResultViewModel(
	viewModels: readonly BashResultViewModel[],
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PatchRenderContext,
): Container {
	const container = beginFileMutationResultRender(context);
	const command = shellPrefix(context.args.command);
	if (command.length > 0) {
		container.addChild(new Text(renderShellCommandCall({ command }, theme), 0, 0));
		container.addChild(new Spacer(1));
	}
	// 多段时每段一个状态色块 + 徽标头（dsh 轨迹 kindTag 语义）；单段由核心外壳着色，段内保持现状。
	const multipleSegments = viewModels.length > 1;
	for (const [index, viewModel] of viewModels.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		const bgFn = multipleSegments ? segmentBgFn(segmentStatus(viewModel), theme) : undefined;
		const header = multipleSegments ? segmentHeaderLine(viewModel, viewModels.length, theme) : undefined;
		if (header !== undefined) container.addChild(new Text(header, 0, 0, bgFn));
		if (viewModel.kind === "in-place-edit-result") {
			appendInPlaceEditResultBody(container, viewModel, options, theme, context, bgFn);
		} else {
			appendApplyPatchResultBody(container, viewModel, options, theme, context, bgFn);
		}
	}
	// 耗时独立行（wall-clock，与 built-in 一致：partial 时 Elapsed + 1s tick，最终/错误 Took）。
	// 渲染态缺失时无耗时行；不解析 CLI 输出文本（apply_patch 从不自报耗时）。
	const ms = elapsedMs(context.state, options.isPartial);
	if (ms !== undefined) {
		container.addChild(new Text(theme.fg("muted", `${options.isPartial ? "Elapsed" : "Took"} ${(ms / 1000).toFixed(1)}s`), 0, 0));
	}
	return container;
}

export function parseRenderedResultPayloadFromDetails(details: unknown): BashResultViewModel[] | undefined {
	// tool_result 注入契约：{ ...builtinDetails, bashUi: { applyPatch | inPlaceEdit: viewModel } }。
	// 混合命令两段 VM 并存，按执行顺序（in-place 段在前）返回；
	// 无 bashUi 命名空间（普通命令 / 未识别结果）时返回 undefined，渲染层 delegate built-in。
	if (!isRecord(details) || !isRecord(details.bashUi)) return undefined;
	const viewModels: BashResultViewModel[] = [];
	const inPlaceEdit = parseInPlaceEditResultPayload(details.bashUi.inPlaceEdit);
	if (inPlaceEdit) viewModels.push(inPlaceEdit);
	const applyPatch = parseRenderedResultPayload(details.bashUi.applyPatch);
	if (applyPatch) viewModels.push(applyPatch);
	return viewModels.length > 0 ? viewModels : undefined;
}
