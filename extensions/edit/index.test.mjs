import { test } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import editExtension from "./index.ts";

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

// Soft failure (status:failed payload) must surface as isError so the harness
// error channel and downstream isError routing see it; a silent success-shaped
// result trains blind retries. Evidence: 24 例 applied:0 但 isError:false
// (fail-mining 2026-08-13).

test("failed edit outcome is returned with isError true", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await tool.execute(
		"call-1",
		{ path: file, edits: [{ oldText: "missing text", newText: "replacement" }] },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	assert.equal(result.isError, true, "soft failure must be marked isError");
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "failed");
	assert.equal(payload.error.kind, "NOT_FOUND");
});

test("applied edit outcome is not an error", async () => {
	const tool = captureTool();
	const file = await writeTempFile("target.ts", "const x = 1;\n");

	const result = await tool.execute(
		"call-1",
		{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	assert.notEqual(result.isError, true);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.status, "applied");
});
