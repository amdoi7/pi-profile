import { test as baseTest } from "vitest";
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
		process.on("exit", () => {
			if (sharedExtensionRoot) {
				fs.rmSync(sharedExtensionRoot, { recursive: true, force: true });
			}
		});
	}
	const temp = sharedExtensionRoot;
	const tempExtensionDir = path.join(temp, "extension");
	const tempToolDir = path.join(tempExtensionDir, "bash-ui");
	await fs.promises.cp(sourceDir, tempToolDir, { recursive: true });
	await copySharedFiles(path.join(tempExtensionDir, "_shared"), [
		"code-preview.ts",
		"file-link.ts",
		"final-diff.ts",
		"ffi-diff.ts",
		"diff-view.ts",
		"file-mutation-view.ts",
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
	return { tool: registeredTool, handlers };
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

async function runWithEvents(toolCallId, command, tool, handlers, { cwd = process.cwd() } = {}) {
	// tool_call：捕获 before 快照
	for (const handler of handlers["tool_call"] ?? []) {
		await handler({ toolName: "bash", toolCallId, input: { command } }, { cwd, mode: "tui" });
	}
	const result = await tool.execute(
		toolCallId,
		{ command },
		undefined,
		undefined,
		createExecutionContext(cwd),
	);
	// tool_result：注入结构化 view model
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId, input: { command }, content: result.content, isError: false },
			{ cwd },
		);
		if (outcome?.details) details = outcome.details;
	}
	return { ...result, details };
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
	assert.doesNotMatch(output, /^\$ apply_patch /);
});

test("completed TUI row replaces the raw patch call with the confirmed result UI", async () => {
	const { tool } = await loadRegisteredTool();
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
		content: [{
			type: "text",
			text: "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts",
		}],
		details: undefined,
		isError: false,
	});

	const output = stripTerminalFormatting(row.render(120).join("\n"));
	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"apply_patch Update file src/old.ts",
		"apply_patch Move file src/from.ts -> src/to.ts",
		"apply_patch Delete file src/dead.ts",
	]);
	assert.doesNotMatch(output, /\$ apply_patch|\*\*\* Begin Patch/);
});

test("successful result renders confirmed affected paths", async () => {
	const { tool } = await loadRegisteredTool();
	const context = createContext(MULTI_OPERATION_COMMAND, { executionStarted: true });
	const output = renderText(tool.renderResult(
		{
			content: [{
				type: "text",
				text: "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts",
			}],
			details: undefined,
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
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: mixedOutput }],
			details: undefined,
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
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: mixedOutput }],
			details: undefined,
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
	assert.doesNotMatch(output, /^\$ apply_patch/);
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
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: mixedOutput }],
			details: undefined,
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
	const output = renderText(tool.renderResult(
		{
			content: [{
				type: "text",
				text: "Success. Updated the following files:\nM src/only.ts",
			}],
			details: undefined,
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
	const output = renderText(tool.renderResult(
		{
			content: [{
				type: "text",
				text: "Success. Updated the following files:\nA created.txt\nM existing.txt",
			}],
			details: undefined,
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

test("successful result renders elapsed time above the threshold", async () => {
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderResult(
		{
			content: [{
				type: "text",
				text: "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts\n\nElapsed 30.1s",
			}],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch Add file src/new.ts",
		"elapsed 30.1s",
	]);
});

test("successful result omits elapsed time below the threshold", async () => {
	const { tool } = await loadRegisteredTool();
	const output = renderText(tool.renderResult(
		{
			content: [{
				type: "text",
				text: "Success. Updated the following files:\nA src/new.ts\nM src/old.ts\nM src/to.ts\nD src/dead.ts\n\nElapsed 0.3s",
			}],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(MULTI_OPERATION_COMMAND, { executionStarted: true }),
	));

	assert.doesNotMatch(output, /elapsed/);
});

test("failure JSON with a successful overall exit still renders the failure UI", async () => {
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
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: `${JSON.stringify(failure)}\nexit=1` }],
			details: undefined,
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
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: `${JSON.stringify(failure)}\n\nCommand exited with code 1` }],
			details: undefined,
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
	assert.doesNotMatch(output, /^\$ apply_patch/);
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

	assert.match(output, /apply_patch Update file src\/mixed\.ts 2 changed · \+1 · -1/);
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
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(failure) }], details: undefined },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"apply_patch failed INVALID_PATCH",
		"Update hunk must contain an insertion or deletion",
		"failed update src/context-only.ts · chunk 0",
	]);
	assert.doesNotMatch(output, /^\$ apply_patch/);
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
	assert.doesNotMatch(output, /^\$ cd nested && apply_patch/);
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
	const resultText = [
		failures[0],
		"Success. Updated the following files:",
		"M src/second.ts",
		failures[1],
		"ERROR: not found: test_missing",
		"Command exited with code 4",
	].join("\n");
	const { tool, handlers } = await loadRegisteredTool();
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId: "batch-result", input: { command }, content: [{ type: "text", text: resultText }], isError: true },
			{ cwd: "/tmp/pi-bash-ui-workspace" },
		);
		if (outcome?.details) details = outcome.details;
	}
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: resultText }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assertAppearsInOrder(output, [
		"failed update src/first.ts · chunk 0",
		"Update file src/first.ts",
		"apply_patch Update file src/second.ts · 2 changed · +1 · -1",
		"failed update src/third.ts · chunk 0",
		"Update file src/third.ts",
		"ERROR: not found: test_missing",
	]);
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
	const { tool, handlers } = await loadRegisteredTool();
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId: "repeated-success", input: { command }, content: [{ type: "text", text: resultText }], isError: true },
			{ cwd: "/tmp/pi-bash-ui-workspace" },
		);
		if (outcome?.details) details = outcome.details;
	}
	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: resultText }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { executionStarted: true, isError: true }),
	));

	assert.match(output, /apply_patch Update file src\/repeated\.ts · 12 changed · \+6 · -6 · 6 patches/);
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

	assert.match(collapsed, /apply_patch Update file state\.txt · 2 changed · \+1 · -1 · 2 patches/);
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

async function buildDetailsViaHandlers(toolCallId, command, handlers, text, { cwd, isError = false } = {}) {
	for (const handler of handlers["tool_call"] ?? []) {
		await handler({ toolName: "bash", toolCallId, input: { command } }, { cwd, mode: "tui" });
	}
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId, input: { command }, content: [{ type: "text", text }], isError },
			{ cwd },
		);
		if (outcome?.details) details = outcome.details;
	}
	return details;
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
	const { tool, handlers } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("rewrite-call", command, handlers,
		"Success. Updated the following files:\nD a.txt\nA a.txt", { cwd: temp });
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
	const { tool, handlers } = await loadRegisteredTool();
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId: "content-call", input: { command }, content: [{ type: "text", text: JSON.stringify(failure) }], isError: true },
			{ cwd: "/tmp/pi-bash-ui-workspace" },
		);
		if (outcome?.details) details = outcome.details;
	}
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
	const { tool, handlers } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("rewrite-fail-call", command, handlers, JSON.stringify(failure), { cwd: temp, isError: true });
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
	const { tool, handlers } = await loadRegisteredTool();
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId: "skipped-call", input: { command }, content: [{ type: "text", text: JSON.stringify(failure) }], isError: true },
			{ cwd: "/tmp/pi-bash-ui-workspace" },
		);
		if (outcome?.details) details = outcome.details;
	}
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
	const { tool, handlers } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers(
		"unparseable-skipped-call",
		command,
		handlers,
		JSON.stringify(failure),
		{ cwd: "/tmp/pi-bash-ui-workspace", isError: true },
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
	const { tool, handlers } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("mismatch-call", command, handlers, JSON.stringify(failure), { cwd: temp, isError: true });
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
	const { tool, handlers } = await loadRegisteredTool();
	const details = await buildDetailsViaHandlers("batch-rewrite-call", command, handlers, text, { cwd: temp });
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

test("streaming renders the patch once and reuses the cached view model on later chunks", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "stream.ts"), "oldValue;\n", "utf8");
	const command = `cd ${temp} && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: stream.ts
@@
-oldValue;
+newValue;
*** End Patch
PATCH`;
	const toolCallId = "stream-cache";
	const { tool, handlers } = await loadRegisteredTool();
	for (const handler of handlers["tool_call"] ?? []) {
		await handler({ toolName: "bash", toolCallId, input: { command } }, { cwd: temp, mode: "tui" });
	}
	const context = createContext(command, { toolCallId, executionStarted: true, isPartial: true });

	const first = renderText(tool.renderResult(
		{ content: [{ type: "text", text: "Success. Updated the following files:\nM stream.ts" }], details: undefined },
		{ expanded: false, isPartial: true },
		createTheme(),
		context,
	));
	assert.match(first, /apply_patch Update file stream\.ts/);
	assert.match(first, /-\s+│ oldValue;/);

	// 长尾命令副作用改写了文件：缓存视图不得重读文件（diff 保持构建时的状态）。
	await fs.promises.writeFile(path.join(temp, "stream.ts"), "rewrittenByTailCommand;\n", "utf8");

	const second = renderText(tool.renderResult(
		{ content: [{ type: "text", text: "Success. Updated the following files:\nM stream.ts\n\npytest 1 passed" }], details: undefined },
		{ expanded: false, isPartial: true },
		createTheme(),
		context,
	));
	assert.match(second, /-\s+│ oldValue;/);
	assert.doesNotMatch(second, /rewrittenByTailCommand/);
	assert.match(second, /pytest 1 passed/);

	// tool_result 复用流式缓存（不重建、不重读），trailing 用完整输出刷新。
	let details;
	for (const handler of handlers["tool_result"] ?? []) {
		const outcome = await handler(
			{ toolName: "bash", toolCallId, input: { command }, content: [{ type: "text", text: "Success. Updated the following files:\nM stream.ts\n\npytest 1 passed" }], isError: false },
			{ cwd: temp },
		);
		if (outcome?.details) details = outcome.details;
	}
	const completed = renderText(tool.renderResult(
		{ content: [{ type: "text", text: "Success. Updated the following files:\nM stream.ts\n\npytest 1 passed" }], details },
		{ expanded: false, isPartial: false },
		createTheme(),
		context,
	));
	assert.match(completed, /-\s+│ oldValue;/);
	assert.doesNotMatch(completed, /rewrittenByTailCommand/);
	assert.match(completed, /pytest 1 passed/);
});
