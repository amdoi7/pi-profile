import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	executeFileGroupEdits,
	generateEditPreview,
	MAX_EDIT_FILE_SIZE_BYTES,
} from "./edit-engine.ts";
import { executeSingleFileEdit } from "./pipeline.ts";

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
			executeFileGroupEdits(
				"/fake/big.ts",
				"big.ts",
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
			assert.match(err.message, /File too large/);
			return true;
		},
	);

	assert.equal(readCalled, false, "readFile must not be called for oversized files");
});

// ─── 2. Single-file execution outcome contract ───────────────────────────────

test("successful execution outcome carries previewText and changeStats, not a diff string", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\nconst y = 2;\n");

	const group = await executeSingleFileEdit(
		{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }] },
		process.cwd(),
	);

	assert.equal(group.status, "applied");
	if (group.status !== "applied") throw new Error("expected applied");

	// New contract: previewText and changeStats present
	assert.ok(typeof group.previewText === "string", "previewText must be a string");
	assert.ok(typeof group.changeStats === "object", "changeStats must be present");

	assert.ok(!("diff" in group), "diff field must not exist on success outcome");
});

test("failed execution outcome carries errorKind for recoverable edit errors", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\n");

	const group = await executeSingleFileEdit(
		{ path: file, edits: [{ oldText: "missing text", newText: "replacement" }] },
		process.cwd(),
	);

	assert.equal(group.status, "failed");
	if (group.status !== "failed") throw new Error("expected failed");
	assert.equal(group.errorKind, "NOT_FOUND");
});

test("generateEditPreview produces only the changed window, not the whole file", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
	const oldContent = lines.join("\n") + "\n";
	const newLines = [...lines];
	newLines[49] = "CHANGED";
	const newContent = newLines.join("\n") + "\n";

	const result = generateEditPreview(oldContent, newContent, 4);

	assert.match(result.previewText, /CHANGED/);
	assert.doesNotMatch(result.previewText, /\bline1\b/);
	assert.doesNotMatch(result.previewText, /\bline100\b/);
	const previewLineCount = result.previewText.split("\n").length;
	assert.ok(previewLineCount < 20, `expected small preview, got ${previewLineCount} lines`);
});

test("generateEditPreview produces separate windows for edits far apart in the file", () => {
	const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
	const oldContent = lines.join("\n") + "\n";
	const newLines = [...lines];
	newLines[9] = "EDIT_TOP";
	newLines[189] = "EDIT_BOTTOM";
	const newContent = newLines.join("\n") + "\n";

	const result = generateEditPreview(oldContent, newContent, 4);

	assert.match(result.previewText, /EDIT_TOP/);
	assert.match(result.previewText, /EDIT_BOTTOM/);
	assert.match(result.previewText, /\.\.\./);
	const previewLineCount = result.previewText.split("\n").length;
	assert.ok(previewLineCount < 30, `expected two small windows, got ${previewLineCount} lines`);
	assert.doesNotMatch(result.previewText, /\bline100\b/);
});
