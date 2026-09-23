import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_EDIT_FILE_SIZE_BYTES, executeEditScript, executeEntries } from "../transaction.ts";
import { buildOutcomeAgentContent, parseEditRequest } from "../index.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

test("large file exceeding MAX_EDIT_FILE_SIZE_BYTES is rejected without reading content", async () => {
	let readCalled = false;

	const result = await executeEntries(
		[{ absolutePath: "/fake/big.ts", entry: { match: "x", new_str: "y" } }],
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
		result.entries[0].error,
		`File too large: sizeBytes=${MAX_EDIT_FILE_SIZE_BYTES + 1} limitBytes=${MAX_EDIT_FILE_SIZE_BYTES}; use a narrower match or a streaming tool.`,
	);
	assert.equal(readCalled, false, "readFile must not be called for oversized files");
});

test("applied outcome carries structured preview and changeStats per entry", async () => {
	const file = await writeTempFile("pi-contract-", "target.ts", "const x = 1;\n");

	const outcome = await executeEditScript(
		parseEditRequest({ note: "why", path: file, edits: [{ match: "const x = 1;", new_str: "const x = 99;" }] }),
		process.cwd(),
	);

	assert.equal(outcome.status, "applied");
	const [entry] = outcome.entries;
	assert.equal(entry.status, "applied");
	assert.equal(outcome.path, file, "outcome reports the one file this call edits");
	assert.ok(Array.isArray(entry.display.rows), "display must be present");
	assert.ok(typeof entry.changeStats === "object", "changeStats must be present");
	assert.ok(!("op" in entry), "op input must not be echoed in the outcome");
});

test("a failed entry reports the disk state and every failure to the agent", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-partial-"));
	const good = path.join(dir, "good.ts");
	await fs.promises.writeFile(good, "const a = 1;\n", "utf-8");

	const outcome = await executeEditScript(
		parseEditRequest({
			note: "why", path: good, edits: [
				{ match: "const a = 1;", new_str: "const a = 11;" },
				{ match: "const a = 12;" },
			],
		}),
		process.cwd(),
	);

	assert.equal(outcome.status, "partial");
	const payload = JSON.parse(buildOutcomeAgentContent(outcome));
	assert.equal(payload.status, "partial");
	assert.deepEqual(payload.entries[0].changes, { additions: 1, deletions: 1, changedLines: 2 });
	assert.equal(payload.entries[1].kind, "NOT_FOUND");
	assert.match(payload.entries[1].message, /match was not found; /);
	// closest 端到端:execute → outcome → agent JSON,照抄载荷不丢。
	assert.deepEqual(payload.entries[1].closest, { startLine: 1, text: "const a = 11;", truncated: false });
	assert.equal(await fs.promises.readFile(good, "utf-8"), "const a = 11;\n");
});

test("applied agent payload names the file once and lists one entry per op with stats", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-applied-"));
	const file = path.join(dir, "a.ts");
	await fs.promises.writeFile(file, "const a = 1;\nconst b = 2;\n", "utf-8");

	const outcome = await executeEditScript(
		parseEditRequest({
			note: "why", path: file, edits: [
				{ match: "const a = 1;", new_str: "const a = 11;" },
				{ match: "const b = 2;", new_str: "const b = 22;" },
			],
		}),
		process.cwd(),
	);

	assert.deepEqual(JSON.parse(buildOutcomeAgentContent(outcome)), {
		status: "applied",
		path: file,
		entries: [
			{ changes: { additions: 1, deletions: 1, changedLines: 2 }, firstChangedLine: 1 },
			{ changes: { additions: 1, deletions: 1, changedLines: 2 }, firstChangedLine: 2 },
		],
	});
});

// 链式语义：后一条目匹配前一条目刚写入的内容——链条作用在同一文件的
// 演进内容上，这是单文件契约下的核心执行语义。
test("an entry can match a previous entry\'s new content (chained, one file)", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-chain-"));
	const file = path.join(dir, "target.ts");
	await fs.promises.writeFile(file, "const old = 1;\n", "utf-8");

	const outcome = await executeEditScript(
		parseEditRequest({
			note: "why", path: file, edits: [
				{ match: "const old = 1;", new_str: "const brandNewName = 1;" },
				{ match: "const brandNewName = 1;", new_str: "const renamed = 1;" },
			],
		}),
		dir,
	);

	assert.equal(outcome.status, "applied");
	assert.equal(await fs.promises.readFile(file, "utf-8"), "const renamed = 1;\n");
});