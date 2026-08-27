import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { generateFinalDiff, serializeDisplayDiff } from "../_shared/final-diff.ts";

import {
	applyEditsToNormalizedContent,
	executeBatchEdits,
} from "./edit-engine.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

/** 单文件调用仍走同一个事务入口（batch of one）。 */
function runOneFile(absolutePath, edits, signal, operations) {
	return executeBatchEdits([{ absolutePath, edits }], signal, operations);
}

/**
 * 内存 FS：shouldFailWrite(path, writeIndex) 精确指定第几次写失败，
 * 用来区分「首次落盘失败」与「回滚写失败」。
 */
function memoryOperations(initial, shouldFailWrite = () => false) {
	const contents = new Map(Object.entries(initial));
	const writeLog = [];
	const readLog = [];
	const operations = {
		stat: async (target) => ({ size: Buffer.byteLength(contents.get(target) ?? "") }),
		access: async (target) => {
			if (!contents.has(target)) {
				const error = new Error("Missing file");
				error.code = "ENOENT";
				throw error;
			}
		},
		readFile: async (target) => {
			readLog.push(target);
			return contents.get(target);
		},
		writeFile: async (target, content) => {
			writeLog.push({ path: target, content });
			if (shouldFailWrite(target, writeLog.length)) throw new Error(`write failed for ${target}`);
			contents.set(target, content);
		},
	};
	return { operations, contents, writeLog, readLog };
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
	const editMutation = runOneFile(
		file,
		[{ oldText: "before", newText: "after" }],
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

test("the transaction takes every target file's lock before reading any of them", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-batch-lock-"));
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	await fs.promises.writeFile(first, "one\n", "utf-8");
	await fs.promises.writeFile(second, "two\n", "utf-8");

	let releaseOuterQueue;
	let markOuterStarted;
	const outerStarted = new Promise((resolve) => { markOuterStarted = resolve; });
	const outerGate = new Promise((resolve) => { releaseOuterQueue = resolve; });
	// 外部只锁 batch 的第二个文件：整批（含第一个文件）必须等它。
	const outerMutation = withFileMutationQueue(second, async () => {
		markOuterStarted();
		await outerGate;
	});
	await outerStarted;

	const batch = executeBatchEdits([
		{ absolutePath: first, edits: [{ oldText: "one", newText: "uno" }] },
		{ absolutePath: second, edits: [{ oldText: "two", newText: "dos" }] },
	]);

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(await fs.promises.readFile(first, "utf-8"), "one\n", "batch must not touch a file while another target is locked");
	releaseOuterQueue();
	const [, result] = await Promise.all([outerMutation, batch]);
	assert.equal(result.status, "applied");
	assert.equal(await fs.promises.readFile(first, "utf-8"), "uno\n");
	assert.equal(await fs.promises.readFile(second, "utf-8"), "dos\n");
});

test("one unresolved anchor leaves every file in the batch untouched", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-batch-reject-"));
	const good = path.join(dir, "good.txt");
	const stale = path.join(dir, "stale.txt");
	await fs.promises.writeFile(good, "alpha\n", "utf-8");
	await fs.promises.writeFile(stale, "beta\n", "utf-8");

	const result = await executeBatchEdits([
		{ absolutePath: good, edits: [{ oldText: "alpha", newText: "ALPHA" }] },
		{ absolutePath: stale, edits: [{ oldText: "missing", newText: "BETA" }] },
	]);

	assert.equal(result.status, "rejected");
	assert.deepEqual(result.files[0], { status: "notWritten", restored: false });
	assert.equal(result.files[1].status, "failed");
	assert.equal(result.files[1].errorKind, "NOT_FOUND");
	assert.equal(await fs.promises.readFile(good, "utf-8"), "alpha\n", "resolvable file must stay untouched");
	assert.equal(await fs.promises.readFile(stale, "utf-8"), "beta\n");
});

test("a rejected batch reports every file's failure in one round trip", async () => {
	const { operations } = memoryOperations({ "/mem/a.txt": "alpha\n", "/mem/b.txt": "beta\n" });

	const result = await executeBatchEdits([
		{ absolutePath: "/mem/a.txt", edits: [{ oldText: "missing-a", newText: "x" }] },
		{ absolutePath: "/mem/b.txt", edits: [{ oldText: "missing-b", newText: "y" }] },
	], undefined, operations);

	assert.equal(result.status, "rejected");
	assert.deepEqual(
		result.files.map((file) => [file.status, file.errorKind]),
		[["failed", "NOT_FOUND"], ["failed", "NOT_FOUND"]],
	);
});

test("a write failure rolls the already-written files back to their original bytes", async () => {
	const { operations, contents, writeLog } = memoryOperations(
		{ "/mem/a.txt": "alpha\n", "/mem/b.txt": "beta\n" },
		(target) => target === "/mem/b.txt",
	);

	const result = await executeBatchEdits([
		{ absolutePath: "/mem/a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
		{ absolutePath: "/mem/b.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
	], undefined, operations);

	assert.equal(result.status, "rejected");
	assert.deepEqual(result.files[0], { status: "notWritten", restored: true });
	assert.equal(result.files[1].status, "failed");
	assert.match(result.files[1].error, /write failed for \/mem\/b\.txt/);
	assert.equal(contents.get("/mem/a.txt"), "alpha\n", "rollback must restore the original bytes");
	assert.deepEqual(writeLog.map((entry) => entry.path), ["/mem/a.txt", "/mem/b.txt", "/mem/a.txt"]);
});

test("an unrestorable write failure reports partial and names the stranded file", async () => {
	const { operations, contents } = memoryOperations(
		{ "/mem/a.txt": "alpha\n", "/mem/b.txt": "beta\n" },
		// b 的落盘失败，a 的回滚写（第 3 次写）也失败 → a 留在盘上。
		(target, writeIndex) => target === "/mem/b.txt" || writeIndex === 3,
	);

	const result = await executeBatchEdits([
		{ absolutePath: "/mem/a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
		{ absolutePath: "/mem/b.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
	], undefined, operations);

	assert.equal(result.status, "partial");
	assert.equal(result.files[0].status, "applied");
	assert.ok(result.files[0].preview.changeStats.changedLines > 0);
	assert.equal(result.files[1].status, "failed");
	assert.equal(contents.get("/mem/a.txt"), "ALPHA\n", "unrestorable write stays on disk and must be reported");
});

test("an applied batch returns one preview per file", async () => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-edit-batch-applied-"));
	const first = path.join(dir, "a.ts");
	const second = path.join(dir, "b.ts");
	await fs.promises.writeFile(first, "const a = 1;\n", "utf-8");
	await fs.promises.writeFile(second, "const b = 2;\n", "utf-8");

	const result = await executeBatchEdits([
		{ absolutePath: first, edits: [{ oldText: "const a = 1;", newText: "const a = 11;" }] },
		{ absolutePath: second, edits: [{ oldText: "const b = 2;", newText: "const b = 22;" }] },
	]);

	assert.equal(result.status, "applied");
	for (const file of result.files) {
		assert.equal(file.status, "applied");
		assert.ok(file.preview.previewDisplay.rows.length > 0);
		assert.equal(file.preview.changeStats.changedLines, 2);
	}
	assert.equal(await fs.promises.readFile(first, "utf-8"), "const a = 11;\n");
	assert.equal(await fs.promises.readFile(second, "utf-8"), "const b = 22;\n");
});

test("quote fallback preserves unrelated typography and replacement quote style", () => {
	const original = ['title: “keep me”', 'message: “old value”', 'footer — untouched', ''].join("\n");

	const { newContent } = applyEditsToNormalizedContent(
		original,
		[{ oldText: 'message: "old value"\n', newText: 'message: "new value"\n' }],
	);

	assert.equal(
		newContent,
		['title: “keep me”', 'message: “new value”', 'footer — untouched', ''].join("\n"),
	);
});

test("not-found diagnostics omit the known path and first replacement index", async () => {
	const original = ['title: “keep me”', 'needle   ', 'footer — untouched', ''].join("\n");
	const file = await writeTempFile("pi-edit-engine-fuzzy-", "story.txt", original);

	const result = await runOneFile(file, [{ oldText: 'needle\nfooter - untouched\n', newText: 'replaced\nfooter - untouched\n' }]);

	assert.equal(result.status, "rejected");
	assert.equal(result.files[0].errorKind, "NOT_FOUND");
	assert.match(result.files[0].error, /^oldText was not found; /);
	assert.doesNotMatch(result.files[0].error, /story\.txt|edits\[0\]/);
	assert.equal(await fs.promises.readFile(file, "utf-8"), original);
});

test("not-found diagnostics identify a later replacement without repeating the path", () => {
	assert.throws(
		() => applyEditsToNormalizedContent(
			"first\n",
			[
				{ oldText: "first", newText: "updated" },
				{ oldText: "missing", newText: "replacement" },
			],
		),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			assert.match(
				error.message,
				/^replacement 2: oldText was not found; /
			);
			assert.doesNotMatch(error.message, /story\.txt|edits\[/);
			return true;
		},
	);
});

test("one file's edits report every failure in one message", () => {
	assert.throws(
		() => applyEditsToNormalizedContent(
			"first\nsecond\n",
			[
				{ oldText: "missing-one", newText: "replacement" },
				{ oldText: "second", newText: "updated" },
				{ oldText: "missing-two", newText: "replacement" },
			],
		),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			// 批量失败聚合：每个失败都带 next 指令（replacement 编号前缀）。
			assert.match(
				error.message,
				/^edit failed \(2 of 3\):\n  oldText was not found;[^\n]+\n  replacement 3: oldText was not found;[^\n]+$/
			);
			return true;
		},
	);
});

test("LF oldText matches CRLF file content and preserves the original line endings", async () => {
	const file = await writeTempFile("pi-edit-engine-crlf-", "win.txt", 'alpha\r\nbeta\r\nomega\r\n');

	const result = await runOneFile(file, [{ oldText: 'alpha\nbeta\n', newText: 'alpha\ngamma\n' }]);

	assert.equal(result.status, "applied");
	assert.equal(await fs.promises.readFile(file, "utf-8"), 'alpha\r\ngamma\r\nomega\r\n');
});

test("duplicate matches report their count and recovery", () => {
	assert.throws(
		() => applyEditsToNormalizedContent('aaaa', [{ oldText: 'aaa', newText: 'bbb' }]),
		(error) => {
			assert.equal(error.kind, 'DUPLICATE_MATCH');
			assert.equal(
				error.message,
				"oldText matched 2 locations (L1)",
			);
			return true;
		},
	);
});

test("exact unique match wins over fuzzy-equivalent quote variants elsewhere", () => {
	const { newContent } = applyEditsToNormalizedContent(
		'x: “v”\nx: "v"\n',
		[{ oldText: 'x: “v”\n', newText: 'x: “w”\n' }],
	);

	assert.equal(newContent, 'x: “w”\nx: "v"\n');
});

test("replaceAll replaces every exact occurrence", () => {
	const { newContent, matchedSpans } = applyEditsToNormalizedContent(
		'const oldName = oldName + oldName;\n',
		[{ oldText: 'oldName', newText: 'newName', replaceAll: true }],
	);

	assert.equal(newContent, 'const newName = newName + newName;\n');
	assert.equal(matchedSpans.length, 3);
});

test("replaceAll false keeps duplicate-match guidance", () => {
	assert.throws(
		() => applyEditsToNormalizedContent(
			'const oldName = oldName;\n',
			[{ oldText: 'oldName', newText: 'newName', replaceAll: false }],
		),
		(error) => {
			assert.equal(error.kind, 'DUPLICATE_MATCH');
			assert.equal(
				error.message,
				"oldText matched 2 locations (L1)",
			);
			return true;
		},
	);
});

test("permission errors omit the known path and name the required access", async () => {
	const accessError = new Error("Permission denied");
	accessError.code = "EACCES";

	const result = await runOneFile(
		"/tmp/locked.txt",
		[{ oldText: 'hello', newText: 'world' }],
		undefined,
		{
			stat: async () => ({ size: 6 }),
			access: async () => {
				throw accessError;
			},
			readFile: async () => 'hello\n',
			writeFile: async () => {},
		},
	);

	assert.equal(result.status, "rejected");
	assert.equal(result.files[0].error, "File must be readable and writable. Check permissions.");
});

test("missing file diagnostics omit the known path", async () => {
	const accessError = new Error("Missing file");
	accessError.code = "ENOENT";

	const result = await runOneFile(
		"/tmp/missing.txt",
		[{ oldText: "hello", newText: "world" }],
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
	assert.equal(result.files[0].error, "File not found.");
});

test("identical replacement fails closed as a structured no-change edit error", async () => {
	const file = await writeTempFile("pi-edit-no-change-", "target.ts", "const answer = 42;\n");

	const result = await runOneFile(file, [{ oldText: "const answer = 42;", newText: "const answer = 42;" }]);

	assert.equal(result.status, "rejected");
	assert.equal(result.files[0].errorKind, "NO_CHANGE");
	assert.equal(result.files[0].error, "No change: newText normalizes to oldText");
	assert.equal(await fs.promises.readFile(file, "utf-8"), "const answer = 42;\n");
});

test("preview line numbers describe complete before and after lines when edits share a line", () => {
	const oldContent = "const total = oldLeft + oldRight;\nnext();\n";
	const { newContent } = applyEditsToNormalizedContent(
		oldContent,
		[
			{ oldText: "oldLeft", newText: "newLeft" },
			{ oldText: "oldRight", newText: "newRight" },
		],
	);

	const preview = generateFinalDiff(oldContent, newContent);

	assert.equal(
		serializeDisplayDiff(preview.display),
		"-1   │ const total = oldLeft + oldRight;\n+  1 │ const total = newLeft + newRight;\n 2 2 │ next();",
	);
	assert.equal(preview.firstChangedLine, 1);
	assert.deepEqual(preview.stats, { additions: 1, deletions: 1, changedLines: 2 });
});

test("preview keeps unchanged lines as context inside a replaced block", () => {
	const oldContent = [
		"package x",
		"",
		"import (",
		'    "bytes"',
		'    "encoding/json"',
		'    "io"',
		'    "os"',
		'    "testing"',
		"",
		'    platformfeishu "github.com/amdoi7/isla/internal/platform/bot/feishu"',
		'    "github.com/stretchr/testify/assert"',
		'    "github.com/stretchr/testify/require"',
		")",
		"",
	].join("\n");

	const oldText = [
		"import (",
		'    "bytes"',
		'    "encoding/json"',
		'    "io"',
		'    "os"',
		'    "testing"',
		"",
		'    platformfeishu "github.com/amdoi7/isla/internal/platform/bot/feishu"',
		'    "github.com/stretchr/testify/assert"',
		'    "github.com/stretchr/testify/require"',
		")",
	].join("\n");

	const newText = [
		"import (",
		'    "bytes"',
		'    "context"',
		'    "encoding/json"',
		'    "io"',
		'    "os"',
		'    "testing"',
		"",
		'    platformfeishu "github.com/amdoi7/isla/internal/platform/bot/feishu"',
		'    "github.com/stretchr/testify/assert"',
		'    "github.com/stretchr/testify/require"',
		")",
	].join("\n");

	const { newContent } = applyEditsToNormalizedContent(
		oldContent,
		[{ oldText, newText }],
	);
	const preview = generateFinalDiff(oldContent, newContent);

	const rendered = serializeDisplayDiff(preview.display);
	assert.match(rendered, /"bytes"/);
	assert.match(rendered, /"context"/);
	assert.match(rendered, /^\+    5 │/m);
	assert.doesNotMatch(rendered, /^- 4/m);
	assert.ok((preview.firstChangedLine ?? 0) > 0);
});
