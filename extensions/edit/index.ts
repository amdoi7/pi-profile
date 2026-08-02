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
    renderResultViewModel,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "edit",
        label: "edit",
        renderShell: "default",
        description:
            "Exact text replacements in existing files. Use for small in-place edits with known oldText.",
        promptSnippet: "Exact file edits",
        promptGuidelines: [
            "For edit, copy oldText verbatim from the latest read output.",
            "For edit, keep oldText short (1-3 lines) and unique; replaceAll: true replaces all matches.",
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
                details: buildOutcomeUiDetails(outcome),
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
            };
            const rendered = parseRenderedResultPayload(typedResult);
            if (!rendered) {
                return renderResultContractError(theme, context);
            }
            return renderResultViewModel(
                rendered,
                options,
                theme,
                context,
            );
        },
    });
}
