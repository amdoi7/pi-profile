import {
	createBashToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { renderBashCall, renderBashResult } from "./bash-renderer.ts";
import { disposeDiffService, warmUpDiffWorker } from "../_shared/diff-service.ts";
import { buildApplyPatchPlan, type ApplyPatchPlan } from "./recognize.ts";
import { executeApplyPatchPlan } from "./execute.ts";

/**
 * bash-ui（edit 模式）：bash 只是命令执行与输出识别来源，语义零改动。
 *
 * 执行者架构（终局）：识别 canonical apply_patch shape 后自己执行 patch invocations，
 * 语义从源头就是结构（见 execute.ts）。观察者机制（tool_call 提前快照、freeze 状态机、
 * sink/revision、tool_result 注入）整体删除：生命周期 = execute 作用域。
 *
 *   recognize（非 plan）   -> delegate built-in execute（语义零改动，永久不变量）
 *   recognize（plan）      -> 逐 invocation：withFileMutationQueue + before/after 快照
 *                             bracket + 短路 + trailing 原生委托 -> VM 进 result.details
 *   renderCall/renderResult -> 渲染树结构与观察者架构相同：只消费 details.bashUi，
 *                              P4 memo 缓存与聚合语义设计原封保留
 *
 * bash 语义零改动承诺（保留）：input/output/error/order 原样；content 是 CLI 真实
 * 输出的忠实拼接；非识别命令 delegate 原样。worker 不可用 → intent diff 是唯一定义的
 * 降级（保留）。VM 是唯一持久产物；restore/HTML export 不依赖内存（保留）。
 */
export default function bashUiExtension(pi: ExtensionAPI) {
	const baseBash = createBashToolDefinition(process.cwd());
	const baseRenderCall = baseBash.renderCall;
	const baseRenderResult = baseBash.renderResult;
	const baseExecute = baseBash.execute;
	if (!baseRenderCall || !baseRenderResult) {
		throw new Error("bash-ui requires built-in bash renderCall/renderResult; upgrade pi or disable bash-ui");
	}

	// 长期 diff worker 的生命周期接线（worker 本身 lazy 创建）。
	pi.on("session_shutdown", () => disposeDiffService());

	pi.registerTool({
		...baseBash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const plan = buildApplyPatchPlan(params.command, ctx.cwd);
			if (!plan) return baseExecute(toolCallId, params, signal, onUpdate, ctx);
			// 启动 diff worker（不等待）：cold start 与 patch 执行重叠。
			warmUpDiffWorker();
			const outcome = await executeApplyPatchPlan(plan, { signal, timeout: params.timeout, ctx, onUpdate });
			return {
				content: [{ type: "text", text: outcome.content }],
				isError: outcome.isError,
				details: outcome.details,
			};
		},
		renderCall(args, theme, context) {
			// 执行开始即记时（所有命令，含 apply_patch plan 路径）：
			// built-in 在自身 renderCall 记时，但 bash-ui 的 argsComplete 路径不调 baseRenderCall。
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			// P4 memo：plan 识别结果按 command 字符串缓存（1s tick 不重跑识别器；
			// 非 plan 命令的 undefined 也缓存——识别器只跑一次）。
			const memo = state as typeof state & { planCache?: { command: string; plan: ApplyPatchPlan | undefined } };
			let plan: ApplyPatchPlan | undefined;
			if (context.argsComplete) {
				if (!memo.planCache || memo.planCache.command !== args.command) {
					memo.planCache = { command: args.command, plan: buildApplyPatchPlan(args.command, context.cwd) };
				}
				plan = memo.planCache.plan;
			}
			return renderBashCall(args, theme, context, baseRenderCall, plan);
		},
		renderResult(result, options, theme, context) {
			// 耗时生命周期（与 built-in 相同的 state keys）：partial 期间 1s tick 重绘；
			// 最终/错误渲染冻结 endedAt 并停 interval。delegate 路径 built-in 复用同一 state。
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			return renderBashResult(result, options, theme, context, baseRenderResult);
		},
	});
}
