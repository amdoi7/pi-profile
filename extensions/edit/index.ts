/**
 * Single-file exact edit extension.
 *
 * Contract:
 * - accepts { path, edits }
 * - each call atomically modifies one file
 * - multiple disjoint replacements for that file share edits[]
 * - multiple files use parallel tool calls
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
    buildCallToolViewModel,
    buildOutcomeAgentContent,
    buildOutcomeUiDetails,
    editRequestParameters,
    executeSingleFileEdit,
    parseEditRequest,
} from "./pipeline.ts";
import {
    parseRenderedResultPayload,
    renderCallViewModel,
    renderClearedCallState,
    renderResultContractError,
    renderResultTextContent,
    renderResultViewModel,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "edit",
        label: "edit",
        renderShell: "default",
        description:
            "Edit a single file by replacing exact text matches; one file per call, multiple edits allowed.",
        promptSnippet: "Exact file edits",
        promptGuidelines: [
            "For edit, oldText must match the file's current content exactly, including whitespace; inspect the file first (read or bash) when unsure.",
            "For edit, each oldText must match exactly once; if it matches multiple times, include more surrounding context to make it unique or set replaceAll to true.",
            "For edit, each edits[].oldText is matched against the original file, not after earlier edits are applied; do not emit overlapping or nested edits — merge nearby changes into one edit.",
            "For edit, keep oldText short (1-3 lines).",
            "For edit, when a match fails, inspect the file's actual content and adjust oldText; do not retry the same guess.",
        ],
        parameters: editRequestParameters,
        prepareArguments: parseEditRequest,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const request = parseEditRequest(params);
            const outcome = await executeSingleFileEdit(request, ctx.cwd, signal);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: buildOutcomeAgentContent(outcome),
                    },
                ],
                // 软失败必须进错误通道:status:"failed" 的 payload 若不带
                // isError,harness 与 isError 分流(渲染/重试统计)都看不见它。
                isError: outcome.status === "failed",
                details: buildOutcomeUiDetails(outcome, ctx.cwd),
            };
        },
        renderCall(args, theme, context) {
            if (!context.argsComplete) {
                return renderClearedCallState(context);
            }
            return renderCallViewModel(
                buildCallToolViewModel(args),
                theme,
                context,
            );
        },
        renderResult(result, options, theme, context) {
            const typedResult = result as {
                content: Array<{ type: string; text?: string }>;
                details?: unknown;
                isError?: boolean;
            };
            const rendered = parseRenderedResultPayload(typedResult);
            if (rendered) {
                return renderResultViewModel(
                    rendered,
                    options,
                    theme,
                    context,
                );
            }
            // 执行错误（校验/abort，details 为空）渲染真实错误文本。
            if (typedResult.isError) {
                return renderResultTextContent(typedResult, theme, context);
            }
            if (options.isPartial) {
                return renderClearedCallState(context);
            }
            // 成功结果 details 无法解析：不向后兼容旧格式（execute 构造保证），
            // 真·不应发生——保留开发诊断，避免静默掩盖契约破坏。
            return renderResultContractError(theme, context);
        },
    });
}
