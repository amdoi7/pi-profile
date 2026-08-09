import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";

import { highlightBashCall, tokenize, type Seg } from "./highlight.ts";
import type { ApplyPatchPlan } from "./recognize.ts";
import type { ApplyPatchResultViewModel } from "./view-model-codec.ts";
import {
	parseRenderedResultPayloadFromDetails,
	renderPendingApplyPatch,
	renderResultViewModel,
	type PatchRenderContext,
} from "./ui.ts";

type BashCallArgs = { command: string; timeout?: number };

/** P4 memo 的渲染态槽：command 字符串不等时失效（1s tick 不重扫 100KB heredoc）。 */
type RenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
	segCache?: { command: string; segs: Seg[] };
};

/**
 * pi 未导出 ToolRenderContext：本地窄化（renderer 消费的字段子集）。
 * 调用方（index.ts）传入的推断类型结构上兼容。
 */
type ToolRenderContext = {
	args: BashCallArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	/** BashRenderState 形状（built-in bash 的 rendererState 契约）+ P4 memo 槽。 */
	state: RenderState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
};

type BaseRenderCall = (args: BashCallArgs, theme: Theme, context: ToolRenderContext) => unknown;

/**
 * P4 memo：VM 校验结果按 details 对象 identity 缓存（每次注入都是新对象，identity 即失效）。
 * 值 null = 校验失败（避免重复校验）；WeakMap 随 details 被 GC，无驻留。
 */
const detailsToViewModel = new WeakMap<object, ApplyPatchResultViewModel | null>();

function parseDetailsCached(details: unknown): ApplyPatchResultViewModel | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const cached = detailsToViewModel.get(details);
	if (cached !== undefined) return cached ?? undefined;
	const viewModel = parseRenderedResultPayloadFromDetails(details);
	detailsToViewModel.set(details, viewModel ?? null);
	return viewModel;
}

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
	if (!plan) {
		// P4 memo：tokenize 产物按 command 字符串缓存（assemble 每次重建，词法不再白扫）。
		const state = context.state;
		let segs = state.segCache?.segs;
		if (!state.segCache || state.segCache.command !== args.command) {
			segs = tokenize(args.command ?? "", process.cwd());
			state.segCache = { command: args.command ?? "", segs };
		}
		return highlightBashCall(args, theme, context, baseRenderCall, segs) as Component;
	}
	// 执行中/完成态：call 槽由结果 UI 接管或清空（edit 模式）；容器复用避免每帧重建。
	if (!context.isPartial || context.executionStarted) {
		const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		container.clear();
		return container;
	}
	return renderPendingApplyPatch(plan, theme, context as PatchRenderContext);
}

/**
 * renderResult 分派：只消费 details 里的结构化 view model（payload 校验，WeakMap memo），
 * 否则 delegate built-in renderer。渲染路径不做文件 IO、diff、解析或 run-map 查询。
 */
export function renderBashResult(
	result: { details?: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
	baseRenderResult: (result: never, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) => Component,
): Component {
	const viewModel = parseDetailsCached(result.details);
	if (viewModel) return renderResultViewModel(viewModel, options, theme, context as PatchRenderContext);
	return baseRenderResult(result as never, options, theme, context);
}
