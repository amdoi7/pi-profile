/**
 * file-result.ts — 文件变更结果统一契约与渲染转换。
 *
 * edit / apply_patch / in-place edit（perl/sed）的执行机制不同，但结果
 * 结构同构：{ path, changeStats, display, truncated }。渲染转换
 * （FileMutationRenderItem 构造）在三个 extension 中各写一份，这里统一。
 *
 * 模块边界（三层，终局）：
 *   - 契约/渲染层（本文件 + final-diff + diff-view + file-mutation-view）：
 *     FileMutationResult 是渲染唯一契约；各工具的 VM 构建方直接产出它，
 *     不再有领域类型转换层。
 *   - 执行层（各工具私有）：edit-engine（内存应用 edits）、bash-ui execute
 *     （apply_patch 语义 / perl verbatim 子进程）机制不同，不强融；共享的
 *     只有事务模式（withFileMutationQueue 与快照 bracket，后者留在 bash-ui）。
 *   - 适配层（extension 各自）：参数契约、校验、命令识别、段调度。
 *
 * 契约边界（不强融的部分）：
 *   - kind/destination/cwd 是 apply_patch 特有语义，edit 无；
 *   - status:"failed" + error 是 edit 的软失败语义，bash-ui 的失败走
 *     error.code 不进结果结构；
 *   - label 归因真实工具（edit / apply_patch / perl edit / sed edit）。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

import { renderDiffSummary } from "./code-preview.ts";
import type { DiffPreview } from "./diff-view.ts";
import { renderCwdFilePathLink } from "./file-link.ts";
import type { ChangeStats, DisplayDiff } from "./final-diff.ts";
import type { FileMutationRenderItem } from "./file-mutation-view.ts";

export type FileMutationKind = "Add" | "Update" | "Move" | "Delete" | "Rewrite";

export type FileMutationResult = {
	/** 工具名归因（title 头）。 */
	label: string;
	/** apply_patch 特有：Add/Update/Move/Delete/Rewrite；edit 无。 */
	kind?: FileMutationKind;
	path: string;
	destination?: string;
	cwd: string;
	changeStats: ChangeStats;
	display: DisplayDiff;
	truncated: boolean;
	/** edit 软失败；bash-ui 失败不进此结构。 */
	status?: "failed";
	error?: string;
};

/**
 * 统一文件变更结果 → 渲染 item 转换（三处重复实现的单一来源）。
 * @param previews - 覆盖默认 preview（apply_patch 聚合多 invocation diff 时用）。
 */
export function fileResultItem(
	result: FileMutationResult,
	theme: Theme,
	fallbackCwd: string,
	previews?: DiffPreview[],
): FileMutationRenderItem {
	const summary = result.status === "failed"
		? theme.fg("error", "failed")
		: renderDiffSummary(result.changeStats, theme);
	// apply_patch 风格恒带 " · "（stats 可空）；edit 风格只在有 summary 时追加。
	const suffix = result.kind !== undefined || summary.length > 0
		? `${theme.fg("muted", " · ")}${summary}`
		: "";
	const displayPath = result.destination
		? `${result.path}${theme.fg("muted", " -> ")}${result.destination}`
		: result.path;
	const linkTarget = result.destination ?? result.path;
	const count = "";
	const kindWord = result.kind === undefined ? "" : ` ${theme.fg("success", result.kind)} file`;
	// 顺序与 apply_patch 原实现一致：link → " · "+stats → patches 计数。
	const title = `${theme.fg("toolTitle", theme.bold(result.label))}${kindWord} ` +
		`${renderCwdFilePathLink(displayPath, linkTarget, result.cwd ?? fallbackCwd, theme)}${suffix}${count}`;
	if (result.status === "failed") {
		return { title, outcome: "failed", message: result.error ?? "" };
	}
	const hasDiff = result.display.rows.length > 0 || result.truncated;
	return {
		title,
		outcome: "applied",
		previews: hasDiff ? previews ?? [{ display: result.display, truncated: result.truncated }] : [],
	};
}

/**
 * 计划（pending）行：结果未发生时的同构计划展示（edit 的 pending 行、
 * apply_patch 的每操作计划行）。kind 用 muted（计划，未发生），stats 仅在
 * 非零时显示；多文件一行（in-place edit pending）是特例，保留在 bash-ui。
 */
export function fileMutationPlanItem(
	result: Pick<FileMutationResult, "label" | "kind" | "path" | "destination" | "cwd" | "changeStats">,
	theme: Theme,
	fallbackCwd: string,
	indent = false,
): FileMutationRenderItem {
	const kindWord = result.kind === undefined ? "" : ` ${theme.fg("muted", result.kind)} file`;
	const displayPath = result.destination
		? `${result.path}${theme.fg("muted", " -> ")}${result.destination}`
		: result.path;
	const linkTarget = result.destination ?? result.path;
	const parts = [
		`${indent ? "  " : ""}${theme.fg("toolTitle", theme.bold(result.label))}${kindWord}`,
		renderCwdFilePathLink(displayPath, linkTarget, result.cwd ?? fallbackCwd, theme),
	];
	if (result.changeStats.changedLines > 0) {
		parts.push(renderDiffSummary(result.changeStats, theme));
	}
	return { title: parts.join(" "), outcome: "pending" };
}
