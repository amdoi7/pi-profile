import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { applyEntryToNormalizedContent } from "../match.ts";
import { executeEntries } from "../transaction.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

/** 单条目调用仍走同一个执行入口（sequence of one）。 */
function runOneEntry(absolutePath, op, signal, operations) {
	return executeEntries([{ absolutePath, entry: { ...op } }], signal, operations);
}

/**
 * 内存 FS：shouldFailWrite(path, writeIndex) 精确指定第几次写失败。
 */
function memoryOperations(initial, shouldFailWrite = () => false) {
	const contents = new Map(Object.entries(initial));
	const writeLog = [];
	const operations = {
		stat: async (target) => ({ size: Buffer.byteLength(contents.get(target) ?? "") }),
		access: async (target) => {
			if (!contents.has(target)) {
				const error = new Error("Missing file");
				error.code = "ENOENT";
				throw error;
			}
		},
		readFile: async (target) => contents.get(target),
		writeFile: async (target, content) => {
			writeLog.push({ path: target, content });
			if (shouldFailWrite(target, writeLog.length)) throw new Error(`write failed for ${target}`);
			contents.set(target, content);
		},
	};
	return { operations, contents, writeLog };
}

test("uses the SDK mutation queue shared with built-in write", async () => {
	const file = await writeTempFile("pi-edit-shared-queue-", "target.txt", "before\n");
	let releaseOuterQueue;
	let markOuterStarted;
	const outerStarted = new Promise((resolve) => { markOuterStarted = resolve; });
	const outerGate = new Promise((resolve) => { releaseOuterQueue = resolve; });
	const outerMutation = withFileMutationQueue(file, async () => {
		markOuterStarted();
		await outerGate;
	});
	await outerStarted;

	let editReadStarted = false;
	const editMutation = runOneEntry(
		file,
		{ match: "before", new_str: "after" },
		undefined,
		{
			access: async () => {},
			stat: async () => ({ size: 7 }),
			readFile: async () => {
				editReadStarted = true;
				return "before\n";
			},
			writeFile: async () => {},
		},
	);

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(editReadStarted, false);
	releaseOuterQueue();
	await Promise.all([outerMutation, editMutation]);
	assert.equal(editReadStarted, true);
});

test("the executor takes every target file's lock before reading any of them", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-batch-lock-"));
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	await fs.promises.writeFile(first, "one\n", "utf-8");
	await fs.promises.writeFile(second, "two\n", "utf-8");

	let releaseOuterQueue;
	let markOuterStarted;
	const outerStarted = new Promise((resolve) => { markOuterStarted = resolve; });
	const outerGate = new Promise((resolve) => { releaseOuterQueue = resolve; });
	// 外部只锁序列的第二个文件：整个序列（含第一个文件）必须等它。
	const outerMutation = withFileMutationQueue(second, async () => {
		markOuterStarted();
		await outerGate;
	});
	await outerStarted;

	const seq = executeEntries([
		{ absolutePath: first, entry: { match: "one", new_str: "uno" } },
		{ absolutePath: second, entry: { match: "two", new_str: "dos" } },
	]);

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(await fs.promises.readFile(first, "utf-8"), "one\n", "sequence must not touch a file while another target is locked");
	releaseOuterQueue();
	const [, result] = await Promise.all([outerMutation, seq]);
	assert.equal(result.status, "applied");
	assert.equal(await fs.promises.readFile(first, "utf-8"), "uno\n");
	assert.equal(await fs.promises.readFile(second, "utf-8"), "dos\n");
});

test("one failed entry applies the earlier ones, names the failure, and stops", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-partial-"));
	const good = path.join(dir, "good.txt");
	const stale = path.join(dir, "stale.txt");
	const later = path.join(dir, "later.txt");
	await fs.promises.writeFile(good, "alpha\n", "utf-8");
	await fs.promises.writeFile(stale, "beta\n", "utf-8");
	await fs.promises.writeFile(later, "gamma\n", "utf-8");

	const result = await executeEntries([
		{ absolutePath: good, entry: { match: "alpha", new_str: "ALPHA" } },
		{ absolutePath: stale, entry: { match: "missing", new_str: "BETA" } },
		{ absolutePath: later, entry: { match: "gamma", new_str: "GAMMA" } },
	]);

	assert.equal(result.status, "partial");
	assert.deepEqual(
		result.entries.map((entry) => entry.status),
		["applied", "failed", "skipped"],
	);
	assert.equal(result.entries[1].errorKind, "NOT_FOUND");
	assert.equal(await fs.promises.readFile(good, "utf-8"), "ALPHA\n", "applied entry stays applied");
	assert.equal(await fs.promises.readFile(stale, "utf-8"), "beta\n", "failed entry stays untouched");
	assert.equal(await fs.promises.readFile(later, "utf-8"), "gamma\n", "later entry is never touched");
});

test("a failure on the first entry rejects the sequence with nothing written", async () => {
	const { operations, contents } = memoryOperations(
		{ "/mem/a.txt": "alpha\n", "/mem/b.txt": "beta\n" },
	);

	const result = await executeEntries([
		{ absolutePath: "/mem/a.txt", entry: { match: "missing-a", new_str: "x" } },
		{ absolutePath: "/mem/b.txt", entry: { match: "beta", new_str: "BETA" } },
	], undefined, operations);

	assert.equal(result.status, "rejected");
	assert.deepEqual(
		result.entries.map((entry) => entry.status),
		["failed", "skipped"],
	);
	assert.equal(contents.get("/mem/a.txt"), "alpha\n");
	assert.equal(contents.get("/mem/b.txt"), "beta\n");
});

test("a write failure keeps earlier entries applied, stops the sequence, and reports it", async () => {
	const { operations, contents, writeLog } = memoryOperations(
		{ "/mem/a.txt": "alpha\n", "/mem/b.txt": "beta\n", "/mem/c.txt": "gamma\n" },
		(target) => target === "/mem/b.txt",
	);

	const result = await executeEntries([
		{ absolutePath: "/mem/a.txt", entry: { match: "alpha", new_str: "ALPHA" } },
		{ absolutePath: "/mem/b.txt", entry: { match: "beta", new_str: "BETA" } },
		{ absolutePath: "/mem/c.txt", entry: { match: "gamma", new_str: "GAMMA" } },
	], undefined, operations);

	assert.equal(result.status, "partial");
	assert.equal(result.entries[0].status, "applied");
	assert.equal(result.entries[1].status, "failed");
	assert.equal(result.entries[2].status, "skipped");
	assert.match(result.entries[1].error, /write failed for \/mem\/b\.txt/);
	assert.equal(contents.get("/mem/a.txt"), "ALPHA\n");
	assert.equal(contents.get("/mem/b.txt"), "beta\n");
	assert.equal(contents.get("/mem/c.txt"), "gamma\n");
	assert.deepEqual(writeLog.map((entry) => entry.path), ["/mem/a.txt", "/mem/b.txt"]);
});

test("an applied sequence returns one preview per entry", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-applied-"));
	const first = path.join(dir, "a.ts");
	const second = path.join(dir, "b.ts");
	await fs.promises.writeFile(first, "const a = 1;\n", "utf-8");
	await fs.promises.writeFile(second, "const b = 2;\n", "utf-8");

	const result = await executeEntries([
		{ absolutePath: first, entry: { match: "const a = 1;", new_str: "const a = 11;" } },
		{ absolutePath: second, entry: { match: "const b = 2;", new_str: "const b = 22;" } },
	]);

	assert.equal(result.status, "applied");
	for (const entry of result.entries) {
		assert.equal(entry.status, "applied");
		assert.ok(entry.display.rows.length > 0);
	}
	assert.equal(await fs.promises.readFile(first, "utf-8"), "const a = 11;\n");
	assert.equal(await fs.promises.readFile(second, "utf-8"), "const b = 22;\n");
});

test("identical entries in one sequence chain on the same file", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-chain-"));
	const file = path.join(dir, "c.txt");
	await fs.promises.writeFile(file, "one\n", "utf-8");

	const result = await executeEntries([
		{ absolutePath: file, entry: { match: "one", new_str: "two" } },
		{ absolutePath: file, entry: { match: "two", new_str: "three" } },
	]);

	assert.equal(result.status, "applied");
	assert.equal(await fs.promises.readFile(file, "utf-8"), "three\n");
});

// ─── 匹配语义（applyEntryToNormalizedContent） ─────────────────────────────────

// 引号不再有回写方言:弯引号文件里写什么就洛什么。match 必须显式写弯引号,没命中
// 走显式 closest hint。
test("curly quotes in the file must be matched verbatim — no silent rewriting", () => {
	const original = ['title: “keep me”', 'message: “old value”', 'footer — untouched', ''].join("\n");

	assert.throws(
		() => applyEntryToNormalizedContent(
			original,
			{ match: 'message: "old value"\n', new_str: 'message: "new value"\n' },
		),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			assert.ok(error.closest !== undefined, "closest hint must be present");
			return true;
		},
	);
});



test("delete removes the matched text verbatim", () => {
	const { newContent } = applyEntryToNormalizedContent(
		"keep\ndead_code();\nkeep\n",
		{ match: "dead_code();\n" },
	);
	assert.equal(newContent, "keep\nkeep\n");
});

test("replace reports one span for the unique hit", () => {
	const { newContent, matchedSpans } = applyEntryToNormalizedContent(
		"const oldName = 1;\n",
		{ match: "oldName", new_str: "newName" },
	);

	assert.equal(newContent, "const newName = 1;\n");
	assert.equal(matchedSpans.length, 1);
});

test("a repeated match is rejected as DUPLICATE_MATCH", () => {
	assert.throws(
		() => applyEntryToNormalizedContent("aaa aaa", { match: "aaa", new_str: "b" }),
		/matched 2 locations/,
	);
});

test("exact unique match wins over fuzzy-equivalent quote variants elsewhere", () => {
	const { newContent } = applyEntryToNormalizedContent(
		'x: “v”\nx: "v"\n',
		{ match: 'x: “v”\n', new_str: 'x: “w”\n' },
	);

	assert.equal(newContent, 'x: “w”\nx: "v"\n');
});

test("not-found diagnostics omit the known path and name match", async () => {
	const original = ['title: “keep me”', 'needle   ', 'footer — untouched', ''].join("\n");
	const file = await writeTempFile("pi-edit-fuzzy-", "story.txt", original);

	const result = await runOneEntry(file, { match: 'needle\nfooter - untouched\n', new_str: 'replaced\nfooter - untouched\n' });

	assert.equal(result.status, "rejected");
	assert.equal(result.entries[0].errorKind, "NOT_FOUND");
	assert.match(result.entries[0].error, /^match was not found; /);
	assert.doesNotMatch(result.entries[0].error, /story\.txt/);
	assert.equal(await fs.promises.readFile(file, "utf-8"), original);
});

test("LF match matches CRLF file content and preserves the original line endings", async () => {
	const file = await writeTempFile("pi-edit-crlf-", "win.txt", 'alpha\r\nbeta\r\nomega\r\n');

	const result = await runOneEntry(file, { match: 'alpha\nbeta\n', new_str: 'alpha\ngamma\n' });

	assert.equal(result.status, "applied");
	assert.equal(await fs.promises.readFile(file, "utf-8"), 'alpha\r\ngamma\r\nomega\r\n');
});

test("permission errors omit the known path and name the required access", async () => {
	const accessError = new Error("Permission denied");
	accessError.code = "EACCES";

	const result = await runOneEntry(
		"/tmp/locked.txt",
		{ match: "hello", new_str: "world" },
		undefined,
		{
			stat: async () => ({ size: 6 }),
			access: async () => {
				throw accessError;
			},
			readFile: async () => "hello\n",
			writeFile: async () => {},
		},
	);

	assert.equal(result.status, "rejected");
	assert.equal(result.entries[0].error, "File must be readable and writable. Check permissions.");
});

test("missing file diagnostics omit the known path", async () => {
	const accessError = new Error("Missing file");
	accessError.code = "ENOENT";

	const result = await runOneEntry(
		"/tmp/missing.txt",
		{ match: "hello", new_str: "world" },
		undefined,
		{
			stat: async () => ({ size: 0 }),
			access: async () => {
				throw accessError;
			},
			readFile: async () => "hello\n",
			writeFile: async () => {},
		},
	);

	assert.equal(result.status, "rejected");
	assert.equal(result.entries[0].error, "File not found.");
});

test("identical replacement fails closed as a structured no-change edit error", async () => {
	const file = await writeTempFile("pi-edit-no-change-", "target.ts", "const answer = 42;\n");

	const result = await runOneEntry(file, { match: "const answer = 42;", new_str: "const answer = 42;" });

	assert.equal(result.status, "rejected");
	assert.equal(result.entries[0].errorKind, "NO_CHANGE");
	assert.equal(await fs.promises.readFile(file, "utf-8"), "const answer = 42;\n");
});

test("an empty match is rejected at the boundary", () => {
	assert.throws(
		() => applyEntryToNormalizedContent("alpha\n", { match: "", new_str: "y" }),
		/^Error: match must not be empty\.$/,
	);
});

// 匹配阶梯的语义优先级（不是性能优化，是行为承诺）：
// 一切分歧显式化(2026-09-09 撤修):直引号 match 不再折叠弯/全角变体,
// 文件里是什么写法就必须用什么写法;没命中就走显式 closest hint,引擎不猜方言。
test("exact hit suppresses the fuzzy variant of the same text", () => {
	const { newContent } = applyEntryToNormalizedContent("x,y x，y\n", { match: "x,y", new_str: "z" });
	assert.equal(newContent, "z x，y\n");
});