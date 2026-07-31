import {
	createBashToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { EphemeralPatchRuns } from "./ephemeral-patch-runs.ts";
import { parseApplyPatches, parseStandaloneApplyPatch } from "./patch-command.ts";
import {
	ephemeralRunForContext,
	renderApplyPatchResult,
	renderPendingApplyPatch,
	type PatchRenderContext,
} from "./ui.ts";

function mergeParsedPatches(patches: ReturnType<typeof parseApplyPatches>): {
	operations: ReturnType<typeof parseApplyPatches>[number]["patch"]["operations"];
} {
	const operations: typeof patches[number]["patch"]["operations"] = [];
	for (const entry of patches) {
		operations.push(...entry.patch.operations);
	}
	return { operations };
}

function resolvePatches(command: string, cwd: string): ReturnType<typeof parseApplyPatches> {
	const patches = parseApplyPatches(command, cwd);
	if (patches.length > 0) return patches;
	const standalone = parseStandaloneApplyPatch(command);
	return standalone ? [{ patch: standalone, cwd }] : [];
}

export default function applyPatchUiExtension(pi: ExtensionAPI) {
	const baseBash = createBashToolDefinition(process.cwd());
	const ephemeralRuns = new EphemeralPatchRuns();

	pi.on("session_shutdown", () => {
		ephemeralRuns.clear();
	});

	pi.registerTool({
		...baseBash,
		async execute(toolCallId, args, signal, onUpdate, context) {
			const delegate = () => baseBash.execute(toolCallId, args, signal, onUpdate, context);
			const patches = resolvePatches(args.command, context.cwd);
			if (patches.length === 0 || context.mode !== "tui") return delegate();
			const merged = mergeParsedPatches(patches);
			return ephemeralRuns.execute(toolCallId, merged.operations, patches[0].cwd, delegate);
		},
		renderCall(args, theme, context) {
			if (!context.argsComplete) return baseBash.renderCall(args, theme, context);
			const patches = resolvePatches(args.command, context.cwd);
			if (patches.length === 0) return baseBash.renderCall(args, theme, context);

			baseBash.renderCall(args, theme, { ...context, lastComponent: undefined });
			if (!context.isPartial) return new Container();
			return renderPendingApplyPatch(mergeParsedPatches(patches), theme, context as PatchRenderContext);
		},
		renderResult(result, options, theme, context) {
			const patches = resolvePatches(context.args.command, context.cwd);
			if (patches.length === 0) return baseBash.renderResult(result, options, theme, context);

			const baseResult = baseBash.renderResult(result, options, theme, { ...context, lastComponent: undefined });
			if (options.isPartial) return baseResult;
			const renderContext = context as PatchRenderContext;
			const run = ephemeralRunForContext(ephemeralRuns, renderContext);
			return renderApplyPatchResult(mergeParsedPatches(patches), result, options, theme, renderContext, run) ?? baseResult;
		},
	});
}
