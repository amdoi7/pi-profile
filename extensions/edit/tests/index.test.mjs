import { test } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Compile } from "typebox/compile";

import editExtension, { editRequestParameters } from "../index.ts";

const validateRequest = Compile(editRequestParameters);

function captureExtension() {
	let registeredTool;
	const handlers = new Map();
	editExtension({
		registerTool(definition) {
			registeredTool = definition;
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	if (!registeredTool) throw new Error("edit tool was not registered");
	return { tool: registeredTool, handlers };
}

function captureTool() {
	return captureExtension().tool;
}

async function writeTempFile(name, content) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-iserror-"));
	const file = path.join(dir, name);
	await fs.writeFile(file, content);
	return file;
}

async function run(tool, args) {
	const prepared = tool.prepareArguments(args);
	const errors = [...validateRequest.Errors(prepared)];
	if (errors.length > 0) throw new Error(errors.map((error) => error.message).join("; "));
	return tool.execute("call-1", prepared, undefined, undefined, { cwd: process.cwd() });
}

// rejected（零写入）进错误信封；partial 是信息完整的执行结果，不是 error。
// AgentToolResult 没有 isError 字段：信封由 tool_result handler 改写。
test("a rejected sequence flips the tool result envelope to isError", async () => {
	const { tool, handlers } = captureExtension();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		note: "why",
		path: file,
		edits: [{ match: "missing text", new_str: "replacement" }],
	});

	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "rejected");
	const [entry] = payload.entries;
	assert.equal(entry.kind, "NOT_FOUND");

	const onToolResult = handlers.get("tool_result");
	assert.ok(onToolResult, "extension must register a tool_result handler");
	assert.deepEqual(
		onToolResult({ type: "tool_result", toolName: "edit", isError: false, details: result.details }),
		{ isError: true },
	);
});

test("a partial sequence (some applied, some failed) is not an error", async () => {
	const { tool, handlers } = captureExtension();
	const onToolResult = handlers.get("tool_result");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-partial-"));
	const good = path.join(dir, "good.ts");
	const stale = path.join(dir, "stale.ts");
	await fs.writeFile(good, "const x = 1;\n");
	await fs.writeFile(stale, "const y = 2;\n");

	const result = await run(tool, {
		note: "why",
		path: good,
		edits: [
			{ match: "const x = 1;", new_str: "const x = 99;" },
			{ match: "missing anchor", new_str: "z" },
		],
	});

	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "partial");
	assert.equal(payload.entries[0].changes.changedLines, 2);
	assert.equal(payload.entries[1].kind, "NOT_FOUND");
	assert.equal(await fs.readFile(good, "utf-8"), "const x = 99;\n", "applied entry stays applied");
	assert.equal(onToolResult({ type: "tool_result", toolName: "edit", isError: false, details: result.details }), undefined);
});

test("an applied sequence and other tools leave the envelope untouched", async () => {
	const { tool, handlers } = captureExtension();
	const onToolResult = handlers.get("tool_result");
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const applied = await run(tool, {
		note: "why",
		path: file,
		edits: [{ match: "const x = 1;", new_str: "const x = 2;" }],
	});

	assert.equal(onToolResult({ type: "tool_result", toolName: "edit", isError: false, details: applied.details }), undefined);
	assert.equal(onToolResult({ type: "tool_result", toolName: "bash", isError: false, details: { status: "rejected" } }), undefined);
});

test("an applied sequence is not an error and keeps its entries in the UI details", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		note: "why",
		path: file,
		edits: [{ match: "const", new_str: "let" }],
	});

	assert.notEqual(result.isError, true);
	assert.equal(JSON.parse(result.content[0].text).status, "applied");
	assert.equal(result.details.path, file);
	assert.equal(result.details.entries[0].entry.match, "const");
});

test("a non-unique match is rejected as DUPLICATE_MATCH without writing", async () => {
	const tool = captureTool();
	const original = "import first\nimport unused_one\nimport last\n";
	const file = await writeTempFile("imports.py", original);

	const result = await run(tool, {
		note: "remove an unused import",
		path: file,
		edits: [{ match: "import", new_str: "from" }],
	});

	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "rejected");
	assert.equal(payload.entries[0].kind, "DUPLICATE_MATCH");
	assert.match(payload.entries[0].message, /matched 3 locations/);
	assert.equal(await fs.readFile(file, "utf-8"), original);
});

test("a longer unique match disambiguates repeated text", async () => {
	const tool = captureTool();
	const file = await writeTempFile(
		"imports.py",
		"import first\nimport unused_one\nimport last\n",
	);

	const result = await run(tool, {
		note: "remove an unused import",
		path: file,
		edits: [{ match: "import unused_one", new_str: "from unused_one" }],
	});

	assert.equal(JSON.parse(result.content[0].text).status, "applied");
	assert.equal(
		await fs.readFile(file, "utf-8"),
		"import first\nfrom unused_one\nimport last\n",
	);
});

test.each([
	["legacy occurrence", { match: "import", occurrence: 1 }, /occurrence must be removed/],
	["legacy limit", { match: "import", limit: 1 }, /limit must be removed/],
	["retired range", { match: "import", range: { start: 1, count: 1 } }, /range must be removed/],
	["retired regex", { match: "import", regex: true }, /regex must be removed/],
	["retired after", { match: "import", after: "x" }, /after must be removed/],
	["retired before", { match: "import", before: "x" }, /before must be removed/],
])("invalid match selection is rejected before IO: %s", async (_scenario, edit, expectedError) => {
	const tool = captureTool();
	const original = "import first\nimport last\n";
	const file = await writeTempFile("imports.py", original);

	await assert.rejects(
		() => run(tool, { note: "remove an unused import", path: file, edits: [edit] }),
		expectedError,
	);
	assert.equal(await fs.readFile(file, "utf-8"), original);
});

// provider 侧契约：note/path/edits 必填，条目 match 必填且不带 path，字段受控。
test("the provider schema requires note, path and a non-empty edits array with controlled entries", () => {
	assert.deepEqual(editRequestParameters.required, ["note", "path", "edits"]);
	assert.equal(editRequestParameters.additionalProperties, false);
	const entry = editRequestParameters.properties.edits.items;
	assert.deepEqual(entry.required, ["match"]);
	assert.ok(!("path" in entry.properties), "path belongs at the top level");
	assert.ok(!("occurrence" in entry.properties));
	assert.ok(!("limit" in entry.properties));
	assert.ok(!("range" in entry.properties), "selectors are retired");
	assert.ok(!("regex" in entry.properties), "selectors are retired");
	assert.ok(!("after" in entry.properties), "selectors are retired");
	assert.ok(!("before" in entry.properties), "selectors are retired");
	assert.equal(entry.additionalProperties, false);
	assert.equal(editRequestParameters.properties.edits.minItems, 1);
});

test("a sequence missing its entries is rejected before touching the file", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	await assert.rejects(
		() => run(tool, { note: "why", path: file, edits: [] }),
		/edits must not be empty/,
	);
	assert.equal(await fs.readFile(file, "utf-8"), "const x = 1;\n");
});
