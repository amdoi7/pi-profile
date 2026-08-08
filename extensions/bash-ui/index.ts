import {
	createBashToolDefinition,
	isBashToolResult,
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { renderBashCall, renderBashResult } from "./bash-renderer.ts";
import { warmUpDiffWorker } from "../_shared/diff-service.ts";
import { buildApplyPatchPlan } from "./patch-command.ts";
import { resultText } from "./patch-result.ts";
import { ApplyPatchRunRegistry } from "./patch-run-registry.ts";
import { captureBeforeSnapshots } from "./patch-snapshot.ts";

/**
 * bash-ui（edit 模式）：bash 只是命令执行与输出识别来源，语义零改动。
 *
 *   command-policy tool_call      -> mutate/block command（settings.json 中先于 bash-ui 加载）
 *   bash-ui tool_call             -> parse authoritative plan -> 捕获 before 快照
 *                                    （并行 sibling execute 开始前的最早观察点）
 *   wrapped bash.execute          -> 验证 params.command 与 plan.command 一致
 *                                    -> delegate built-in execution（不改 input/output/error/order）
 *                                    -> 观察 accumulated update -> terminal block 完整时冻结 after
 *                                    -> 提交不可变 DiffRequest 到长期 worker
 *   tool_result                   -> 最后识别 -> await finalization -> 合并 BashUiDetails -> 清理 run
 *   renderCall/renderResult       -> 维护 wall-clock 耗时状态（startedAt/endedAt/interval，
 *                                    与 built-in 一致：执行开始记时，partial 每 1s tick，
 *                                    最终/错误冻结），renderResult 只消费 view model 否则 delegate
 *
 * 所有 mode 都注入 namespaced details（RPC/HTML export/session restore 消费）；
 * 只有 TUI 在 tool_call 捕获文件快照；RPC/JSON/print 走轻量 run（intent diff，不读文件）。
 */
export default function bashUiExtension(pi: ExtensionAPI) {
	const baseBash = createBashToolDefinition(process.cwd());
	const baseRenderCall = baseBash.renderCall;
	const baseRenderResult = baseBash.renderResult;
	const baseExecute = baseBash.execute;
	if (!baseRenderCall || !baseRenderResult) {
		throw new Error("bash-ui requires built-in bash renderCall/renderResult; upgrade pi or disable bash-ui");
	}
	const runs = new ApplyPatchRunRegistry();

	pi.on("session_shutdown", () => runs.clear());

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (ctx.mode !== "tui") return; // 非 TUI 的轻量 run 在 execute 创建（无文件 IO）
		const plan = buildApplyPatchPlan(event.input.command, ctx.cwd);
		if (!plan) return;
		// 启动 diff worker（不等待）：cold start 与 shell execution 重叠。
		warmUpDiffWorker();
		// tool_call 时捕获：sibling mutation tools 尚未开始执行。
		const before = await captureBeforeSnapshots(plan);
		runs.capture(event.toolCallId, plan, before);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event)) return;
		const viewModel = await runs.finalize(event.toolCallId, resultText(event));
		if (!viewModel) return;
		// BashUiDetails：保留 built-in metadata（truncation/fullOutputPath），
		// bashUi 只承载 view model（tool_result 的 details 整体替换，必须合并）。
		return { details: { ...event.details, bashUi: { applyPatch: viewModel } } };
	});

	pi.registerTool({
		...baseBash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (ctx.mode === "tui") {
				const plan = buildApplyPatchPlan(params.command, ctx.cwd);
				if (plan) {
					// 验证 captured plan 与 final params 一致：policy mutation 可能发生在
					// bash-ui 的 tool_call 之后（extension 顺序异常）。不一致时放弃旧快照
					// （sibling tools 可能已开始，重新捕获不可靠），基于 final command 建轻量 run。
					const captured = runs.capturedPlanCommand(toolCallId);
					if (captured !== undefined && captured !== plan.command) {
						console.error(
							`bash-ui plan mismatch toolCallId=${toolCallId} ` +
							`captured=${JSON.stringify(captured)} executed=${JSON.stringify(plan.command)} ` +
							`action="rebuilding run without snapshots (intent diff)"`,
						);
						runs.capture(toolCallId, plan);
					}
				} else {
					runs.remove(toolCallId);
				}
			} else {
				// 非 TUI：轻量 run（只保留 plan，intent diff），不读文件。
				const plan = buildApplyPatchPlan(params.command, ctx.cwd);
				if (plan) runs.capture(toolCallId, plan);
			}

			let executeActive = true;
			runs.attachSink(toolCallId, (update) => {
				if (executeActive) onUpdate?.(update);
			});
			try {
				const result = await baseExecute(toolCallId, params, signal, (update) => {
					onUpdate?.(runs.observe(toolCallId, update));
				}, ctx);
				return result;
			} finally {
				executeActive = false;
				runs.detachSink(toolCallId);
			}
		},
		renderCall(args, theme, context) {
			// 执行开始即记时（所有命令，含 apply_patch plan 路径）：
			// built-in 在自身 renderCall 记时，但 bash-ui 的 argsComplete 路径不调 baseRenderCall。
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const plan = context.argsComplete ? buildApplyPatchPlan(args.command, context.cwd) : undefined;
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
