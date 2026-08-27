import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_EDIT_FILE_SIZE_BYTES, executeBatchEdits } from "./transaction.ts";
import { buildOutcomeAgentContent, executeEditBatch } from "./pipeline.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

test("large file exceeding MAX_EDIT_FILE_SIZE_BYTES is rejected without reading content", async () => {
	let readCalled = false;

	const result = await executeBatchEdits(
		[{ absolutePath: "/fake/big.ts", edits: [{ oldText: "x", newText: "y" }] }],
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
	);

	assert.equal(result.status, "rejected");
	assert.equal(
		result.files[0].error,
		`File too large: sizeBytes=${MAX_EDIT_FILE_SIZE_BYTES + 1} limitBytes=${MAX_EDIT_FILE_SIZE_BYTES}; use a narrower oldText or a streaming tool.`,
	);
	assert.equal(readCalled, false, "readFile must not be called for oversized files");
});

// ─── 2. Batch outcome contract ──────────────────────────────────────────────

test("applied outcome carries structured preview and changeStats per file", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\nconst y = 2;\n");

	const outcome = await executeEditBatch(
		{
			intent: "bump x",
			files: [{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }] }],
		},
		process.cwd(),
	);

	assert.equal(outcome.status, "applied");
	const [fileOutcome] = outcome.files;
	assert.equal(fileOutcome.status, "applied");
	assert.equal(fileOutcome.path, file, "outcome reports the path the model wrote, not the canonical one");
	assert.ok(Array.isArray(fileOutcome.display.rows), "display must be present");
	assert.ok(typeof fileOutcome.changeStats === "object", "changeStats must be present");
	assert.ok(!("edits" in fileOutcome), "edit input must not be echoed in the outcome");
	assert.ok(!("canonicalPath" in fileOutcome), "canonicalPath must not leak from execution");
});

test("rejected outcome reports the disk state and every failure to the agent", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-batch-"));
	const good = path.join(dir, "good.ts");
	const stale = path.join(dir, "stale.ts");
	await fs.promises.writeFile(good, "const a = 1;\n", "utf-8");
	await fs.promises.writeFile(stale, "const b = 2;\n", "utf-8");

	const outcome = await executeEditBatch(
		{
			intent: "renumber constants",
			files: [
				{ path: good, edits: [{ oldText: "const a = 1;", newText: "const a = 11;" }] },
				{ path: stale, edits: [{ oldText: "missing text", newText: "replacement" }] },
			],
		},
		process.cwd(),
	);

	assert.equal(outcome.status, "rejected");
	const payload = JSON.parse(buildOutcomeAgentContent(outcome));
	const [failure] = payload.failed;
	assert.deepEqual(
		{ ...payload, failed: payload.failed.length },
		{ status: "rejected", written: [], failed: 1 },
	);
	assert.deepEqual(
		{ path: failure.path, kind: failure.kind },
		{ path: stale, kind: "NOT_FOUND" },
	);
	assert.match(failure.message, /^oldText was not found; /);
	assert.equal(await fs.promises.readFile(good, "utf-8"), "const a = 1;\n");
});

test("applied agent payload lists one entry per file with stats and location", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-applied-"));
	const first = path.join(dir, "a.ts");
	const second = path.join(dir, "b.ts");
	await fs.promises.writeFile(first, "const a = 1;\n", "utf-8");
	await fs.promises.writeFile(second, "const b = 2;\n", "utf-8");

	const outcome = await executeEditBatch(
		{
			intent: "renumber constants",
			files: [
				{ path: first, hint: "left side", edits: [{ oldText: "const a = 1;", newText: "const a = 11;" }] },
				{ path: second, edits: [{ oldText: "const b = 2;", newText: "const b = 22;" }] },
			],
		},
		process.cwd(),
	);

	assert.deepEqual(JSON.parse(buildOutcomeAgentContent(outcome)), {
		status: "applied",
		files: [
			{ path: first, changes: { additions: 1, deletions: 1, changedLines: 2 }, firstChangedLine: 1 },
			{ path: second, changes: { additions: 1, deletions: 1, changedLines: 2 }, firstChangedLine: 1 },
		],
	});
});

test("the same physical file twice under different path spellings is rejected before any write", async () => {
	const file = await writeTempFile("pi-contract-dup-", "target.ts", "const x = 1;\n");

	await assert.rejects(
		() => executeEditBatch(
			{
				intent: "double entry",
				files: [
					{ path: file, edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }] },
					{ path: `./${path.relative(process.cwd(), file)}`, edits: [{ oldText: "const", newText: "let" }] },
				],
			},
			process.cwd(),
		),
		/is an alias of files\[0\]\.path.*merge their edits into one entry/s,
	);
	assert.equal(await fs.promises.readFile(file, "utf-8"), "const x = 1;\n");
});

// 跨文件锚悬空在解析面就是 files[1] 的 NOT_FOUND（软失败）：整批 rejected、
// 零写入，错误带逐字指认——不需要单独的跨文件检查。
test("a cross-file anchor that only exists in another file's new content rejects the batch with NOT_FOUND", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-cross-"));
	await fs.promises.writeFile(path.join(dir, "provider.ts"), "const old = 1;\n", "utf-8");
	await fs.promises.writeFile(path.join(dir, "consumer.ts"), "import { x } from './y';\n", "utf-8");

	const outcome = await executeEditBatch(
		{
			intent: "rename in provider, then reference the new name",
			files: [
				{ path: "provider.ts", edits: [{ oldText: "const old = 1;", newText: "const brandNewName = 1;" }] },
				{ path: "consumer.ts", edits: [{ oldText: "brandNewName", newText: "renamed" }] },
			],
		},
		dir,
	);

	assert.equal(outcome.status, "rejected");
	assert.deepEqual(
		outcome.files.map((file) => file.status),
		["notWritten", "failed"],
	);
	assert.match(outcome.files[1].status === "failed" ? outcome.files[1].error : "", /NOT_FOUND|not found/);
	assert.equal(
		await fs.promises.readFile(path.join(dir, "provider.ts"), "utf-8"),
		"const old = 1;\n",
	);
});
