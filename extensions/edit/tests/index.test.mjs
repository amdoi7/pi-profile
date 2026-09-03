import { test } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import editExtension, { editRequestParameters } from "../index.ts";

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

function run(tool, args) {
	return tool.execute("call-1", args, undefined, undefined, { cwd: process.cwd() });
}

// rejected（零写入）进错误信封；partial 是信息完整的执行结果，不是 error。
// AgentToolResult 没有 isError 字段：信封由 tool_result handler 改写。
test("a rejected sequence flips the tool result envelope to isError", async () => {
	const { tool, handlers } = captureExtension();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		note: "why",
		edits: [{ path: file, op: "replace", old_str: "missing text", new_str: "replacement" }],
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
		edits: [
			{ path: good, op: "replace", old_str: "const x = 1;", new_str: "const x = 99;" },
			{ path: stale, op: "replace", old_str: "missing anchor", new_str: "z" },
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
		edits: [{ path: file, op: "replace", old_str: "const x = 1;", new_str: "const x = 2;" }],
	});

	assert.equal(onToolResult({ type: "tool_result", toolName: "edit", isError: false, details: applied.details }), undefined);
	assert.equal(onToolResult({ type: "tool_result", toolName: "bash", isError: false, details: { status: "rejected" } }), undefined);
});

test("an applied sequence is not an error and keeps its entries in the UI details", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		note: "why",
		edits: [{ path: file, op: "replaceAll", old_str: "const", new_str: "let" }],
	});

	assert.notEqual(result.isError, true);
	assert.equal(JSON.parse(result.content[0].text).status, "applied");
	assert.equal(result.details.entries[0].edit.path, file);
	assert.equal(result.details.entries[0].edit.op, "replaceAll");
});

// provider 侧契约：edits 必填非空，op 枚举受控，字段按 op 分管。
test("the provider schema requires a non-empty edits array with controlled ops", () => {
	assert.deepEqual(editRequestParameters.required, ["note", "edits"]);
	assert.equal(editRequestParameters.additionalProperties, false);
	assert.equal(editRequestParameters.properties.edits.minItems, 1);
});

test("a sequence missing its entries is rejected before touching the file", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	await assert.rejects(
		() => run(tool, { note: "why", edits: [] }),
		/edits must not be empty/,
	);
	assert.equal(await fs.readFile(file, "utf-8"), "const x = 1;\n");
});

;