import { test } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import editExtension from "./index.ts";
import { editRequestParameters } from "./pipeline.ts";

function captureTool() {
	let registeredTool;
	editExtension({
		registerTool(definition) {
			registeredTool = definition;
		},
		on() {},
	});
	if (!registeredTool) throw new Error("edit tool was not registered");
	return registeredTool;
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

// Soft failure (a rejected/partial batch) must surface as isError so the harness
// error channel and downstream isError routing see it; a silent success-shaped
// result trains blind retries. Evidence: 24 例 applied:0 但 isError:false
// (fail-mining 2026-08-13).

test("rejected batch is returned with isError true", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await run(tool, {
		intent: "retarget the constant",
		files: [{ path: file, edits: [{ oldText: "missing text", newText: "replacement" }] }],
	});

	assert.equal(result.isError, true, "soft failure must be marked isError");
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "rejected");
	assert.deepEqual(payload.written, []);
	assert.equal(payload.failed[0].kind, "NOT_FOUND");
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
