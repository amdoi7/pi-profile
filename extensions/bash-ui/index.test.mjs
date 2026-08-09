import { afterAll, test as baseTest } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	copySharedFiles,
	extensionDir,
	linkPiPackages,
	linkSharedPackages,
	packageFileUrl,
	resolvePiPackageDir,
} from "../test-helpers/runtime-paths.mjs";

const sourceDir = extensionDir("bash-ui");
const piPackageDir = resolvePiPackageDir("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent } = await import(packageFileUrl(piPackageDir, "dist/index.js"));
const { initTheme } = await import(packageFileUrl(piPackageDir, "dist/modes/interactive/theme/theme.js"));
initTheme("dark");

/**
 * 扩展副本目录单例：所有测试共享（内容只读），进程退出时同步清理。
 * 曾为每次 loadRegisteredTool 新建目录且从不删除，测试运行后在 /tmp 堆积。
 */
let sharedExtensionRoot = null;

afterAll(() => {
	if (sharedExtensionRoot) {
		fs.rmSync(sharedExtensionRoot, { recursive: true, force: true });
		sharedExtensionRoot = null;
	}
});

/** 临时工作区 fixture：测试结束（含断言失败）自动清理，杜绝 /tmp 残留。 */
const test = baseTest.extend({
	temp: async ({}, use) => {
		const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bash-ui-temp-"));
		try {
			await use(temp);
		} finally {
			await fs.promises.rm(temp, { recursive: true, force: true });
		}
	},
});

async function loadRegisteredTool() {
	if (!sharedExtensionRoot) {
		sharedExtensionRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bash-ui-"));
	}
	const temp = sharedExtensionRoot;
	const tempExtensionDir = path.join(temp, "extension");
	const tempToolDir = path.join(tempExtensionDir, "bash-ui");
	// 排除 node_modules：pnpm 的 symlink 结构会让递归复制自引用（EINVAL），
	// 且测试的依赖解析走 vitest alias + linkPiPackages/linkSharedPackages 的链接。
	await fs.promises.cp(sourceDir, tempToolDir, {
		recursive: true,
		filter: (src) => !src.split(path.sep).includes("node_modules"),
	});
	await copySharedFiles(path.join(tempExtensionDir, "_shared"), [
		"code-preview.ts",
		"file-link.ts",
		"final-diff.ts",
		"diff-view.ts",
		"file-mutation-view.ts",
		"diff-service.ts",
		"diff-worker.ts",
	]);
	await linkPiPackages(tempExtensionDir, { tui: true });
	await linkSharedPackages(tempExtensionDir);

	const moduleUrl = `${pathToFileURL(path.join(tempToolDir, "index.ts")).href}?t=${Date.now()}`;
	const extensionModule = await import(moduleUrl);
	let registeredTool;
	const handlers = {};
	extensionModule.default({
		registerTool(definition) {
			registeredTool = definition;
		},
		on(event, handler) {
			(handlers[event] ??= []).push(handler);
		},
	});
	assert.ok(registeredTool, "bash-ui did not register a bash override");
	const modules = await loadBuilderModules(tempToolDir, tempExtensionDir);
	return { tool: { ...registeredTool, modules }, handlers };
}

/** 副本的纯 builder 模块：测试直接构造 view model payload（渲染层只消费 details 的契约）。 */
async function loadBuilderModules(tempToolDir, tempExtensionDir) {
	const stamp = `?t=${Date.now()}`;
	const load = (name, base = tempToolDir) => import(`${pathToFileURL(path.join(base, name)).href}${stamp}`);
	const [viewModel, plan, snapshot, result, diffService] = await Promise.all([
		load("view-model-build.ts"),
		load("recognize.ts"),
		load("patch-snapshot.ts"),
		load("invocation-result.ts"),
		load("diff-service.ts", path.join(tempExtensionDir, "_shared")),
	]);
	return {
		buildResultViewModel: viewModel.buildResultViewModel,
		buildApplyPatchPlan: plan.buildApplyPatchPlan,
		captureBeforeSnapshots: snapshot.captureBeforeSnapshots,
		captureAfterSnapshots: snapshot.captureAfterSnapshots,
		parseInvocationResult: result.parseInvocationResult,
		requestDiffBatch: diffService.requestDiffBatch,
	};
}

function createTheme() {
	return {
		fg: (_name, text) => text,
		bg: (_name, text) => text,
		bold: (text) => text,
		inverse: (text) => text,
	};
}

function createContext(command, overrides = {}) {
	return {
		args: { command },
		toolCallId: "tool-call-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp/pi-bash-ui-workspace",
		executionStarted: false,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

/**
 * 测试辅助：多块 sequence 解析（渲染测试构造 batch payload 用）。
 * 产品执行者是逐 invocation 解析（invocation-result.ts），此处的多块切分
 * 只存在于测试：按 failure JSON 行 / Success 块边界切分，块后余文为 trailing。
 */
function parseSequence(tool, text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const results = [];
	let cursor = 0;
	while (cursor < lines.length) {
		if (lines[cursor].trimStart().startsWith("{")) {
			const parsed = tool.modules.parseInvocationResult(lines[cursor]);
			if (!parsed) break;
			results.push(parsed);
			cursor += 1;
			continue;
		}
		if (lines[cursor] === "Success. Updated the following files:") {
			let end = cursor + 1;
			while (end < lines.length && /^[AMD] .+$/.test(lines[end])) end += 1;
			const parsed = tool.modules.parseInvocationResult(lines.slice(cursor, end).join("\n"));
			if (!parsed) break;
			results.push(parsed);
			cursor = end;
			continue;
		}
		break;
	}
	return results.length > 0 ? { results, trailing: lines.slice(cursor).join("\n") } : undefined;
}

/**
 * 构造 view model payload（渲染层只消费 details 的契约）。
 * 默认无快照（意图 diff）；withBefore/withAfter 时从真实文件捕获（行号 diff / rewrite 合并）。
 * plan 截断到 results 数（执行者架构的短路语义：失败后 invocation 不执行）。
 */
async function buildViewModel({ tool, command, text, cwd = "/tmp/pi-bash-ui-workspace", withBefore = false, withAfter = false }) {
	const plan = tool.modules.buildApplyPatchPlan(command, cwd);
	assert.ok(plan, "expected an apply_patch plan");
	const sequence = parseSequence(tool, text);
	if (!sequence) return undefined;
	const executedPlan = { ...plan, invocations: plan.invocations.slice(0, sequence.results.length) };
	const before = withBefore ? await tool.modules.captureBeforeSnapshots(plan) : undefined;
	const after = withAfter && before ? await tool.modules.captureAfterSnapshots(plan, before) : undefined;
	const submitter = async (inputs) => {
		try {
			const response = await tool.modules.requestDiffBatch(inputs, "test-batch");
			return response.files;
		} catch {
			return undefined;
		}
	};
	return tool.modules.buildResultViewModel(executedPlan, sequence, before, after, submitter);
}

function detailsWith(viewModel) {
	return { bashUi: { applyPatch: viewModel } };
}

async function runWithEvents(toolCallId, command, tool, handlers, { cwd = process.cwd() } = {}) {
	// 执行者架构：execute 自己完成识别/执行/VM（观察者机制已删除，handlers 仅保留签名兼容）。
	return tool.execute(
		toolCallId,
		{ command },
		undefined,
		undefined,
		createExecutionContext(cwd),
	);
}

function createExecutionContext(cwd) {
	return {
		cwd,
		mode: "tui",
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "bash-ui-test",
			getSessionFile: () => undefined,
		},
	};
}

function stripTerminalFormatting(text) {
	return text
		.replace(/\x1b\]8;;.*?(?:\x1b\\|\x07)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderText(component) {
	return stripTerminalFormatting(component.render(120).join("\n"));
}

function assertAppearsInOrder(text, fragments) {
	let prior = -1;
	for (const fragment of fragments) {
		const next = text.indexOf(fragment, prior + 1);
		assert.notEqual(next, -1, `expected to find ${fragment}`);
		assert.ok(next > prior, `expected ${fragment} after the prior fragment`);
		prior = next;
	}
}

const MULTI_OPERATION_COMMAND = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/new.ts
+export const created = true;
*** Update File: src/old.ts
@@
-export const old = true;
+export const old = false;
*** Update File: src/from.ts
*** Move to: src/to.ts
@@
-before
+after
*** Delete File: src/dead.ts
*** End Patch
PATCH`;

test("canonical heredoc renders compact pending operation headers", async () => {
	const { tool } = await loadRegisteredTool();
	const output = renderText(
		tool.renderCall(
			{ command: MULTI_OPERATION_COMMAND },
			createTheme(),
			createContext(MULTI_OPERATION_COMMAND),
		),
	);

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	assert.doesNotMatch(output, /\*\*\* Begin Patch/);
});

test("single-quoted apply_patch invocation uses the compact pending renderer", async () => {
	const command = "apply_patch '*** Begin Patch\n*** Add File: note.txt\n+it'\\''s ready\n*** End Patch'";
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.match(output, /apply_patch Add file note\.txt/);
	assert.match(output, /^\$ apply_patch /);
});

test("completed TUI row replaces the raw patch call with the confirmed result UI", async () => {
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: successText });
	assert.ok(viewModel, "expected a structured view model");
	const row = new ToolExecutionComponent(
		"bash",
		"completed-row",
		{ command: MULTI_OPERATION_COMMAND },
		{ showImages: false },
		tool,
		{ requestRender() {} },
		"/tmp/pi-bash-ui-workspace",
	);
	row.setArgsComplete();
	row.markExecutionStarted();
	row.updateResult({
		content: [{ type: "text", text: successText }],
		details: detailsWith(viewModel),
		isError: false,
	});

	const output = stripTerminalFormatting(row.render(120).join("\n"));
	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	assert.match(output, /\$ apply_patch/);
	assert.doesNotMatch(output, /\*\*\* Begin Patch/);
});

test("renderResult reuses the view model container across frames", async () => {
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: successText });
	const details = detailsWith(viewModel);
	const state = {};
	const context = createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state });
	const first = tool.renderResult(
		{ content: [{ type: "text", text: successText }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		context,
	);
	// 第二帧：pi 传入上一帧组件作为 lastComponent → 同一实例复用（容器 clear 后重建内容）。
	const second = tool.renderResult(
		{ content: [{ type: "text", text: successText }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		{ ...context, lastComponent: first },
	);
	assert.equal(second, first);
});

test("successful result renders confirmed affected paths", async () => {
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: successText });
	const context = createContext(MULTI_OPERATION_COMMAND, { executionStarted: true });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: successText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		context,
	));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	// 完成态：CLI 确认成功，patch 内容即实际变更（意图 diff）。
	assert.match(output, /\+\s+│ export const created = true;/);
	assert.match(output, /-\s+│ export const old = true;/);
	assert.match(output, /\+\s+│ export const old = false;/);
});

test("successful result followed by unrelated command output is still rendered", async () => {
	const { tool } = await loadRegisteredTool();
	const mixedOutput = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts\nFAILED tests/integration/test_identity_access_api.py::test_grant_admin_updates_existing_grant_and_rejects_identical_regrant\n1 failed, 1 warning in 0.71s";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: mixedOutput });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: mixedOutput }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	// 超长行（123 字符）被 pi-tui 按宽度 wrap，断言分片段而非整行。
	assert.match(output, /FAILED/);
	assert.match(output, /test_identity_access_api\.py/);
	assert.match(output, /1 failed, 1 warning in 0\.71s/);
});

test("partial result renders the apply_patch block once the complete result is recognized", async () => {
	const { tool } = await loadRegisteredTool();
	const mixedOutput = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts\n\nFAILED tests/integration/test_identity_access_api.py::test_grant_admin\n1 failed in 0.71s";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: mixedOutput });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: mixedOutput }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: true },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"FAILED tests/integration/test_identity_access_api.py",
	]);
	assert.match(output, /\+\s+│ export const created = true;/);
	assert.match(output, /-\s+│ export const old = true;/);
	assert.match(output, /^\$ apply_patch/);
});

test("partial result with incomplete changes retains the built-in bash renderer", async () => {
	const { tool } = await loadRegisteredTool();
	const partialOutput = "Success. Updated the following files:\nA src/new.ts";
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: partialOutput }],
			details: undefined,
		},
		{ expanded: false, isPartial: true },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assert.match(output, /Success\. Updated the following files:/);
	assert.doesNotMatch(output, /apply_patch applied/);
});

test("partial result collapses trailing output beyond the preview window", async () => {
	const { tool } = await loadRegisteredTool();
	const pytestLines = Array.from({ length: 30 }, (_, index) => `test_case_${index} passed`).join("\n");
	const mixedOutput = `Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts\n\n${pytestLines}`;
	// 流式契约：terminal block 完整后 registry observe 注入 view model，渲染层消费 details。
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: mixedOutput });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: mixedOutput }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: true },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assert.match(output, /test_case_29 passed/);
	assert.match(output, /test_case_0 passed/);
	assert.match(output, /11 output lines hidden in middle, expand to view/);
	assert.doesNotMatch(output, /test_case_15 passed/);
});

test("successful result omits the redundant summary for a single operation", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/only.ts
@@
-before
+after
*** End Patch
PATCH`;
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nM src/only.ts";
	const viewModel = await buildViewModel({ tool, command, text: successText });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: successText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true }),
	));

	assert.match(output, /apply_patch Update file src\/only\.ts/);
	assert.doesNotMatch(output, /applied 1 operation/);
});

test("successful result follows the CLI A-M-D grouping instead of patch order", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: existing.txt
@@
-before
+after
*** Add File: created.txt
+created
*** End Patch
PATCH`;
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA created.txt\nM existing.txt";
	const viewModel = await buildViewModel({ tool, command, text: successText });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: successText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch Add file created.txt",
		"apply_patch Update file existing.txt",
	]);
});

test("renderCall records the start time once execution begins", async () => {
	const { tool } = await loadRegisteredTool();
	const state = {};
	tool.renderCall(
		{ command: MULTI_OPERATION_COMMAND },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: false, state }),
	);
	assert.equal(state.startedAt, undefined);
	tool.renderCall(
		{ command: MULTI_OPERATION_COMMAND },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state }),
	);
	assert.equal(typeof state.startedAt, "number");
});

test("renderCall memoizes plan recognition per command string", async () => {
	const { tool } = await loadRegisteredTool();
	const state = {};
	const context = createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state });
	tool.renderCall({ command: MULTI_OPERATION_COMMAND }, createTheme(), context);
	assert.equal(state.planCache.command, MULTI_OPERATION_COMMAND);
	assert.ok(state.planCache.plan);
	// 同一 command 第二帧命中缓存：plan 对象同一（识别器未重跑）。
	const plan = state.planCache.plan;
	tool.renderCall({ command: MULTI_OPERATION_COMMAND }, createTheme(), context);
	assert.equal(state.planCache.plan, plan);
	// 不同 command 失效（非 plan 命令的 undefined 也缓存）。
	tool.renderCall({ command: "echo hi" }, createTheme(), context);
	assert.equal(state.planCache.command, "echo hi");
	assert.equal(state.planCache.plan, undefined);
});

test("renderCall memoizes highlight segments per command string", async () => {
	const { tool } = await loadRegisteredTool();
	const state = {};
	const context = createContext("echo hi", { executionStarted: true, state });
	tool.renderCall({ command: "echo hi" }, createTheme(), context);
	assert.equal(state.segCache.command, "echo hi");
	const segs = state.segCache.segs;
	// 同一 command 第二帧命中缓存：seg 数组同一（词法未重扫）。
	tool.renderCall({ command: "echo hi" }, createTheme(), context);
	assert.equal(state.segCache.segs, segs);
});

const LONG_COMMAND = "echo start\n" + "x".repeat(2000);

test("long command renders in full without truncation", async () => {
	const { tool } = await loadRegisteredTool();
	const state = {};
	const context = createContext(LONG_COMMAND, { executionStarted: true, state });
	const output = renderText(tool.renderCall({ command: LONG_COMMAND }, createTheme(), context));
	// 命令完整显示（与 built-in 一致）：尾部可见，无截断标记与提示。
	assert.ok(output.includes("x".repeat(20)), "command tail must be visible");
	assert.ok(!output.includes("…"), "full view must not show a truncation marker");
	assert.ok(!output.includes("hidden"), "full view must not show a truncation hint");
});

test("renderCall reuses the highlight Text instance across frames", async () => {
	const { tool } = await loadRegisteredTool();
	const state = {};
	const context = createContext("echo hi", { executionStarted: true, state });
	const first = tool.renderCall({ command: "echo hi" }, createTheme(), context);
	// 第二帧：pi 传入上一帧组件作为 lastComponent → 同一实例复用（setText 原地更新）。
	const second = tool.renderCall({ command: "echo hi" }, createTheme(), { ...context, lastComponent: first });
	assert.equal(second, first);
});

test("renderCall reuses the empty container across frames", async () => {
	const { tool } = await loadRegisteredTool();
	const state = {};
	const context = createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state });
	const first = tool.renderCall({ command: MULTI_OPERATION_COMMAND }, createTheme(), context);
	const second = tool.renderCall({ command: MULTI_OPERATION_COMMAND }, createTheme(), { ...context, lastComponent: first });
	assert.equal(second, first);
});

test("successful result renders the wall-clock runtime", async () => {
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: successText });
	const state = { startedAt: Date.now() - 30_100 };
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: successText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state }),
	));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"Took 30.1s",
	]);
});

test("partial result ticks Elapsed and the final render freezes Took", async () => {
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: successText });
	const state = {};
	const result = {
		content: [{ type: "text", text: successText }],
		details: detailsWith(viewModel),
	};
	try {
		tool.renderCall(
			{ command: MULTI_OPERATION_COMMAND },
			createTheme(),
			createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state }),
		);
		const partial = renderText(tool.renderResult(
			result,
			{ expanded: false, isPartial: true },
			createTheme(),
			createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state }),
		));
		assert.match(partial, /Elapsed \d+\.\ds/);
		assert.ok(state.interval, "partial render starts the 1s ticking interval");

		const final = renderText(tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			createTheme(),
			createContext(MULTI_OPERATION_COMMAND, { executionStarted: true, state }),
		));
		assert.match(final, /Took \d+\.\ds/);
		assert.equal(state.interval, undefined, "final render stops the interval");
		assert.equal(typeof state.endedAt, "number", "final render freezes endedAt");
	} finally {
		// 断言失败时也不泄漏 interval（测试进程保持存活）。
		if (state.interval) clearInterval(state.interval);
	}
});

test("result without renderer state omits the runtime line", async () => {
	const { tool } = await loadRegisteredTool();
	const successText = "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts";
	const viewModel = await buildViewModel({ tool, command: MULTI_OPERATION_COMMAND, text: successText });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: successText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assert.doesNotMatch(output, /Elapsed|Took/);
});

test("failure JSON short-circuits and renders the failure UI", async () => {
	// apply_patch 失败后后续命令（echo 等）让 bash 整体 exit 0（isError=false）：
	// 失败 JSON 仍是事实，必须渲染失败 UI，后续输出归入 trailing。
	const command = `cd /tmp/temp && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: first.txt
+first
*** Update File: missing.txt
@@
-before
+after
*** End Patch
PATCH
echo "exit=$?"`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: {
			code: "FILE_NOT_FOUND",
			message: "resolve file to update missing.txt: no such file or directory",
			hunk: { index: 1, operation: "update", path: "missing.txt" },
		},
		appliedPrefix: [{ index: 0, operation: "add", path: "first.txt" }],
	};
	const { tool } = await loadRegisteredTool();
	const failureText = `${JSON.stringify(failure)}\nexit=1`;
	const viewModel = await buildViewModel({ tool, command, text: failureText });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: failureText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: false }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed FILE_NOT_FOUND",
		"applied:",
		"apply_patch Add file first.txt",
		"unapplied:",
		"Update file missing.txt",
		"exit=1",
	]);
	assert.doesNotMatch(output, /"ok":false/);
});

test("failed result renders appliedPrefix and the failed hunk", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: first.txt
+first
*** Update File: missing.txt
@@
-before
+after
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: {
			code: "CONTEXT_NOT_FOUND",
			message: "Failed to find expected lines in missing.txt",
			hunk: { index: 1, operation: "update", path: "missing.txt", chunkIndex: 0 },
		},
		appliedPrefix: [{ index: 0, operation: "add", path: "first.txt" }],
	};
	const { tool } = await loadRegisteredTool();
	const failureText = `${JSON.stringify(failure)}\n\nCommand exited with code 1`;
	const viewModel = await buildViewModel({ tool, command, text: failureText });
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: failureText }],
			details: detailsWith(viewModel),
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed CONTEXT_NOT_FOUND",
		"Failed to find expected lines in missing.txt",
		"failed update missing.txt · chunk 0",
		"applied:",
		"apply_patch Add file first.txt",
		"unapplied:",
		"Update file missing.txt",
	]);
});

test("context-only update renders the locally recognized operation and chunk", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/context-only.ts
@@
 export const unchanged = true;
*** End Patch
PATCH`;
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assertAppearsInOrder(output, [
		"apply_patch Update file src/context-only.ts",
		"chunk 0 · no +/- lines · must contain an insertion or deletion",
	]);
	assert.match(output, /^\$ apply_patch/);
});

test("mixed update renders only the context-only chunk warning", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/mixed.ts
@@
-export const before = true;
+export const after = true;
@@
 export const contextOnly = true;
*** End Patch
PATCH`;
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.match(output, /apply_patch Update file src\/mixed\.ts \+1 -1/);
	assert.equal(output.match(/no \+\/- lines/g)?.length, 1);
	assert.match(output, /chunk 1 · no \+\/- lines · must contain an insertion or deletion/);
});

test("context-only CLI failure uses the compact result renderer", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/context-only.ts
@@
 export const unchanged = true;
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: {
			code: "INVALID_PATCH",
			message: "Invalid patch hunk on line 4: Update hunk must contain an insertion or deletion",
			hunk: { index: 0, operation: "update", path: "src/context-only.ts", chunkIndex: 0 },
		},
		appliedPrefix: [],
	};
	const { tool } = await loadRegisteredTool();
	const failureText = JSON.stringify(failure);
	const viewModel = await buildViewModel({ tool, command, text: failureText });
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: failureText }], details: detailsWith(viewModel) },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed INVALID_PATCH",
		"Update hunk must contain an insertion or deletion",
		"failed update src/context-only.ts · chunk 0",
	]);
	assert.match(output, /^\$ apply_patch/);
});

test("compound shell commands with cd prefix are recognized as apply_patch", async () => {
	const command = `cd nested && ${MULTI_OPERATION_COMMAND}`;
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	assert.match(output, /^\$ cd nested && apply_patch/);
});

test("apply_patch heredoc followed by additional shell commands is recognized", async () => {
	const command = `${MULTI_OPERATION_COMMAND}\nuv run pytest -q`;
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	assert.doesNotMatch(output, /uv run pytest/);
});

test("multiple apply_patch heredocs after cd prefix and trailing test command are recognized", async () => {
	const command = `cd nested && ${MULTI_OPERATION_COMMAND}\n${MULTI_OPERATION_COMMAND}\nuv run pytest -q`;
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.equal(output.match(/apply_patch Add file src\/new\.ts/g)?.length, 2);
	assert.equal(output.match(/apply_patch Update file src\/old\.ts/g)?.length, 2);
	assert.doesNotMatch(output, /uv run pytest/);
});

test("multiple apply_patch results render each invocation independently", async () => {
	const updatePatch = (file, lines) => [
		"apply_patch <<'PATCH'",
		"*** Begin Patch",
		`*** Update File: ${file}`,
		"@@",
		...lines,
		"*** End Patch",
		"PATCH",
	].join("\n");
	const command = [
		updatePatch("src/first.ts", [" context only"]),
		updatePatch("src/second.ts", ["-before", "+after"]),
		updatePatch("src/third.ts", [" context only"]),
		"uv run pytest -q",
	].join("\n");
	const failures = ["src/first.ts", "src/third.ts"].map((file, index) => JSON.stringify({
		ok: false,
		exitCode: 1,
		error: {
			code: "INVALID_PATCH",
			message: `Invalid patch hunk ${index + 1}: Update hunk must contain an insertion or deletion`,
			hunk: { index: 0, operation: "update", path: file, chunkIndex: 0 },
		},
		appliedPrefix: [],
	}));
	// 执行者架构：inv1 失败即短路（&& 语义），VM 只有第一个 failure 块。
	const resultText = failures[0];
	const { tool } = await loadRegisteredTool();
	const details = detailsWith(await buildViewModel({ tool, command, text: resultText }));
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: resultText }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"failed update src/first.ts · chunk 0",
		"Update file src/first.ts",
	]);
	assert.doesNotMatch(output, /src\/second\.ts|src\/third\.ts|ERROR: not found/);
	assert.doesNotMatch(output, /\{"ok":false|Success\. Updated the following files:/);
});

test("consecutive successful patches to one file render as one aggregated file result", async () => {
	const updatePatch = (before, after) => [
		"apply_patch <<'PATCH'",
		"*** Begin Patch",
		"*** Update File: src/repeated.ts",
		"@@",
		`-${before}`,
		`+${after}`,
		"*** End Patch",
		"PATCH",
	].join("\n");
	const transitions = [
		["one", "two"],
		["two", "three"],
		["three", "four"],
		["four", "five"],
		["five", "six"],
		["six", "seven"],
	];
	const command = [...transitions.map(([before, after]) => updatePatch(before, after)), "npm test"].join("\n");
	const success = "Success. Updated the following files:\nM src/repeated.ts";
	const resultText = `${transitions.map(() => success).join("\n")}\nFAIL src/repeated.test.ts`;
	const { tool } = await loadRegisteredTool();
	const details = detailsWith(await buildViewModel({ tool, command, text: resultText }));
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: resultText }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assert.match(output, /apply_patch Update file src\/repeated\.ts · \+6 -6 · 6 patches/);
	assert.equal(output.match(/apply_patch Update file src\/repeated\.ts/g)?.length, 1);
	assert.match(output, /FAIL src\/repeated\.test\.ts/);
	assert.doesNotMatch(output, /Success\. Updated the following files:/);

	const expanded = renderText(tool.renderResult(
		{ content: [{ type: "text", text: resultText }], details },
		{ expanded: true, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true, expanded: true }),
	));
	assert.equal(expanded.match(/apply_patch Update file src\/repeated\.ts/g)?.length, 6);
});




test("completed result renders concrete line numbers from the before snapshot", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "target.ts"), "const left = oldLeft + oldRight;\nnext();\n", "utf8");
	const command = `cd ${temp} && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: target.ts
@@
-const left = oldLeft + oldRight;
+const left = newLeft + newRight;
*** End Patch
PATCH`;
	const toolCallId = "line-number-check";
	const { tool, handlers } = await loadRegisteredTool();
	const result = await runWithEvents(toolCallId, command, tool, handlers);

	const output = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));
	const lines = output.split("\n");
	const headerIndex = lines.findIndex((line) => line.includes("apply_patch Update file target.ts"));
	const diffIndex = lines.findIndex((line) => line.includes("-1   │ const left"));
	assert.equal(diffIndex - headerIndex, 1, output);
	assert.match(output, /-1   │ const left = oldLeft \+ oldRight;/);
	assert.match(output, /\+  1 │ const left = newLeft \+ newRight;/);
	assert.match(output, / 2 2 │ next\(\);/);
});

test("completed result keeps old and new context coordinates after inserted lines", async ({ temp }) => {
	const source = ["stems = values", "rows = [", "{", "}", ...Array.from({ length: 8 }, (_, index) => `tail${index + 1}`)].join("\n") + "\n";
	await fs.promises.writeFile(path.join(temp, "target.py"), source, "utf8");
	const command = `cd ${temp} && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: target.py
@@
-rows = [
+ordered = sorted(
+    values,
+)
+return [
*** End Patch
PATCH`;
	const toolCallId = "divergent-line-number-check";
	const { tool, handlers } = await loadRegisteredTool();
	const result = await runWithEvents(toolCallId, command, tool, handlers);
	const output = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));

	assert.match(output, /- 2    │ rows = \[/);
	assert.match(output, /\+    2 │ ordered = sorted\(/);
	assert.match(output, / 3  6 │ \{/);
	assert.match(output, /\.\.\. 8 unchanged lines omitted/);
});

test("batch renders the final located diff in collapsed and expanded views", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "state.txt"), "one\n", "utf8");
	const updatePatch = (before, after) => [
		"apply_patch <<'PATCH'",
		"*** Begin Patch",
		"*** Update File: state.txt",
		"@@",
		`-${before}`,
		`+${after}`,
		"*** End Patch",
		"PATCH",
	].join("\n");
	const command = `cd ${temp} && ${updatePatch("one", "two")}\n${updatePatch("two", "three")}\nprintf 'checks done\\n'`;
	const toolCallId = "batch-final-diff";
	const { tool, handlers } = await loadRegisteredTool();
	const result = await runWithEvents(toolCallId, command, tool, handlers);
	const collapsed = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));

	assert.match(collapsed, /apply_patch Update file state\.txt · \+1 -1 · 2 patches/);
	assert.match(collapsed, /-1   │ one/);
	assert.match(collapsed, /\+  1 │ three/);
	assert.doesNotMatch(collapsed, /two/);
	assert.match(collapsed, /\$ printf/);
	assert.match(collapsed, /checks done/);

	const expanded = renderText(tool.renderResult(
		result,
		{ expanded: true, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true, expanded: true }),
	));
	assert.match(expanded, /-1   │ one/);
	assert.match(expanded, /\+  1 │ three/);
	assert.doesNotMatch(expanded, /two/);
});

test("collapsed diffs keep two context lines around every change group", async ({ temp }) => {
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	await fs.promises.writeFile(path.join(temp, "big.txt"), `${lines}\n`, "utf8");
	const command = `cd ${temp} && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: big.txt
@@
-line 0
+line zero
@@
-line 10
+line ten
@@
-line 20
+line twenty
*** End Patch
PATCH`;
	const toolCallId = "diff-collapse";
	const { tool, handlers } = await loadRegisteredTool();
	const result = await runWithEvents(toolCallId, command, tool, handlers);

	const output = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));
	assert.match(output, /- 1    │ line 0/);
	assert.match(output, /\+    1 │ line zero/);
	assert.match(output, /  9  9 │ line 8/);
	assert.match(output, / 10 10 │ line 9/);
	assert.match(output, /-11    │ line 10/);
	assert.match(output, /\+   11 │ line ten/);
	assert.match(output, / 12 12 │ line 11/);
	assert.match(output, / 13 13 │ line 12/);
	assert.match(output, /-21    │ line 20/);
	assert.match(output, /\+   21 │ line twenty/);
	assert.doesNotMatch(output, /more diff lines/);
});

test("ordinary shell commands retain the built-in bash renderer", async () => {
	const command = "printf 'ok'";
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.match(output, /^\$ printf/);
	assert.doesNotMatch(output, /apply_patch applied/);
});

test("ordinary shell commands show the built-in runtime line once execution starts", async () => {
	const command = "printf 'ok'";
	const { tool } = await loadRegisteredTool();
	const state = {};
	tool.renderCall(
		{ command },
		createTheme(),
		createContext(command, { executionStarted: true, state }),
	);
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, state }),
	));

	assert.match(output, /ok/);
	assert.match(output, /Took \d+\.\ds/);
	assert.equal(state.interval, undefined);
	assert.equal(typeof state.endedAt, "number");
});



test("executing render clears the pending call slot", async () => {
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderCall(
		{ command: MULTI_OPERATION_COMMAND },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));
	assert.doesNotMatch(output, /apply_patch 4 operations/);
	assert.doesNotMatch(output, /^\$ apply_patch/);
});

async function buildDetailsViaHandlers(toolCallId, command, tool, text, { cwd, isError = false, withBefore = false, withAfter = false } = {}) {
	// 执行者架构：details 由 execute 产出；渲染测试直接构造等价 payload（VM 形状契约不变）。
	const viewModel = await buildViewModel({ tool, command, text, cwd, withBefore, withAfter });
	return detailsWith(viewModel);
}

test("delete followed by add of the same file renders a single rewrite", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old content\n");
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Delete File: a.txt
*** Add File: a.txt
+new content
*** End Patch
PATCH`;
	const { tool } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("rewrite-call", command, tool,
		"Success. Updated the following files:\nD a.txt\nA a.txt", { cwd: temp, withBefore: true });
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: "Success. Updated the following files:\nD a.txt\nA a.txt" }], details, isError: false },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true }),
	));

	assert.match(output, /apply_patch Rewrite file a\.txt/);
	assert.equal(output.match(/apply_patch (?:Delete|Add) file a\.txt/g)?.length ?? 0, 0);
});

test("failure appliedPrefix renders engine content without before snapshots", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** Update File: missing.txt
@@
-x
+y
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: { code: "FILE_NOT_FOUND", message: "resolve file to update missing.txt", hunk: { index: 1, operation: "update", path: "missing.txt" } },
		appliedPrefix: [{
			index: 0,
			operation: "update",
			path: "a.txt",
			oldContent: "alpha\nold\nomega\n",
			newContent: "alpha\nnew\nomega\n",
		}],
	};
	const { tool } = await loadRegisteredTool();
	const details = detailsWith(await buildViewModel({ tool, command, text: JSON.stringify(failure) }));
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(failure) }], details, isError: true },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed FILE_NOT_FOUND",
		"applied:",
		"apply_patch Update file a.txt",
		"alpha",
		"omega",
	]);
});

test("failure path merges delete and add of the same file into one rewrite", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old content\n");
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Delete File: a.txt
*** Add File: a.txt
+new content
*** Update File: missing.txt
@@
-x
+y
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: { code: "FILE_NOT_FOUND", message: "resolve file to update missing.txt", hunk: { index: 2, operation: "update", path: "missing.txt" } },
		appliedPrefix: [
			{ index: 0, operation: "delete", path: "a.txt" },
			{ index: 1, operation: "add", path: "a.txt" },
		],
	};
	const { tool } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("rewrite-fail-call", command, tool, JSON.stringify(failure), { cwd: temp, withBefore: true });
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(failure) }], details, isError: true },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assert.match(output, /apply_patch Rewrite file a\.txt/);
	assert.equal(output.match(/apply_patch (?:Delete|Add) file a\.txt/g)?.length ?? 0, 0);
});

test("failure renders skipped operations with reasons", async () => {
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: good.txt
@@
-old
+new
*** Add File: bad.txt
not a plus line
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-x
+y
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: { code: "FILE_NOT_FOUND", message: "resolve file to update missing.txt", hunk: { index: 3, operation: "update", path: "missing.txt" } },
		appliedPrefix: [
			{ index: 0, operation: "update", path: "good.txt", oldContent: "old\n", newContent: "new\n" },
			{ index: 2, operation: "add", path: "created.txt" },
		],
		skipped: [{
			hunk: {
				index: 1,
				operation: "add",
				path: "bad.txt",
			},
			message: "Invalid patch hunk on line 7: Add File lines must start with '+'",
		}],
	};
	const { tool } = await loadRegisteredTool();
	const details = detailsWith(await buildViewModel({ tool, command, text: JSON.stringify(failure) }));
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(failure) }], details, isError: true },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed FILE_NOT_FOUND",
		"applied:",
		"apply_patch Update file good.txt",
		"apply_patch Add file created.txt",
		"skipped:",
		"Add file bad.txt",
		"Invalid patch hunk on line 7",
		"unapplied:",
		"Update file missing.txt",
	]);
	assert.doesNotMatch(output, /unapplied:[\s\S]*bad\.txt/);
});

test("failure preserves CLI hunk indexes across an unparseable skipped operation", async () => {
	const trailingSpace = " ";
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: bad.txt${trailingSpace}
+bad
*** Update File: good.txt
@@
-old
+new
*** Update File: missing.txt
@@
-x
+y
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: { code: "FILE_NOT_FOUND", message: "resolve file to update missing.txt", hunk: { index: 2, operation: "update", path: "missing.txt" } },
		appliedPrefix: [
			{ index: 1, operation: "update", path: "good.txt", oldContent: "old\n", newContent: "new\n" },
		],
		skipped: [{
			hunk: { index: 0 },
			message: "Invalid patch hunk on line 2: file path must not have leading or trailing whitespace",
		}],
	};
	const { tool } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers(
		"unparseable-skipped-call",
		command,
		tool,
		JSON.stringify(failure),
		{ cwd: "/tmp/pi-bash-ui-workspace" },
	);
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(failure) }], details, isError: true },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed FILE_NOT_FOUND",
		"applied:",
		"apply_patch Update file good.txt",
		"skipped:",
		"unapplied:",
		"Update file missing.txt",
	]);
	assert.doesNotMatch(output, /\"ok\":false/);
});

test("context mismatch renders expected vs actual lines when expanded", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "actual line one\nactual line two\n");
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: a.txt
@@
-expected line
+changed
*** End Patch
PATCH`;
	const failure = {
		ok: false,
		exitCode: 1,
		error: {
			code: "CONTEXT_NOT_FOUND",
			message: "Failed to find expected lines in a.txt:\nexpected line",
			hunk: { index: 0, operation: "update", path: "a.txt", chunkIndex: 0 },
		},
		appliedPrefix: [],
	};
	const { tool } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("mismatch-call", command, tool, JSON.stringify(failure), { cwd: temp, withBefore: true });
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(failure) }], details, isError: true },
		{ expanded: true, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed CONTEXT_NOT_FOUND",
		"expected:",
		"expected line",
		"actual:",
		"actual line one",
	]);
});

test("batch delete then add across invocations merges into one rewrite", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n");
	const command = `apply_patch <<'PATCH1'
*** Begin Patch
*** Delete File: a.txt
*** End Patch
PATCH1
apply_patch <<'PATCH2'
*** Begin Patch
*** Add File: a.txt
+new
*** End Patch
PATCH2`;
	const text = "Success. Updated the following files:\nD a.txt\nSuccess. Updated the following files:\nA a.txt";
	const { tool } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("batch-rewrite-call", command, tool, text, { cwd: temp, withBefore: true });
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text }], details, isError: false },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true }),
	));

	assert.match(output, /apply_patch Rewrite file a\.txt/);
	assert.equal(output.match(/apply_patch (?:Delete|Add) file a\.txt/g)?.length ?? 0, 0);
});

test("multi-chunk single-file patch builds a structured result (CLI dedups per file)", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "chunks.ts"), "first();\nsecond();\nthird();\n", "utf8");
	const command = `cd ${temp} && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: chunks.ts
@@
-first();
+firstChanged();
@@
-third();
+thirdChanged();
*** End Patch
PATCH`;
	const toolCallId = "multi-chunk-single-file";
	const { tool, handlers } = await loadRegisteredTool();
	const result = await runWithEvents(toolCallId, command, tool, handlers);
	assert.ok(result.details, "tool_result 应注入结构化 view model");

	const output = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));
	assert.equal(output.match(/apply_patch Update file chunks\.ts/g)?.length, 1);
	assert.match(output, /-1   │ first\(\);/);
	assert.match(output, /\+  1 │ firstChanged\(\);/);
	assert.match(output, /-3   │ third\(\);/);
	assert.match(output, /\+  3 │ thirdChanged\(\);/);
	assert.doesNotMatch(output, /Success\. Updated the following files:/);
});

test("execute runs invocations, trailing and returns the view model in details", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "stream.ts"), "oldValue;\n", "utf8");
	const command = `cd ${temp} && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: stream.ts
@@
-oldValue;
+newValue;
*** End Patch
PATCH
printf 'pytest 1 passed'`;
	const toolCallId = "stream-cache";
	const { tool } = await loadRegisteredTool();
	// 执行者架构：execute 自己完成快照 bracket + 执行 + trailing + VM。
	const result = await tool.execute(
		toolCallId,
		{ command },
		undefined,
		() => {},
		createExecutionContext(temp),
	);
	assert.ok(result.content, "expected execute output");
	assert.match(result.content[0].text, /Success\. Updated the following files:/);
	assert.ok(result.details?.bashUi, "execute 应注入结构化 view model");
	// 长尾命令副作用改写了文件：视图不得重读（diff 保持执行时 bracket 的状态，渲染层只消费 details）。
	await fs.promises.writeFile(path.join(temp, "stream.ts"), "rewrittenByTailCommand;\n", "utf8");
	const context = createContext(command, { toolCallId, executionStarted: true });
	const completed = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		context,
	));
	assert.match(completed, /apply_patch Update file stream\.ts/);
	assert.match(completed, /-1   │ oldValue;/);
	assert.doesNotMatch(completed, /rewrittenByTailCommand/);
	assert.match(completed, /pytest 1 passed/);
});
