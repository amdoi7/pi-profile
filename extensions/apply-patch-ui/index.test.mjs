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

const sourceDir = extensionDir("apply-patch-ui");
const piPackageDir = resolvePiPackageDir("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent } = await import(packageFileUrl(piPackageDir, "dist/index.js"));
const { initTheme } = await import(packageFileUrl(piPackageDir, "dist/modes/interactive/theme/theme.js"));
initTheme("dark");

async function loadRegisteredTool() {
	const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-ui-"));
	const tempExtensionDir = path.join(tempRoot, "extension");
	const tempToolDir = path.join(tempExtensionDir, "apply-patch-ui");
	await fs.promises.cp(sourceDir, tempToolDir, { recursive: true });
	await copySharedFiles(path.join(tempExtensionDir, "_shared"), [
		"code-preview.ts",
		"file-link.ts",
		"final-diff.ts",
	]);
	await linkPiPackages(tempExtensionDir, { tui: true });

	const moduleUrl = `${pathToFileURL(path.join(tempToolDir, "index.ts")).href}?t=${Date.now()}`;
	const extensionModule = await import(moduleUrl);
	let registeredTool;
	extensionModule.default({
		registerTool(definition) {
			registeredTool = definition;
		},
		on() {},
	});
	assert.ok(registeredTool, "apply-patch-ui did not register a bash override");
	return registeredTool;
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
		cwd: "/tmp/pi-apply-patch-ui-workspace",
		executionStarted: false,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function createExecutionContext(cwd) {
	return {
		cwd,
		mode: "tui",
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "apply-patch-ui-test",
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
	const tool = await loadRegisteredTool();
	const output = renderText(
		tool.renderCall(
			{ command: MULTI_OPERATION_COMMAND },
			createTheme(),
			createContext(MULTI_OPERATION_COMMAND),
		),
	);

	assertAppearsInOrder(output, [
		"apply_patch add src/new.ts",
		"apply_patch update src/old.ts",
		"apply_patch move src/from.ts -> src/to.ts",
		"apply_patch delete src/dead.ts",
	]);
	assert.doesNotMatch(output, /\*\*\* Begin Patch/);
});

test("single-quoted apply_patch invocation uses the compact pending renderer", async () => {
	const command = "apply_patch '*** Begin Patch\n*** Add File: note.txt\n+it'\\''s ready\n*** End Patch'";
	const tool = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.match(output, /apply_patch add note\.txt/);
	assert.doesNotMatch(output, /^\$ apply_patch /);
});

test("completed TUI row replaces the raw patch call with the confirmed result UI", async () => {
	const tool = await loadRegisteredTool();
	const row = new ToolExecutionComponent(
		"bash",
		"completed-row",
		{ command: MULTI_OPERATION_COMMAND },
		{ showImages: false },
		tool,
		{ requestRender() {} },
		"/tmp/pi-apply-patch-ui-workspace",
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
		"apply_patch applied 4 operations",
		"added src/new.ts",
		"modified src/old.ts",
		"modified src/to.ts",
		"deleted src/dead.ts",
	]);
	assert.doesNotMatch(output, /\$ apply_patch|\*\*\* Begin Patch/);
});

test("successful result renders confirmed affected paths", async () => {
	const tool = await loadRegisteredTool();
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
		"apply_patch applied 4 operations",
		"added src/new.ts",
		"modified src/old.ts",
		"modified src/to.ts",
		"deleted src/dead.ts",
	]);
});

test("successful result followed by unrelated command output is still rendered", async () => {
	const tool = await loadRegisteredTool();
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
		"apply_patch applied 4 operations",
		"added src/new.ts",
		"modified src/old.ts",
		"modified src/to.ts",
		"deleted src/dead.ts",
	]);
	assert.doesNotMatch(output, /FAILED/);
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
	const tool = await loadRegisteredTool();
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
		"apply_patch applied 2 operations",
		"added created.txt",
		"modified existing.txt",
	]);
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
	const tool = await loadRegisteredTool();
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
		"applied before failure 1",
		"added first.txt",
	]);
});

test("compound shell commands with cd prefix are recognized as apply_patch", async () => {
	const command = `cd nested && ${MULTI_OPERATION_COMMAND}`;
	const tool = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assertAppearsInOrder(output, [
		"apply_patch add src/new.ts",
		"apply_patch update src/old.ts",
		"apply_patch move src/from.ts -> src/to.ts",
		"apply_patch delete src/dead.ts",
	]);
	assert.doesNotMatch(output, /^\$ cd nested && apply_patch/);
});

test("apply_patch heredoc followed by additional shell commands is recognized", async () => {
	const command = `${MULTI_OPERATION_COMMAND}\nuv run pytest -q`;
	const tool = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assertAppearsInOrder(output, [
		"apply_patch add src/new.ts",
		"apply_patch update src/old.ts",
		"apply_patch move src/from.ts -> src/to.ts",
		"apply_patch delete src/dead.ts",
	]);
	assert.doesNotMatch(output, /uv run pytest/);
});

test("multiple apply_patch heredocs after cd prefix and trailing test command are recognized", async () => {
	const command = `cd nested && ${MULTI_OPERATION_COMMAND}\n${MULTI_OPERATION_COMMAND}\nuv run pytest -q`;
	const tool = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.equal(output.match(/apply_patch add/g)?.length, 2);
	assert.equal(output.match(/apply_patch update/g)?.length, 2);
	assert.doesNotMatch(output, /uv run pytest/);
});

test("ephemeral execution preserves the bash result and renders confirmed final line-number diff", async (t) => {
	const workspace = await fs.promises.mkdtemp(path.join(process.cwd(), ".apply-patch-ui-test-"));
	t.after(() => fs.promises.rm(workspace, { recursive: true, force: true }));
	const file = path.join(workspace, "target.ts");
	await fs.promises.writeFile(file, "const left = oldLeft + oldRight;\nnext();\n", "utf8");
	const relativePath = path.relative(process.cwd(), file);
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: ${relativePath}
@@
-const left = oldLeft + oldRight;
+const left = newLeft + newRight;
*** End Patch
PATCH`;
	const toolCallId = "ephemeral-final-diff";
	const tool = await loadRegisteredTool();

	const result = await tool.execute(
		toolCallId,
		{ command },
		undefined,
		undefined,
		createExecutionContext(process.cwd()),
	);

	assert.deepEqual(result, {
		content: [{
			type: "text",
			text: `Success. Updated the following files:\nM ${relativePath}\n`,
		}],
		details: undefined,
	});
	assert.equal(
		await fs.promises.readFile(file, "utf8"),
		"const left = newLeft + newRight;\nnext();\n",
	);

	const renderContext = createContext(command, { toolCallId, executionStarted: true });
	const output = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		renderContext,
	));
	assert.match(output, /-1 const left = oldLeft \+ oldRight;/);
	assert.match(output, /\+1 const left = newLeft \+ newRight;/);
	assert.match(output, / 2 next\(\);/);

	const rerendered = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		renderContext,
	));
	assert.match(rerendered, /-1 const left = oldLeft \+ oldRight;/);

	const historical = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));
	assert.match(historical, /modified .*target\.ts/);
	assert.doesNotMatch(historical, /oldLeft|newLeft/);
});

test("ephemeral final diff maps add, move, and delete operations to their before and after paths", async (t) => {
	const workspace = await fs.promises.mkdtemp(path.join(process.cwd(), ".apply-patch-ui-test-"));
	t.after(() => fs.promises.rm(workspace, { recursive: true, force: true }));
	const relativeDir = path.relative(process.cwd(), workspace);
	await fs.promises.writeFile(path.join(workspace, "move-from.txt"), "before\n", "utf8");
	await fs.promises.writeFile(path.join(workspace, "delete.txt"), "dead\n", "utf8");
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: ${relativeDir}/added.txt
+created
*** Update File: ${relativeDir}/move-from.txt
*** Move to: ${relativeDir}/move-to.txt
@@
-before
+after
*** Delete File: ${relativeDir}/delete.txt
*** End Patch
PATCH`;
	const toolCallId = "ephemeral-all-operation-kinds";
	const tool = await loadRegisteredTool();
	const result = await tool.execute(
		toolCallId,
		{ command },
		undefined,
		undefined,
		createExecutionContext(process.cwd()),
	);

	const output = renderText(tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true }),
	));
	assertAppearsInOrder(output, [
		`apply_patch add ${relativeDir}/added.txt`,
		"+1 created",
		`apply_patch move ${relativeDir}/move-from.txt -> ${relativeDir}/move-to.txt`,
		"-1 before",
		"+1 after",
		`apply_patch delete ${relativeDir}/delete.txt`,
		"-1 dead",
	]);
});

test("ephemeral partial failure renders only confirmed applied-prefix diffs", async (t) => {
	const workspace = await fs.promises.mkdtemp(path.join(process.cwd(), ".apply-patch-ui-test-"));
	t.after(() => fs.promises.rm(workspace, { recursive: true, force: true }));
	const relativeDir = path.relative(process.cwd(), workspace);
	const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: ${relativeDir}/first.txt
+first
*** Update File: ${relativeDir}/missing.txt
@@
-before
+after
*** End Patch
PATCH`;
	const toolCallId = "ephemeral-partial-failure";
	const tool = await loadRegisteredTool();
	let executionError;
	try {
		await tool.execute(
			toolCallId,
			{ command },
			undefined,
			undefined,
			createExecutionContext(process.cwd()),
		);
	} catch (error) {
		executionError = error;
	}
	assert.ok(executionError instanceof Error);
	assert.match(executionError.message, /"code":"FILE_NOT_FOUND"/);
	assert.match(executionError.message, /Command exited with code 1/);

	const output = renderText(tool.renderResult(
		{ content: [{ type: "text", text: executionError.message }], details: undefined },
		{ expanded: false, isPartial: false },
		createTheme(),
		createContext(command, { toolCallId, executionStarted: true, isError: true }),
	));
	assert.match(output, /failed FILE_NOT_FOUND/);
	assert.match(output, /applied before failure 1/);
	assert.match(output, new RegExp(`apply_patch add ${relativeDir}/first\\.txt`));
	assert.match(output, /\+1 first/);
	assert.doesNotMatch(output, /\+1 after/);
});

test("ordinary shell commands retain the built-in bash renderer", async () => {
	const command = "printf 'ok'";
	const tool = await loadRegisteredTool();
	const output = renderText(tool.renderCall({ command }, createTheme(), createContext(command)));

	assert.match(output, /^\$ printf/);
	assert.doesNotMatch(output, /apply_patch applied/);
});
