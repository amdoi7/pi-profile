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
import { executeExecutionPlan } from "./batch-execution.ts";

async function makeTempDir(prefix) {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeTempFile(prefix, name, content) {
	const dir = await makeTempDir(prefix);
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

function makePlanGroup(pathName, canonicalPath, oldText = "x", newText = "y") {
	return {
		path: pathName,
		canonicalPath,
		edits: [{ oldText, newText }],
	};
}

function makePlan(groups, maxConcurrency = groups.length) {
	return {
		groups,
		totalEdits: groups.reduce((total, group) => total + group.edits.length, 0),
		maxConcurrency,
	};
}

function makeAppliedResult(displayPath, edits) {
	return {
		previewText: `preview:${displayPath}`,
		previewStartLine: 1,
		previewTruncated: false,
		changeStats: { additions: 1, deletions: 0, changedLines: 1 },
		summary: `ok ${edits.length}`,
	};
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

// ─── 2. Byte-budget scheduler keeps inflight bytes within budget ──────────────

test("byte-budget scheduler keeps inflight bytes within MAX_INFLIGHT_BYTES across ten large files", async () => {
	const dir = await makeTempDir("pi-budget-");
	const filePaths = await Promise.all(
		Array.from({ length: 10 }, async (_, i) => {
			const p = path.join(dir, `file${i}.ts`);
			await fs.promises.writeFile(p, "x".repeat(600 * 1024), "utf-8");
			return p;
		}),
	);

	let maxInflight = 0;
	let currentInflight = 0;

	await executeExecutionPlan(
		makePlan(filePaths.map((filePath, index) => makePlanGroup(`file${index}.ts`, filePath)), 10),
		undefined,
		async (_abs, displayPath, edits) => {
			currentInflight += 1;
			if (currentInflight > maxInflight) maxInflight = currentInflight;
			await new Promise((r) => setTimeout(r, 5));
			currentInflight -= 1;
			return makeAppliedResult(displayPath, edits);
		},
	);

	assert.ok(maxInflight < 10, `expected scheduler to throttle; got maxInflight=${maxInflight}`);
	assert.ok(maxInflight >= 1, "at least one file must run");
});

test("successful execution outcome carries previewText and changeStats, not a diff string", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\nconst y = 2;\n");

	const results = await executeExecutionPlan(
		makePlan([makePlanGroup("target.ts", file, "const x = 1;", "const x = 99;")], 1),
	);

	assert.equal(results.length, 1);
	const group = results[0];
	assert.equal(group?.status, "applied");
	if (group?.status !== "applied") throw new Error("expected applied");

	// New contract: previewText and changeStats present
	assert.ok(typeof group.previewText === "string", "previewText must be a string");
	assert.ok(typeof group.changeStats === "object", "changeStats must be present");

	assert.ok(!("diff" in group), "diff field must not exist on success outcome");
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
