/**
 * File-grouped edit extension.
 *
 * Contract:
 * - accepts { files: [{path, edits[]}] }
 * - the file list may contain one file or many files; minimum length is 1
 * - each file entry carries one path plus that file's edits[]
 * - the same physical file may appear more than once and is merged after canonicalization
 * - files are canonicalized before execution so aliases resolve to the same physical file
 * - each file group is atomic and isolated from every other file group
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
    renderResultViewModel,
    renderToolTextResult,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "edit",
        label: "edit",
        renderShell: "default",
        description:
            "Exact text replacements in existing files. Use for small in-place edits with known oldText. Not for create, delete, move, or full rewrite.",
        promptSnippet: "Exact file edits",
        promptGuidelines: [
            "Copy oldText verbatim from the latest read output — exact whitespace and quotes, never from memory.",
            "Keep oldText short (1-3 lines) and unique; set expectedOccurrences to replace all occurrences.",
            "One file per call; multiple files = parallel calls.",
            "Bulk edits across many files: use bash (perl/sed) instead.",
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
                return renderToolTextResult(typedResult, theme, context);
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
