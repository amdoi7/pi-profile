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

import { executeExecutionPlan } from "./batch-execution.ts";
import {
    buildCallToolViewModel,
    buildExecutionOutcome,
    buildOutcomeAgentContent,
    buildOutcomeUiDetails,
    createExecutionPlan,
    editRequestParameters,
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
            "Match oldText exactly, including whitespace (line endings and curly quotes are normalized).",
            "Read the file before editing and copy oldText verbatim.",
            "Use the smallest unique oldText; 2-4 lines usually suffice — excess context wastes tokens.",
            "If oldText is not unique, add the minimum context needed for uniqueness, or set expectedOccurrences to the exact count to replace every occurrence (e.g. renaming an identifier).",
            "Group edits by file: one entry per path.",
            "Prefer perl/sed/rg/fd via bash for mechanical text-level batch edits across many files (imports, license headers, comment templates, fixed-string renames, bulk config changes); prefer AST-based tools for semantic code transformations.",
        ],
        parameters: editRequestParameters,
        prepareArguments: parseEditRequest,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const request = parseEditRequest(params);
            const plan = createExecutionPlan(request, ctx.cwd);
            const groupResults = await executeExecutionPlan(plan, signal);
            const outcome = buildExecutionOutcome(groupResults);

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
