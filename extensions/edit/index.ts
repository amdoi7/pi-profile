/**
 * Batch exact-edit extension.
 *
 * Contract:
 * - one call = one intent = one transaction over files[]
 * - every file the intent touches goes in the same call
 * - the batch applies atomically: any unresolved anchor writes nothing
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildCallToolViewModel,
	buildOutcomeAgentContent,
	buildOutcomeUiDetails,
	editRequestParameters,
	executeEditBatch,
	parseEditRequest,
} from "./pipeline.ts";
import { forgetSessionEdits } from "./session-edits.ts";
import {
	isBatchUiDetails,
	renderCallViewModel,
	renderClearedCallState,
	renderResultView,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		forgetSessionEdits();
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		renderShell: "default",
		description:
			"Apply one intent as an atomic batch of exact text replacements; every file the intent touches goes in the same call.",
		promptSnippet: "Exact file edits",
		// 只留 schema 与错误文本说不出的两条：事务边界与匹配基准。
		// 其余四条（intent/hint 含义、唯一匹配与 replaceAll、锚要短、rejected 后怎么办）
		// 都已在 parameters 描述或失败载荷里，重说一遍只是每轮都付的 token。
		promptGuidelines: [
			"For edit, one call carries one intent: put every file that intent touches in files[], each with its own edits[]; never split an intent across calls or emit parallel edit calls for one change.",
			"For edit, each edits[].oldText is matched against that file's original content, not against the result of earlier edits in the same call.",
		],
		parameters: editRequestParameters,
		prepareArguments: parseEditRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = parseEditRequest(params);
			const outcome = await executeEditBatch(request, ctx.cwd, signal);

			// AgentToolResult 没有 isError 字段：信封由 harness 写，写在这里会被静默丢弃；
			// 软失败靠下面的 tool_result handler 改信封。
			return {
				content: [{ type: "text" as const, text: buildOutcomeAgentContent(outcome) }],
				details: buildOutcomeUiDetails(outcome, ctx.cwd),
			};
		},
		renderCall(args, theme, context) {
			if (!context.argsComplete) {
				return renderClearedCallState(context);
			}
			return renderCallViewModel(buildCallToolViewModel(args), theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderResultView(
				result as { content: Array<{ type: string; text?: string }>; details?: unknown },
				options,
				theme,
				context,
			);
		},
	});

	// 一个字节都没落盘（rejected）或盘上留下半成品（partial）是失败，不是成功：
	// 成功形的信封会让 provider 端的 is_error 与 pi 的错误样式/统计都看不见软失败。
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" || event.isError) return;
		const details: unknown = event.details;
		if (!isBatchUiDetails(details) || details.status === "applied") return;
		return { isError: true };
	});
}
