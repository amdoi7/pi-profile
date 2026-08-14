import {
	createBashToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

import { renderBashCall, renderBashResult } from "./bash-renderer.ts";
import { disposeDiffService, warmUpDiffWorker } from "../_shared/diff-service.ts";
import { recognizeBashCommand, type BashCommandPlan, type BashCommandRecognition } from "./recognize.ts";
import { executeBashPipeline } from "./execute.ts";

/** execute 侧外部 redirect resolver：读前序命令已落盘的 patch 文件；render 路径零 I/O 永不持有。 */
function externalStdinBody(absolutePath: string): string | undefined {
	try {
		return readFileSync(absolutePath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * bash-ui（edit 模式）：bash 只是命令执行与输出识别来源，语义零改动。
 *
 * 执行者架构（终局）：识别 canonical apply_patch shape 后自己执行 patch invocations，
 * 语义从源头就是结构（见 execute.ts）。观察者机制（tool_call 提前快照、freeze 状态机、
 * sink/revision、tool_result 注入）整体删除：生命周期 = execute 作用域。
 *
 *   recognize（非 plan）   -> delegate built-in execute（语义零改动，永久不变量）
 *   recognize（plan）      -> pipeline 段队列（executeBashPipeline 顺序调度 + && 短路 +
 *                             content 拼接 + details 合并；段间执行互不共享）：
 *                             apply-patch 段：逐 invocation：withFileMutationQueue + before/after
 *                             快照 bracket + 短路 + trailing 原生委托 -> VM 进 result.details
 *                             in-place-edit 段：编辑区 verbatim + 快照 bracket（无 rebuild——
 *                             语义零改动由构造保证）-> 快照真实 diff VM
 *                             混合命令（perl/sed 编辑区 + apply_patch 调用区）拆两段独立执行，
 *                             bashUi 两段 VM 并存，渲染按队列顺序堆叠
 *   redirect 来源缺同命令 cat 事实时，execute 侧用 externalStdinBody resolver 读前序命令
 *   已落盘的 patch 文件再识别（原样 redirect，无 replay）；render 路径零 I/O，同一
 *   recognizeBashCommand 阶梯以探针命中 external-shape 清空 call 槽。
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
			// 识别阶梯单一入口；execute 侧 resolver 读前序命令已落盘的 patch 文件
			// （同步小文件读；读不到/不可解析 → delegate）。
			const recognition = recognizeBashCommand(params.command, ctx.cwd, externalStdinBody);
			if (recognition.kind !== "plan") return baseExecute(toolCallId, params, signal, onUpdate, ctx);
			// 启动 diff worker（不等待）：cold start 与 patch 执行重叠。
			warmUpDiffWorker();
			const options = { signal, timeout: params.timeout, ctx, onUpdate };
			const outcome = await executeBashPipeline(recognition.pipeline, options);
			const text = outcome.errorSuffix === undefined
				? outcome.content
				: `${outcome.content ? `${outcome.content}\n\n` : ""}${outcome.errorSuffix}`;
			return {
				content: [{ type: "text", text }],
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
			const memo = state as typeof state & {
				planCache?: { command: string; recognition: BashCommandRecognition };
			};
			let plans: readonly BashCommandPlan[] | undefined;
			let externalShape = false;
			if (context.argsComplete) {
				if (!memo.planCache || memo.planCache.command !== args.command) {
					memo.planCache = { command: args.command, recognition: recognizeBashCommand(args.command, context.cwd) };
				}
				const recognition = memo.planCache.recognition;
				plans = recognition.kind === "plan" ? recognition.pipeline.plans : undefined;
				externalShape = recognition.kind === "external-shape";
			}
			return renderBashCall(args, theme, context, baseRenderCall, plans, externalShape);
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
