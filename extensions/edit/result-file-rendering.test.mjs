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
} from "../test-helpers/runtime-paths.mjs";

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
		filter: (source) => path.basename(source) !== "node_modules",
	});
	await copySharedFiles(tempSharedDir, ["file-link.ts", "code-preview.ts", "final-diff.ts", "diff-view.ts", "file-mutation-view.ts", "file-result.ts", "diff-service.ts", "diff-worker.ts"]);
	await linkPiPackages(tempExtensionDir, { tui: true });
	await linkSharedPackages(tempExtensionDir);

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

const INTENT = "narrow the ctx type";

function makeBatchArgs(files, intent = INTENT) {
	return { intent, files };
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

function appliedFile(filePath, display, overrides = {}) {
	return {
		path: filePath,
		status: "applied",
		changeStats: { additions: 1, deletions: 1, changedLines: 2 },
		display,
		truncated: false,
		firstChangedLine: 1,
		...overrides,
	};
}

/** execute 的真实结果形状：compact JSON content + 批次 details。 */
function buildAgentResult(files, { status = "applied", cwd = process.cwd(), intent = INTENT } = {}) {
	return {
		content: [{ type: "text", text: JSON.stringify({ status }) }],
		isError: status !== "applied",
		details: { status, intent, cwd, files },
	};
}

test("pending render shows the intent and the planned files without any diff text", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(
		tool.renderCall(
			makeBatchArgs([
				{ path: "src/example.ts", hint: "call site", edits: [{ oldText: "before", newText: "after" }] },
				{ path: "src/other.ts", edits: [{ oldText: "left", newText: "right" }] },
			]),
			createTheme(),
			createRenderContext({ executionStarted: false, argsComplete: true, isPartial: false }),
		),
	);

	assertAppearsInOrder(output, [INTENT, "src/example.ts", "src/other.ts"]);
	assert.match(output, /call site/);
	assert.doesNotMatch(output, /before|after/);
});

test("applied result attributes the tool once in the intent header", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedFile("src/example.ts", replacementDisplay(1, "before", "after"), {
				changeStats: { additions: 2, deletions: 1, changedLines: 3 },
			}),
			appliedFile("src/other.ts", replacementDisplay(1, "left", "right")),
		]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.equal(countOccurrences(output, "edit"), 1, output);
	assertAppearsInOrder(output, [`edit ${INTENT}`, "src/example.ts · +2 -1", "src/other.ts · +1 -1"]);
});

test("per-file hint rides on the file line", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedFile("src/example.ts", replacementDisplay(1, "before", "after"), { hint: "compile site" }),
		]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /src\/example\.ts · \+1 -1 · compile site/);
});

test("production result renderer uses Pi native diff rendering", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedFile("src/example.ts", replacementDisplay(10, "\tindented", "  indented"), { firstChangedLine: 10 }),
		]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /-10 {4}│ {4}indented/);
	assert.match(output, /\+ {3}10 │ {3}indented/);
});

test("each file header sits directly above its own diff", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([appliedFile("src/example.ts", replacementDisplay(1, "before", "after"))]),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));
	const lines = output.split("\n");
	const headerIndex = lines.findIndex((line) => line.includes("src/example.ts"));
	const diffIndex = lines.findIndex((line) => line.trimStart().startsWith("-1 "));

	assert.equal(diffIndex - headerIndex, 1, output);
});

test("rejected batch says nothing was written and marks the untouched files", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			{ path: "src/resolvable.ts", status: "notWritten", restored: false },
			{ path: "src/stale.ts", status: "failed", error: "oldText was not found." },
		], { status: "rejected" }),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /rejected · nothing written/);
	assert.match(output, /src\/resolvable\.ts · not written/);
	assert.equal(countOccurrences(output, "src/stale.ts"), 1, output);
	assert.match(output, /oldText was not found/);
});

test("a rolled-back file says it was restored, not merely skipped", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			{ path: "src/first.ts", status: "notWritten", restored: true, hint: "leading change" },
			{ path: "src/second.ts", status: "failed", error: "EACCES: permission denied" },
		], { status: "rejected" }),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /src\/first\.ts · leading change · restored/);
});

test("partial batch warns that files were left changed", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult([
			appliedFile("src/stranded.ts", replacementDisplay(1, "before", "after")),
			{ path: "src/failed.ts", status: "failed", error: "ENOSPC: no space left on device" },
		], { status: "partial" }),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /partial · some files left changed/);
	assert.match(output, /src\/stranded\.ts · \+1 -1/);
	assert.match(output, /ENOSPC/);
});

test("legacy single-file details shows the contract diagnostic (no format compat)", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: "legacy single-file payload" }],
			details: { status: "applied", path: "src/example.ts", cwd: process.cwd(), changeStats: { additions: 1, deletions: 1, changedLines: 2 }, display: contextDisplay([[1, "after"]]), truncated: false },
			isError: false,
		},
		{ expanded: false },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /edit_result_contract_invalid/);
	assert.doesNotMatch(output, /legacy single-file payload/);
});

test("validation error without details renders the real failure message", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		{
			content: [{ type: "text", text: "files[0].oldText must be a string" }],
			details: undefined,
			isError: true,
		},
		{ expanded: false },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /oldText must be a string/);
	assert.doesNotMatch(output, /edit_result_contract_invalid/);
});

test("partial stream keeps pending instead of flashing a diagnostic", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		{ content: [], details: { status: "applied", intent: INTENT, cwd: process.cwd(), files: [] } },
		{ expanded: false, isPartial: true },
		createTheme(),
		createRenderContext(),
	));

	assert.doesNotMatch(output, /edit_result_contract_invalid/);
});

test("completed tool execution replaces the pending plan with the final diff", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const args = makeBatchArgs([
		{ path: "/tmp/pi-edit-ui-demo/example.ts", edits: [{ oldText: "before", newText: "after" }] },
	]);
	const component = createToolExecutionComponent(tool, args);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult(
		buildAgentResult([
			appliedFile("/tmp/pi-edit-ui-demo/example.ts", contextDisplay([
				[1, "export const value = 1;"],
				[2, 'export const name = "after";'],
			])),
		]),
		false,
	);

	const output = renderText(component);
	assert.equal(countOccurrences(output, "/tmp/pi-edit-ui-demo/example.ts"), 1);
	assertAppearsInOrder(output, [INTENT, "/tmp/pi-edit-ui-demo/example.ts", 'export const name = "after";']);
});

test("renderResult makes edit path headers clickable file hyperlinks", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const cwd = "/tmp/pi-edit-link-demo";
	const raw = renderRawText(
		tool.renderResult(
			buildAgentResult([appliedFile("src/example.ts", contextDisplay([[1, "after"]]))], { cwd }),
			{ expanded: true },
			createTheme(),
			createRenderContext({ cwd }),
		),
	);

	assert.ok(raw.includes(`\x1b]8;;${pathToFileURL(path.join(cwd, "src/example.ts")).href}\x1b\\`));
	assert.match(stripTerminalFormatting(raw), /src\/example\.ts/);
});
