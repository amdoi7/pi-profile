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
import {
	renderCallViewModel,
	renderClearedCallState,
	renderResultFromDetails,
	renderResultTextContent,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		renderShell: "default",
		description:
			"Apply one intent as an atomic batch of exact text replacements; every file the intent touches goes in the same call.",
		promptSnippet: "Exact file edits",
		promptGuidelines: [
			"For edit, one call carries one intent: put every file that intent touches in files[], each with its own edits[]; never split an intent across calls or emit parallel edit calls for one change.",
			"For edit, intent is one line naming the change (\"split ToolCtx into PullCtx/ActCtx\"); files[].hint is an optional short note on that file's role.",
			"For edit, oldText must match the file's current content exactly, including whitespace, and must match exactly once — add surrounding context to disambiguate, or set replaceAll to true to replace every occurrence.",
			"For edit, each edits[].oldText is matched against that file's original content, not after earlier edits; do not emit overlapping or nested edits — merge nearby changes into one edit. Keep oldText short (1-3 lines).",
			"For edit, status \"rejected\" means nothing was written: read the files named in failed[], fix those anchors, and resend the batch; do not retry the same guess.",
		],
		parameters: editRequestParameters,
		prepareArguments: parseEditRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = parseEditRequest(params);
			const outcome = await executeEditBatch(request, ctx.cwd, signal);

			return {
				content: [{ type: "text" as const, text: buildOutcomeAgentContent(outcome) }],
				// 软失败必须进错误通道：status != applied 的 payload 若不带 isError，
				// harness 与 isError 分流（渲染/重试统计）都看不见它。
				isError: outcome.status !== "applied",
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
			const typedResult = result as {
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
				isError?: boolean;
			};

			// details 缺席 = 执行前就失败（参数校验 / abort）：渲染真实错误文本。
			if (typedResult.details === undefined) {
				return renderResultTextContent(typedResult, theme, context);
			}
			if (options.isPartial) {
				return renderClearedCallState(context);
			}
			return renderResultFromDetails(typedResult.details, theme, context);
		},
	});
}
