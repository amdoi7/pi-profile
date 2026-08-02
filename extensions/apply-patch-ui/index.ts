import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
	createBashToolDefinition,
	isBashToolResult,
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { parseApplyPatches, parseStandaloneApplyPatch } from "./patch-command.ts";
import {
	parseRenderedResultPayloadFromDetails,
	renderApplyPatchResult,
	renderPendingApplyPatch,
	renderResultViewModel,
	type PatchRenderContext,
} from "./ui.ts";
import { buildResultViewModel, type BeforeSnapshots } from "./view-model.ts";

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
	return standalone ? [{ patch: standalone, cwd, endLine: 0 }] : [];
}

function bashResultCommand(input: unknown): string {
	if (typeof input !== "object" || input === null || !("command" in input) || typeof input.command !== "string") {
		throw new Error("apply-patch-ui received malformed bash tool_result input: expected input.command string; upgrade pi or disable apply-patch-ui");
	}
	return input.command;
}

/**
 * 行号 diff 的最小前置：执行前捕获 before 内容（每路径一次读取）。
 * 在 tool_call 事件中完成——bash 的 execute 完全不覆盖。
 */
async function captureBefore(
	operations: ReturnType<typeof mergeParsedPatches>["operations"],
	cwd: string,
): Promise<BeforeSnapshots> {
	const snapshots: BeforeSnapshots = new Map();
	for (const operation of operations) {
		const paths = operation.destination ? [operation.path, operation.destination] : [operation.path];
		for (const displayPath of paths) {
			if (snapshots.has(displayPath)) continue;
			const absolutePath = resolve(cwd, displayPath);
			let before: string | null = null;
			try {
				before = await readFile(absolutePath, "utf8");
			} catch {
				// ENOENT 等：文件不存在（add 目标等），before 为 null。
			}
			snapshots.set(displayPath, { absolutePath, before });
		}
	}
	return snapshots;
}

/**
 * apply_patch UI（edit 模式）：bash 只是命令执行与输出识别来源，语义零改动。
 * - tool_call：捕获 before 快照（bash execute 不覆盖）。
 * - tool_result：解析 bash 输出，生成结构化 view model 注入 result.details。
 * - renderCall/renderResult：渲染 view model（完成态）或解析 text（isPartial 流式）。
 * - 未识别（普通命令、复合未支持语法）：渲染原样交给 bash。
 */
export default function applyPatchUiExtension(pi: ExtensionAPI) {
	const baseBash = createBashToolDefinition(process.cwd());
	const baseRenderCall = baseBash.renderCall;
	const baseRenderResult = baseBash.renderResult;
	if (!baseRenderCall || !baseRenderResult) {
		throw new Error("apply-patch-ui requires built-in bash renderCall/renderResult; upgrade pi or disable apply-patch-ui");
	}
	const beforeRuns = new Map<string, BeforeSnapshots>();

	pi.on("session_shutdown", () => {
		beforeRuns.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const patches = resolvePatches(event.input.command, ctx.cwd);
		if (patches.length === 0 || ctx.mode !== "tui") return;
		beforeRuns.set(event.toolCallId, await captureBefore(mergeParsedPatches(patches).operations, patches[0].cwd));
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event)) return;
		const patches = resolvePatches(bashResultCommand(event.input), ctx.cwd);
		if (patches.length === 0) return;
		const before = beforeRuns.get(event.toolCallId);
		beforeRuns.delete(event.toolCallId);
		const viewModel = await buildResultViewModel(
			patches.map((entry) => entry.patch),
			{ content: event.content, isError: event.isError },
			before,
		);
		if (!viewModel) return;
		return { details: viewModel };
	});

	pi.registerTool({
		...baseBash,
		renderCall(args, theme, context) {
			if (!context.argsComplete) return baseRenderCall(args, theme, context);
			const patches = resolvePatches(args.command, context.cwd);
			if (patches.length === 0) return baseRenderCall(args, theme, context);

			// 执行中：结果块（bash 流式输出或已识别的结果 UI）接管 call 槽；
			// 完成态：call 槽由 clearPendingCall 清空（edit 模式）。
			if (!context.isPartial || context.executionStarted) return new Container();
			return renderPendingApplyPatch(mergeParsedPatches(patches), theme, context as PatchRenderContext);
		},
		renderResult(result, options, theme, context) {
			const patches = resolvePatches(context.args.command, context.cwd);
			if (patches.length === 0) return baseRenderResult(result, options, theme, context);

			const renderContext = context as PatchRenderContext;
			// 完成态：消费 tool_result 注入的结构化 view model（不解析文本、不读文件）。
			const viewModel = parseRenderedResultPayloadFromDetails(result.details);
			if (viewModel) return renderResultViewModel(viewModel, options, theme, renderContext);

			// isPartial 流式：tool_result 未触发，解析 text 及时渲染（长尾命令不阻塞）。
			renderContext.beforeSnapshots = beforeRuns.get(context.toolCallId);
			return (
				renderApplyPatchResult(patches.map((entry) => entry.patch), result, options, theme, renderContext) ??
				baseRenderResult(result, options, theme, context)
			);
		},
	});
}
