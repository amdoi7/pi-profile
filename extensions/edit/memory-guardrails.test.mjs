import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	executeFileEdits,
	MAX_EDIT_FILE_SIZE_BYTES,
} from "./edit-engine.ts";
import { buildOutcomeAgentContent, executeSingleFileEdit } from "./pipeline.ts";
import { generateFinalDiff, serializeDisplayDiff } from "../_shared/final-diff.ts";

async function makeTempDir(prefix) {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeTempFile(prefix, name, content) {
	const dir = await makeTempDir(prefix);
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

test("large file exceeding MAX_EDIT_FILE_SIZE_BYTES is rejected without reading content", async () => {
	let readCalled = false;

	await assert.rejects(
		() =>
			executeFileEdits(
				"/fake/big.ts",
				[{ oldText: "x", newText: "y" }],
				undefined,
				{
					stat: async () => ({ size: MAX_EDIT_FILE_SIZE_BYTES + 1 }),
					access: async () => {},
					readFile: async () => {
						readCalled = true;
						return "x\n";
					},
					writeFile: async () => {},
				},
			),
		(err) => {
			assert.ok(err instanceof Error);
			assert.equal(
				err.message,
				`File too large: sizeBytes=${MAX_EDIT_FILE_SIZE_BYTES + 1} limitBytes=${MAX_EDIT_FILE_SIZE_BYTES}; use a narrower oldText or a streaming tool.`,
			);
			return true;
		},
	);

	assert.equal(readCalled, false, "readFile must not be called for oversized files");
});

// ─── 2. Single-file execution outcome contract ───────────────────────────────

test("successful execution outcome carries structured preview and changeStats", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\nconst y = 2;\n");

	const outcome = await executeSingleFileEdit(
		{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }] },
		process.cwd(),
	);

	assert.equal(outcome.status, "applied");
	if (outcome.status !== "applied") throw new Error("expected applied");

	assert.ok(Array.isArray(outcome.previewDisplay.rows), "previewDisplay must be present");
	assert.ok(typeof outcome.changeStats === "object", "changeStats must be present");

	assert.ok(!("diff" in outcome), "diff field must not exist on success outcome");
	assert.ok(!("canonicalPath" in outcome), "canonicalPath must not leak from execution");
	assert.ok(!("edits" in outcome), "edit input must not be echoed in the outcome");
	assert.ok(!("editCount" in outcome), "editCount must not be retained when the input already contains it");
});

test("failed execution outcome carries errorKind for recoverable edit errors", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\n");

	const outcome = await executeSingleFileEdit(
		{ path: file, edits: [{ oldText: "missing text", newText: "replacement" }] },
		process.cwd(),
	);

	assert.equal(outcome.status, "failed");
	if (outcome.status !== "failed") throw new Error("expected failed");
	assert.equal(outcome.errorKind, "NOT_FOUND");
	assert.match(outcome.error, /^oldText was not found\.$/);
	assert.deepEqual(JSON.parse(buildOutcomeAgentContent(outcome)), {
		status: "failed",
		path: file,
		error: {
			kind: "NOT_FOUND",
			message: "oldText was not found.",
		},
	});
});

test("shared final diff produces only the changed window, not the whole file", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
	const oldContent = lines.join("\n") + "\n";
	const newLines = [...lines];
	newLines[49] = "CHANGED";
	const newContent = newLines.join("\n") + "\n";

	const result = generateFinalDiff(oldContent, newContent, 4);
	const rendered = serializeDisplayDiff(result.display);

	assert.match(rendered, /CHANGED/);
	assert.doesNotMatch(rendered, /\bline1\b/);
	assert.doesNotMatch(rendered, /\bline100\b/);
	const previewLineCount = result.display.rows.length;
	assert.ok(previewLineCount < 20, `expected small preview, got ${previewLineCount} lines`);
});

test("shared final diff produces separate windows for edits far apart in the file", () => {
	const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
	const oldContent = lines.join("\n") + "\n";
	const newLines = [...lines];
	newLines[9] = "EDIT_TOP";
	newLines[189] = "EDIT_BOTTOM";
	const newContent = newLines.join("\n") + "\n";

	const result = generateFinalDiff(oldContent, newContent, 4);
	const rendered = serializeDisplayDiff(result.display);

	assert.match(rendered, /EDIT_TOP/);
	assert.match(rendered, /EDIT_BOTTOM/);
	assert.match(rendered, /\.\.\./);
	const previewLineCount = result.display.rows.length;
	assert.ok(previewLineCount < 30, `expected two small windows, got ${previewLineCount} lines`);
	assert.doesNotMatch(rendered, /\bline100\b/);
});
