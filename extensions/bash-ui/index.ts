import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
	createBashToolDefinition,
	isBashToolResult,
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { highlightBashCall } from "./highlight.ts";
import { parseApplyPatches, parseStandaloneApplyPatch } from "./patch-command.ts";
import { parseApplyPatchResultSequence, resultText } from "./patch-result.ts";
import {
	parseRenderedResultPayloadFromDetails,
	renderPendingApplyPatch,
	renderResultViewModel,
	type PatchRenderContext,
} from "./ui.ts";
import { buildResultViewModel, buildResultViewModelSync, type ApplyPatchResultViewModel, type BeforeSnapshots } from "./view-model.ts";

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
		throw new Error("bash-ui received malformed bash tool_result input: expected input.command string; upgrade pi or disable bash-ui");
	}
	return input.command;
}

/**
 * before 快照大小上限：超出视为非源码文件（生成物/数据），跳过行号 diff（回退意图 diff）。
 * 实测最大源码文件约 2.5MB（ai4x 生成物），此处留 3 倍余量。
 */
const BEFORE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

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
				if ((await stat(absolutePath)).size > BEFORE_SNAPSHOT_MAX_BYTES) continue;
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
 * - renderCall/renderResult：渲染 view model（完成态或流式缓存），渲染路径不做文件 IO/diff。
 * - 流式：首次成功解析时构建一次 view model 并缓存；后续 chunk 只刷新 trailing。
 * - 未识别（普通命令、复合未支持语法）：渲染原样交给 bash。
 */
export default function bashUiExtension(pi: ExtensionAPI) {
	const baseBash = createBashToolDefinition(process.cwd());
	const baseRenderCall = baseBash.renderCall;
	const baseRenderResult = baseBash.renderResult;
	if (!baseRenderCall || !baseRenderResult) {
		throw new Error("bash-ui requires built-in bash renderCall/renderResult; upgrade pi or disable bash-ui");
	}
	const beforeRuns = new Map<string, BeforeSnapshots>();
	/** 流式期间已构建的 view model：渲染路径只读缓存，tool_result 消费后删除。 */
	const streamViewModels = new Map<string, { viewModel: ApplyPatchResultViewModel; resultsCount: number }>();

	pi.on("session_shutdown", () => {
		beforeRuns.clear();
		streamViewModels.clear();
	});

	/** 从最新 text 刷新 trailing（patch 结果块不变时只延长 trailing；解析失败则保留缓存值）。 */
	const refreshTrailing = (text: string, cached: { viewModel: ApplyPatchResultViewModel; resultsCount: number }): string => {
		const parsed = parseApplyPatchResultSequence(text);
		if (!parsed || parsed.results.length !== cached.resultsCount) return cached.viewModel.trailing;
		return parsed.trailing;
	};

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
		// 流式期间已构建 → 复用（patch 落地瞬间的文件状态，语义正确），只刷新 trailing。
		const cached = streamViewModels.get(event.toolCallId);
		streamViewModels.delete(event.toolCallId);
		let viewModel: ApplyPatchResultViewModel | undefined;
		if (cached) {
			viewModel = { ...cached.viewModel, trailing: refreshTrailing(resultText(event), cached) };
		} else {
			viewModel = await buildResultViewModel(
				patches.map((entry) => entry.patch),
				{ content: event.content, isError: event.isError },
				before,
			);
		}
		if (!viewModel) return;
		return { details: viewModel };
	});

	pi.registerTool({
		...baseBash,
		renderCall(args, theme, context) {
			if (!context.argsComplete) return baseRenderCall(args, theme, context);
			const patches = resolvePatches(args.command, context.cwd);
			if (patches.length === 0) return highlightBashCall(args, theme, context, baseRenderCall);

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

			// 流式：首次成功解析时构建一次并缓存；后续 chunk 只刷新 trailing。
			const cached = streamViewModels.get(context.toolCallId);
			const text = resultText(result);
			if (cached) {
				return renderResultViewModel(
					{ ...cached.viewModel, trailing: refreshTrailing(text, cached) },
					options,
					theme,
					renderContext,
				);
			}
			const built = buildResultViewModelSync(patches.map((entry) => entry.patch), result, beforeRuns.get(context.toolCallId));
			if (built) {
				streamViewModels.set(context.toolCallId, {
					viewModel: built,
					resultsCount: "results" in built ? built.results.length : 1,
				});
				return renderResultViewModel(built, options, theme, renderContext);
			}
			// 未识别（普通命令、复合未支持语法、输出无法匹配）：原样交给 bash。
			return baseRenderResult(result, options, theme, context);
		},
	});
}
