import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { applyOpToNormalizedContent } from "../match.ts";
import { executeOpEntries } from "../transaction.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

/** 单条目调用仍走同一个执行入口（sequence of one）。 */
function runOneEntry(absolutePath, op, signal, operations) {
	return executeOpEntries([{ absolutePath, edit: { path: absolutePath, ...op } }], signal, operations);
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

	const seq = executeOpEntries([
		{ absolutePath: first, edit: { path: first, match: "one", new_str: "uno" } },
		{ absolutePath: second, edit: { path: second, match: "two", new_str: "dos" } },
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

	const result = await executeOpEntries([
		{ absolutePath: good, edit: { path: good, match: "alpha", new_str: "ALPHA" } },
		{ absolutePath: stale, edit: { path: stale, match: "missing", new_str: "BETA" } },
		{ absolutePath: later, edit: { path: later, match: "gamma", new_str: "GAMMA" } },
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

	const result = await executeOpEntries([
		{ absolutePath: "/mem/a.txt", edit: { path: "/mem/a.txt", match: "missing-a", new_str: "x" } },
		{ absolutePath: "/mem/b.txt", edit: { path: "/mem/b.txt", match: "beta", new_str: "BETA" } },
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

	const result = await executeOpEntries([
		{ absolutePath: "/mem/a.txt", edit: { path: "/mem/a.txt", match: "alpha", new_str: "ALPHA" } },
		{ absolutePath: "/mem/b.txt", edit: { path: "/mem/b.txt", match: "beta", new_str: "BETA" } },
		{ absolutePath: "/mem/c.txt", edit: { path: "/mem/c.txt", match: "gamma", new_str: "GAMMA" } },
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

	const result = await executeOpEntries([
		{ absolutePath: first, edit: { path: first, match: "const a = 1;", new_str: "const a = 11;" } },
		{ absolutePath: second, edit: { path: second, match: "const b = 2;", new_str: "const b = 22;" } },
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

	const result = await executeOpEntries([
		{ absolutePath: file, edit: { path: file, match: "one", new_str: "two" } },
		{ absolutePath: file, edit: { path: file, match: "two", new_str: "three" } },
	]);

	assert.equal(result.status, "applied");
	assert.equal(await fs.promises.readFile(file, "utf-8"), "three\n");
});

// ─── 匹配语义（applyOpToNormalizedContent） ─────────────────────────────────

test("quote fallback preserves unrelated typography and replacement quote style", () => {
	const original = ['title: “keep me”', 'message: “old value”', 'footer — untouched', ''].join("\n");

	const { newContent } = applyOpToNormalizedContent(
		original,
		{ match: 'message: "old value"\n', new_str: 'message: "new value"\n' },
	);

	assert.equal(
		newContent,
		['title: “keep me”', 'message: “new value”', 'footer — untouched', ''].join("\n"),
	);
});



test("delete removes the matched text verbatim", () => {
	const { newContent } = applyOpToNormalizedContent(
		"keep\ndead_code();\nkeep\n",
		{ match: "dead_code();\n" },
	);
	assert.equal(newContent, "keep\nkeep\n");
});

test("replace replaces every exact occurrence and reports a span per hit", () => {
	const { newContent, matchedSpans } = applyOpToNormalizedContent(
		"const oldName = oldName + oldName;\n",
		{ match: "oldName", new_str: "newName" },
	);

	assert.equal(newContent, "const newName = newName + newName;\n");
	assert.equal(matchedSpans.length, 3);
});

test("replace defaults to replacing all matches", () => {
	const { newContent } = applyOpToNormalizedContent("aaa aaa", { match: "aaa", new_str: "b" });
	assert.equal(newContent, "b b");
});

test("exact unique match wins over fuzzy-equivalent quote variants elsewhere", () => {
	const { newContent } = applyOpToNormalizedContent(
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
		() => applyOpToNormalizedContent("alpha\n", { match: "", new_str: "y" }),
		/^Error: match must not be empty\.$/,
	);
});

// 匹配阶梯的语义优先级（不是性能优化，是行为承诺）：
// - exact 命中存在 ⇒ 只用 exact 桶，fuzzy 变体不参与计数或替换；
// - 全弯引号两处命中直引号 match ⇒ fuzzy 层全部替换（多命中不再报 DUPLICATE_MATCH）。
test("exact hit suppresses the fuzzy variant of the same text", () => {
	const { newContent } = applyOpToNormalizedContent("x,y x，y\n", { match: "x,y", new_str: "z" });
	assert.equal(newContent, "z x，y\n");
});

test("two fuzzy variants of a straight-quote match are replaced by default", () => {
	const { newContent } = applyOpToNormalizedContent("x’y x’y\n", { match: "x'y", new_str: "z" });
	assert.equal(newContent, "z z\n");
});