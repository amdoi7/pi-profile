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
            "Edit a single file using exact text replacement: each edits[].oldText must match a unique, non-overlapping region of the original file.",
        promptSnippet: "Exact file edits",
        promptGuidelines: [
            "For edit, read the target file first; copy oldText verbatim from the latest read output, including whitespace.",
            "For edit, keep oldText short (1-3 lines).",
            "For edit, if the intended target is still unclear after reading, ask the user instead of retrying with guessed text.",
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
