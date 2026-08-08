import type { Theme, ToolRenderContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";

import { highlightBashCall } from "./highlight.ts";
import type { ApplyPatchPlan } from "./patch-command.ts";
import {
	parseRenderedResultPayloadFromDetails,
	renderPendingApplyPatch,
	renderResultViewModel,
	type PatchRenderContext,
} from "./ui.ts";

type BashCallArgs = { command: string; timeout?: number };

type BaseRenderCall = (args: BashCallArgs, theme: Theme, context: ToolRenderContext) => unknown;

/**
 * renderCall 分派：args 未完成 / 普通命令 → built-in（高亮路径）；
 * 已识别的 apply_patch → pending plan UI（纯分析，不读文件、不计算 diff）。
 * 执行中/完成态：call 槽由结果 UI 接管或清空（edit 模式）。
 */
export function renderBashCall(
	args: BashCallArgs,
	theme: Theme,
	context: ToolRenderContext,
	baseRenderCall: BaseRenderCall,
	plan: ApplyPatchPlan | undefined,
): Component {
	if (!context.argsComplete) return baseRenderCall(args, theme, context) as Component;
	if (!plan) return highlightBashCall(args, theme, context, baseRenderCall) as Component;
	if (!context.isPartial || context.executionStarted) return new Container();
	return renderPendingApplyPatch(plan, theme, context as PatchRenderContext);
}

/**
 * renderResult 分派：只消费 details 里的结构化 view model（payload 校验），
 * 否则 delegate built-in renderer。渲染路径不做文件 IO、diff、解析或 run-map 查询。
 */
export function renderBashResult(
	result: { details?: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
	baseRenderResult: (result: never, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) => Component,
): Component {
	const viewModel = parseRenderedResultPayloadFromDetails(result.details);
	if (viewModel) return renderResultViewModel(viewModel, options, theme, context as PatchRenderContext);
	return baseRenderResult(result as never, options, theme, context);
}
