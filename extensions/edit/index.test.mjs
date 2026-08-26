import { test } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import editExtension from "./index.ts";
import { editRequestParameters } from "./pipeline.ts";

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

// 软失败（rejected/partial）必须进错误信封。但 AgentToolResult 没有 isError 字段：
// executePreparedToolCall 正常返回一律 isError:false（pi-agent-core dist/agent-loop.js），
// execute 里写 isError 会被丢弃；能改信封的只有 tool_result handler。
// 语料证据：2026-08-25/26 共 23 例 rejected + 18 例 failed 落盘时 isError 都是 false。

test("a rejected batch flips the tool result envelope to isError", async () => {
	const { tool, handlers } = captureExtension();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		intent: "retarget the constant",
		files: [{ path: file, edits: [{ oldText: "missing text", newText: "replacement" }] }],
	});

	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "rejected");
	assert.deepEqual(payload.written, []);
	assert.equal(payload.failed[0].kind, "NOT_FOUND");

	const onToolResult = handlers.get("tool_result");
	assert.ok(onToolResult, "extension must register a tool_result handler");
	assert.deepEqual(
		onToolResult({ type: "tool_result", toolName: "edit", isError: false, details: result.details }),
		{ isError: true },
	);
});

test("an applied batch and other tools leave the envelope untouched", async () => {
	const { tool, handlers } = captureExtension();
	const onToolResult = handlers.get("tool_result");
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const applied = await run(tool, {
		intent: "bump the constant",
		files: [{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] }],
	});

	assert.equal(onToolResult({ type: "tool_result", toolName: "edit", isError: false, details: applied.details }), undefined);
	assert.equal(onToolResult({ type: "tool_result", toolName: "bash", isError: false, details: { status: "rejected" } }), undefined);
});

test("applied batch is not an error and keeps the intent in the UI details", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		intent: "bump the constant",
		files: [{ path: file, hint: "only definition", edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] }],
	});

	assert.notEqual(result.isError, true);
	assert.equal(JSON.parse(result.content[0].text).status, "applied");
	assert.equal(result.details.intent, "bump the constant");
	assert.equal(result.details.files[0].hint, "only definition");
});

// provider 侧契约:intent 与 files 必填、每层禁未知键、数组非空——
// 声明漏一项就会让模型合法地发出无意图/空批次。
test("the provider schema requires an intent and a non-empty files array", () => {
	assert.deepEqual(editRequestParameters.required, ["intent", "files"]);
	assert.equal(editRequestParameters.additionalProperties, false);

	const fileSchema = editRequestParameters.properties.files;
	assert.equal(fileSchema.minItems, 1);
	assert.deepEqual(fileSchema.items.required, ["path", "edits"]);
	assert.equal(fileSchema.items.additionalProperties, false);
	assert.equal(fileSchema.items.properties.edits.minItems, 1);
	assert.deepEqual(fileSchema.items.properties.edits.items.required, ["oldText", "newText"]);
});

test("a batch missing its intent is rejected before touching the file", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	await assert.rejects(
		() => run(tool, { files: [{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] }] }),
		/intent must be a string/,
	);
	assert.equal(await fs.readFile(file, "utf-8"), "const x = 1;\n");
});
