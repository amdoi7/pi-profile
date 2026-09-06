import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_EDIT_FILE_SIZE_BYTES, executeEditScript, executeOpEntries } from "../transaction.ts";
import { buildOutcomeAgentContent, parseEditRequest } from "../index.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

test("large file exceeding MAX_EDIT_FILE_SIZE_BYTES is rejected without reading content", async () => {
	let readCalled = false;

	const result = await executeOpEntries(
		[{ absolutePath: "/fake/big.ts", edit: { path: "/fake/big.ts", match: "x", new_str: "y" } }],
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
		parseEditRequest({ note: "why", files: { [file]: [{ match: "const x = 1;", new_str: "const x = 99;" }] } }),
		process.cwd(),
	);

	assert.equal(outcome.status, "applied");
	const [entry] = outcome.entries;
	assert.equal(entry.status, "applied");
	assert.equal(entry.edit.path, file, "outcome reports the path the model wrote, not the canonical one");
	assert.ok(Array.isArray(entry.display.rows), "display must be present");
	assert.ok(typeof entry.changeStats === "object", "changeStats must be present");
	assert.ok(!("op" in entry), "op input must not be echoed in the outcome");
});

test("a failed entry reports the disk state and every failure to the agent", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-partial-"));
	const good = path.join(dir, "good.ts");
	const stale = path.join(dir, "stale.ts");
	await fs.promises.writeFile(good, "const a = 1;\n", "utf-8");
	await fs.promises.writeFile(stale, "const b = 2;\n", "utf-8");

	const outcome = await executeEditScript(
		parseEditRequest({
			note: "why", files: {
				[good]: [{ match: "const a = 1;", new_str: "const a = 11;" }],
				[stale]: [{ match: "missing text" }],
			},
		}),
		process.cwd(),
	);

	assert.equal(outcome.status, "partial");
	const payload = JSON.parse(buildOutcomeAgentContent(outcome));
	assert.equal(payload.status, "partial");
	assert.deepEqual(payload.entries[0].changes, { additions: 1, deletions: 1, changedLines: 2 });
	assert.equal(payload.entries[1].kind, "NOT_FOUND");
	assert.match(payload.entries[1].message, /^match was not found; /);
	assert.equal(await fs.promises.readFile(good, "utf-8"), "const a = 11;\n");
});

test("applied agent payload lists one entry per op with stats and location", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-applied-"));
	const first = path.join(dir, "a.ts");
	const second = path.join(dir, "b.ts");
	await fs.promises.writeFile(first, "const a = 1;\n", "utf-8");
	await fs.promises.writeFile(second, "const b = 2;\n", "utf-8");

	const outcome = await executeEditScript(
		parseEditRequest({
			note: "why", files: {
				[first]: [{ match: "const a = 1;", new_str: "const a = 11;" }],
				[second]: [{ match: "const b = 2;", new_str: "const b = 22;" }],
			},
		}),
		process.cwd(),
	);

	assert.deepEqual(JSON.parse(buildOutcomeAgentContent(outcome)), {
		status: "applied",
		entries: [
			{ path: first, changes: { additions: 1, deletions: 1, changedLines: 2 }, firstChangedLine: 1 },
			{ path: second, changes: { additions: 1, deletions: 1, changedLines: 2 }, firstChangedLine: 1 },
		],
	});
});

test("the same physical file twice under different path spellings is rejected before any write", async () => {
	const file = await writeTempFile("pi-contract-dup-", "target.ts", "const x = 1;\n");

	await assert.rejects(
		() => executeEditScript(
			parseEditRequest({
				note: "why", files: {
					[file]: [{ match: "const x = 1;", new_str: "const x = 2;" }],
					[`./${path.relative(process.cwd(), file)}`]: [{ match: "const", new_str: "let" }],
				},
			}),
			process.cwd(),
		),
		/are aliases of the same file/,
	);
	assert.equal(await fs.promises.readFile(file, "utf-8"), "const x = 1;\n");
});

// 链式语义：provider 先改成功、consumer 的匹配目标在自身原文中不存在 → partial，
// 已成条目保留——这正是「正确修改保留、失败即停」的承诺。
test("a cross-file match that relies on another file's new content fails without undoing it", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-contract-cross-"));
	await fs.promises.writeFile(path.join(dir, "provider.ts"), "const old = 1;\n", "utf-8");
	await fs.promises.writeFile(path.join(dir, "consumer.ts"), "import { x } from './y';\n", "utf-8");

	const outcome = await executeEditScript(
		parseEditRequest({
			note: "why", files: {
				"provider.ts": [{ match: "const old = 1;", new_str: "const brandNewName = 1;" }],
				"consumer.ts": [{ match: "brandNewName" }],
			},
		}),
		dir,
	);

	assert.equal(outcome.status, "partial");
	assert.deepEqual(
		outcome.entries.map((entry) => entry.status),
		["applied", "failed"],
	);
	assert.match(outcome.entries[1].status === "failed" ? outcome.entries[1].error : "", /NOT_FOUND|not found/);
	assert.equal(
		await fs.promises.readFile(path.join(dir, "provider.ts"), "utf-8"),
		"const brandNewName = 1;\n",
	);
});