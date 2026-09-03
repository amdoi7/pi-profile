import { test } from "vitest";
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
} from "../../test-helpers/runtime-paths.mjs";

const piPackageDir = resolvePiPackageDir("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent } = await import(packageFileUrl(piPackageDir, "dist/index.js"));
const { initTheme } = await import(packageFileUrl(piPackageDir, "dist/modes/interactive/theme/theme.js"));

const sourceDir = extensionDir("edit");
const TOOL_CALL_ID = "tool-call-1";

async function loadRegisteredEditTool() {
	const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-render-result-"));
	const tempExtensionDir = path.join(tempRoot, "extension");
	const tempEditDir = path.join(tempExtensionDir, "edit");
	const tempSharedDir = path.join(tempExtensionDir, "_shared");
	await fs.promises.cp(sourceDir, tempEditDir, {
		recursive: true,
		// 临时扩展只需要运行时文件：node_modules 由 linkPiPackages 重建，tests 用不上。
		filter: (source) => !["node_modules", "tests"].includes(path.basename(source)),
	});
	await copySharedFiles(tempSharedDir, ["file-link.ts", "code-preview.ts", "final-diff.ts", "diff-view.ts", "file-mutation-view.ts", "file-result.ts"]);
	await linkPiPackages(tempExtensionDir, { tui: true });
	await linkSharedPackages(tempExtensionDir);
	for (const dep of ["typebox"]) {
		await fs.promises.mkdir(path.join(tempExtensionDir, "node_modules"), { recursive: true });
		await fs.promises.symlink(
			path.join(sourceDir, "node_modules", dep),
			path.join(tempExtensionDir, "node_modules", dep),
			"dir",
		);
	}

	const extensionModule = await import(`${pathToFileURL(path.join(tempEditDir, "index.ts")).href}?t=${Date.now()}`);
	let registeredTool;
	extensionModule.default({
		registerTool(definition) {
			registeredTool = definition;
		},
		on() {},
	});
	if (!registeredTool) {
		throw new Error("Failed to capture registered edit tool.");
	}
	return registeredTool;
}

const REASONING = "align settlement field names";

function makeArgs(entries) {
	return { note: REASONING, edits: entries };
}

function createTheme() {
	return {
		fg: (_name, text) => text,
		bg: (_name, text) => text,
		bold: (text) => text,
		inverse: (text) => `\x1b[7m${text}\x1b[27m`,
	};
}

function createRenderContext(overrides = {}) {
	return {
		args: {},
		toolCallId: TOOL_CALL_ID,
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function createToolExecutionComponent(tool, args) {
	const ui = { requestRender() {} };
	return new ToolExecutionComponent("edit", TOOL_CALL_ID, args, {}, tool, ui, process.cwd());
}

function renderRawText(component) {
	return component.render(120).join("\n");
}

function stripTerminalFormatting(text) {
	return text
		.replace(/\x1b\]8;;.*?(?:\x1b\\|\x07)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderText(component) {
	return stripTerminalFormatting(renderRawText(component));
}

function countOccurrences(text, needle) {
	return text.split(needle).length - 1;
}

function assertAppearsInOrder(text, fragments) {
	let lastIndex = -1;
	for (const fragment of fragments) {
		const nextIndex = text.indexOf(fragment, lastIndex + 1);
		assert.notEqual(nextIndex, -1, `expected to find ${fragment}`);
		assert.ok(nextIndex > lastIndex, `expected ${fragment} after prior fragment`);
		lastIndex = nextIndex;
	}
}

function replacementDisplay(line, before, after) {
	return {
		lineNumberWidth: String(line).length,
		rows: [
			{ kind: "remove", oldLine: line, content: before, highlights: before.length > 0 ? [{ start: 0, end: before.length }] : [] },
			{ kind: "add", newLine: line, content: after, highlights: after.length > 0 ? [{ start: 0, end: after.length }] : [] },
		],
	};
}

function contextDisplay(entries) {
	return {
		lineNumberWidth: String(Math.max(...entries.map(([line]) => line))).length,
		rows: entries.map(([line, content]) => ({ kind: "context", oldLine: line, newLine: line, content })),
	};
}

function appliedEntry(filePath, display, overrides = {}) {
	return {
		edit: { path: filePath, op: "replace" },
		status: "applied",
		changeStats: { additions: 1, deletions: 1, changedLines: 2 },
		display,
		truncated: false,
		firstChangedLine: 1,
		...overrides,
	};
}

/** execute 的真实结果形状：compact JSON content + 条目 details。 */
function buildAgentResult(entries, { status = "applied", cwd = process.cwd() } = {}) {
	return {
		content: [{ type: "text", text: JSON.stringify({ status }) }],
		isError: status === "rejected",
		details: { status, note: REASONING, cwd, entries },
	};
}

test("pending render shows the route and the planned entries without any diff text", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(
		tool.renderCall(
			makeArgs([
				{ path: "src/example.ts", op: "replace", old_str: "before", new_str: "after" },
				{ path: "src/other.ts", op: "insert", insert_line: 1, new_str: "right" },
			]),
			createTheme(),
			createRenderContext({ executionStarted: false, argsComplete: true, isPartial: false }),
		),
	);

	assertAppearsInOrder(output, ["edit", "src/example.ts", "src/other.ts"]);
	assert.match(output, /before → after/);
	assert.doesNotMatch(output, /-1 |\+1 /);
});

test("applied result attributes the tool once and lists one line per entry", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedEntry("src/example.ts", replacementDisplay(1, "before", "after"), {
				changeStats: { additions: 2, deletions: 1, changedLines: 3 },
			}),
			appliedEntry("src/other.ts", replacementDisplay(1, "left", "right")),
		]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.equal(countOccurrences(output, "edit"), 1, output);
	assertAppearsInOrder(output, ["edit", "src/example.ts · +2 -1", "src/other.ts · +1 -1"]);
});

test("production result renderer uses Pi native diff rendering", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedEntry("src/example.ts", replacementDisplay(10, "\tindented", "  indented"), { firstChangedLine: 10 }),
		]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /-10 {4}│ {4}indented/);
	assert.match(output, /\+ {3}10 │ {3}indented/);
});

test("each entry header sits directly above its own diff", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([appliedEntry("src/example.ts", replacementDisplay(1, "before", "after"))]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));
	const lines = output.split("\n");
	const headerIndex = lines.findIndex((line) => line.includes("src/example.ts"));
	const diffIndex = lines.findIndex((line) => line.trimStart().startsWith("-1 "));

	assert.equal(diffIndex - headerIndex, 1, output);
});

test("rejected sequence says nothing was written and marks the untouched entries", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			{ edit: { path: "src/skipped.ts", op: "replace" }, status: "skipped" },
			{ edit: { path: "src/stale.ts", op: "delete" }, status: "failed", error: "old_str was not found." },
		], { status: "rejected" }),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /rejected · nothing written/);
	assert.match(output, /src\/skipped\.ts · skipped/);
	assert.match(output, /old_str was not found/);
});

// NOT_FOUND 现在带回文件原文（多行）：TUI 是第二个消费者，续行不能顶格。
test("the multi-line not-found payload keeps every line under the rail", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const error = [
		"old_str was not found; L287 col 56: file \"、\" U+3001 ≠ old_str \",\" U+002C; copy from the file:",
		"287|gate 出导航卡、hard 出拒绝、",
		"288|guide 出引导卡、hint 出提醒。",
	].join("\n");
	const output = renderText(tool.renderResult(
		buildAgentResult([{ edit: { path: "docs/design.md", op: "replace" }, status: "failed", error }], { status: "rejected" }),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	const lines = output.split("\n");
	const pathIndex = lines.findIndex((line) => line.includes("docs/design.md"));
	const indent = (line) => line.length - line.trimStart().length;
	const headIndex = lines.findIndex((line) => line.includes("old_str was not found; L287 col 56"));
	const firstRegion = lines.findIndex((line) => line.includes("287|gate 出导航卡"));
	const secondRegion = lines.findIndex((line) => line.includes("288|guide 出引导卡"));

	assert.equal(headIndex, pathIndex + 1, output);
	assert.ok(firstRegion > headIndex && secondRegion === firstRegion + 1, output);
	for (const index of [headIndex + 1, firstRegion, secondRegion]) {
		assert.equal(indent(lines[index] ?? ""), indent(lines[headIndex] ?? ""), output);
	}
});

test("partial sequence counts applied and failed entries in the header", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedEntry("src/applied.ts", replacementDisplay(1, "before", "after")),
			{ edit: { path: "src/failed.ts", op: "replace" }, status: "failed", error: "ENOSPC: no space left on device" },
			{ edit: { path: "src/skipped.ts", op: "replace" }, status: "skipped" },
		], { status: "partial" }),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /partial · 1 applied · 1 failed/);
	assert.match(output, /src\/applied\.ts · \+1 -1/);
	assert.match(output, /ENOSPC/);
	assert.match(output, /src\/skipped\.ts · skipped/);
});

// pi 包装执行前失败(prepareArguments/schema/abort/blocked)时用的信封:
// createErrorToolResult() => { content:[真实消息], details:{} },且 execute 从未运行。
function harnessErrorResult(message) {
	return { content: [{ type: "text", text: message }], details: {} };
}

test("a pre-execution failure renders the harness message, not a renderer diagnostic", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		harnessErrorResult("edits[0].op must be one of replace | replaceAll | insert | delete"),
		{ expanded: false },
		createTheme(),
		createRenderContext({ isError: true }),
	));

	assert.match(output, /edits\[0\]\.op must be one of/);
	assert.doesNotMatch(output, /contract/i);
});

test("a payload this renderer cannot read degrades to the tool's own text", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: "legacy single-file payload" }],
			details: { status: "applied", path: "src/example.ts", cwd: process.cwd(), changeStats: { additions: 1, deletions: 1, changedLines: 2 }, display: contextDisplay([[1, "after"]]), truncated: false },
		},
		{ expanded: false },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /legacy single-file payload/);
	assert.doesNotMatch(output, /contract/i);
});

test("partial stream keeps pending instead of flashing a diagnostic", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		{ content: [], details: { status: "applied", cwd: process.cwd(), entries: [] } },
		{ expanded: false, isPartial: true },
		createTheme(),
		createRenderContext(),
	));

	assert.doesNotMatch(output, /edit_result_contract_invalid/);
});

test("completed tool execution replaces the pending plan with the final diff", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const args = makeArgs([
		{ path: "/tmp/pi-edit-ui-demo/example.ts", op: "replace", old_str: "before", new_str: "after" },
	]);
	const component = createToolExecutionComponent(tool, args);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult(
		buildAgentResult([
			appliedEntry("/tmp/pi-edit-ui-demo/example.ts", contextDisplay([
				[1, "export const value = 1;"],
				[2, 'export const name = "after";'],
			])),
		]),
		false,
	);

	const output = renderText(component);
	assert.equal(countOccurrences(output, "/tmp/pi-edit-ui-demo/example.ts"), 1);
	assertAppearsInOrder(output, ["edit", "/tmp/pi-edit-ui-demo/example.ts", 'export const name = "after";']);
});

// 端到端：参数残缺的调用走到 pi 的执行前失败信封。
test("a pre-execution failure shows the message in the live tool row", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const component = createToolExecutionComponent(tool, { edits: [] });
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult(
		{
			content: [{ type: "text", text: "edits must not be empty" }],
			details: {},
			isError: true,
		},
		false,
	);

	const output = renderText(component);
	assert.match(output, /edits must not be empty/);
	assert.doesNotMatch(output, /contract/i);
});

test("a failed entry puts its message directly under its own line", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult(
			[{ edit: { path: "src/a.ts", op: "replace" }, status: "failed", error: "old_str was not found." }],
			{ status: "rejected" },
		),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));
	const lines = output.split("\n");
	const pathIndex = lines.findIndex((line) => line.includes("src/a.ts"));
	assert.ok(pathIndex >= 0);
	assert.match(lines[pathIndex + 1] ?? "", /old_str was not found/);
});

test("renderResult makes edit path headers clickable file hyperlinks", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const cwd = "/tmp/pi-edit-link-demo";
	const raw = renderRawText(
		tool.renderResult(
			buildAgentResult([appliedEntry("src/example.ts", contextDisplay([[1, "after"]]))], { cwd }),
			{ expanded: true },
			createTheme(),
			createRenderContext({ cwd }),
		),
	);

	assert.ok(raw.includes(`\x1b]8;;${pathToFileURL(path.join(cwd, "src/example.ts")).href}\x1b\\`));
	assert.match(stripTerminalFormatting(raw), /src\/example\.ts/);
});