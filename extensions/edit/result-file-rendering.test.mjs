import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	copySharedFiles,
	extensionDir,
	linkPiPackages,
	packageFileUrl,
	resolvePiPackageDir,
} from "../test-helpers/runtime-paths.mjs";

const piPackageDir = resolvePiPackageDir("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent } = await import(packageFileUrl(piPackageDir, "dist/index.js"));
const { initTheme } = await import(packageFileUrl(piPackageDir, "dist/modes/interactive/theme/theme.js"));

const sourceDir = extensionDir("edit");
const TOOL_CALL_ID = "tool-call-1";

async function linkLocalDependency(targetRoot, packageName) {
	const targetDir = path.join(sourceDir, "node_modules", packageName);
	const linkPath = path.join(targetRoot, "node_modules", packageName);
	await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
	await fs.promises.rm(linkPath, { force: true, recursive: true });
	await fs.promises.symlink(targetDir, linkPath, "dir");
}

async function loadRegisteredEditTool() {
	const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-render-result-"));
	const tempExtensionDir = path.join(tempRoot, "extension");
	const tempEditDir = path.join(tempExtensionDir, "edit");
	const tempSharedDir = path.join(tempExtensionDir, "_shared");
	await fs.promises.cp(sourceDir, tempEditDir, {
		recursive: true,
		filter: (source) => path.basename(source) !== "node_modules",
	});
	await copySharedFiles(tempSharedDir, ["file-link.ts", "code-preview.ts", "final-diff.ts"]);
	await linkPiPackages(tempExtensionDir, { tui: true });
	await linkLocalDependency(tempEditDir, "arktype");

	const extensionModule = await import(`${pathToFileURL(path.join(tempEditDir, "index.ts")).href}?t=${Date.now()}`);
	let registeredTool;
	extensionModule.default({
		registerTool(definition) {
			registeredTool = definition;
		},
	});
	if (!registeredTool) {
		throw new Error("Failed to capture registered edit tool.");
	}
	return registeredTool;
}

function makeEditArgs(pathName, edits) {
	return { path: pathName, edits };
}

function createTheme() {
	return {
		fg: (_name, text) => text,
		bg: (_name, text) => text,
		bold: (text) => text,
		inverse: (text) => `<inv>${text}</inv>`,
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

function buildSingleFileSuccessGroup() {
	return {
		path: "/tmp/pi-edit-ui-demo/example.ts",
		status: "applied",
		firstChangedLine: 1,
		previewText: " 1 export const value = 1;\n 2 export const name = \"after\";",
	};
}

function buildAgentResult(fileResult) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify({
				status: fileResult.status,
				path: fileResult.path,
			}),
		}],
		details: {
			kind: "result",
			file: fileResult.status === "applied"
				? {
					path: fileResult.path,
					status: "applied",
					previewText: fileResult.previewText ?? "",
					previewStartLine: fileResult.firstChangedLine,
					previewTruncated: false,
					changeStats: fileResult.changeStats ?? { additions: 1, deletions: 1, changedLines: 2 },
					summary: `Edited ${fileResult.path}.`,
				}
				: {
					path: fileResult.path,
					status: "failed",
					error: fileResult.error.message,
				},
		},
	};
}

test("pending edit render shows only compact file headers", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(
		tool.renderCall(
			makeEditArgs("src/example.ts", [{ oldText: "before", newText: "after" }]),
			createTheme(),
			createRenderContext({ executionStarted: false, argsComplete: true, isPartial: false }),
		),
	);

	assert.match(output, /edit file src\/example\.ts/);
	assert.doesNotMatch(output, /before|after/);
});

test("production result renderer uses Pi native diff rendering", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const result = buildAgentResult({
		path: "src/example.ts",
		status: "applied",
		firstChangedLine: 10,
		previewText: "-10 \tindented\n+10   indented",
	});

	const output = renderText(tool.renderResult(
		result,
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.match(output, /-10 {3}indented/);
	assert.match(output, /\+10 {3}indented/);
});

test("result file header and diff have exactly one blank line between them", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult({
			path: "src/example.ts",
			status: "applied",
			firstChangedLine: 1,
			previewText: "-1 before\n+1 after",
		}),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));
	const lines = output.split("\n");
	const headerIndex = lines.findIndex((line) => line.includes("src/example.ts"));
	const diffIndex = lines.findIndex((line) => line.trimStart().startsWith("-1 "));

	assert.equal(diffIndex - headerIndex, 2, output);
	assert.equal(lines[headerIndex + 1], "");
});

test("failed result shows the path only in its header", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(tool.renderResult(
		buildAgentResult({
			path: "src/example.ts",
			status: "failed",
			error: {
				message: "oldText was not found. Re-read the file and copy oldText exactly, including whitespace.",
			},
		}),
		{ expanded: true },
		createTheme(),
		createRenderContext(),
	));

	assert.equal(countOccurrences(output, "src/example.ts"), 1, output);
	assert.match(output, /oldText was not found/);
});

test("raw result fallback replaces a prior structured Container without throwing", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const context = createRenderContext();
	const structured = tool.renderResult(
		buildAgentResult({
			path: "src/example.ts",
			status: "applied",
			firstChangedLine: 1,
			previewText: "-1 before\n+1 after",
		}),
		{ expanded: true },
		createTheme(),
		context,
	);

	assert.doesNotThrow(() => tool.renderResult(
		{ content: [{ type: "text", text: "raw fallback" }], details: undefined },
		{ expanded: true },
		createTheme(),
		{ ...context, lastComponent: structured },
	));
});

test("renderResult keeps the single-file path header visible before its diff", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const output = renderText(
		tool.renderResult(
			buildAgentResult({
					path: "src/example.ts",
					status: "applied",
					firstChangedLine: 1,
					previewText: " 1 after",
				},
			),
			{ expanded: true },
			createTheme(),
			createRenderContext(),
		),
	);

	assertAppearsInOrder(output, ["src/example.ts", " 1 after"]);
});


test("single-file execution replaces pending header with final diff", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const args = makeEditArgs("/tmp/pi-edit-ui-demo/example.ts", [{ oldText: "before", newText: "after" }]);
	const component = createToolExecutionComponent(tool, args);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({
		...buildAgentResult(buildSingleFileSuccessGroup()),
		isError: false,
	}, false);

	const output = renderText(component);
	assertAppearsInOrder(output, ["/tmp/pi-edit-ui-demo/example.ts", "export const name = \"after\";"]);
});

test("completed single-file tool execution renders one standalone per-file block", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const args = makeEditArgs("/tmp/pi-edit-ui-demo/example.ts", [{ oldText: "before", newText: "after" }]);
	const component = createToolExecutionComponent(tool, args);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({
		...buildAgentResult(buildSingleFileSuccessGroup()),
		isError: false,
	}, false);

	const output = renderText(component);

	assert.equal(countOccurrences(output, "/tmp/pi-edit-ui-demo/example.ts"), 1);
	assert.doesNotMatch(output, /Applied 1 file\./);
	assertAppearsInOrder(output, ["/tmp/pi-edit-ui-demo/example.ts", "export const name = \"after\";"]);
});


test("renderResult makes edit path headers clickable file hyperlinks", async () => {
	initTheme("dark");
	const tool = await loadRegisteredEditTool();
	const cwd = "/tmp/pi-edit-link-demo";
	const raw = renderRawText(
		tool.renderResult(
			buildAgentResult({
				path: "src/example.ts",
				status: "applied",
				firstChangedLine: 1,
				previewText: " 1 after",
			}),
			{ expanded: true },
			createTheme(),
			createRenderContext({ cwd }),
		),
	);

	assert.ok(raw.includes(`\x1b]8;;${pathToFileURL(path.join(cwd, "src/example.ts")).href}\x1b\\`));
	assert.match(stripTerminalFormatting(raw), /src\/example\.ts/);
});
