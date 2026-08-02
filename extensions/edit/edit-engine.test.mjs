import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { generateFinalDiff, serializeDisplayDiff } from "../_shared/final-diff.ts";

import {
	applyEditsToNormalizedContent,
	EditToolError,
	executeFileEdits,
} from "./edit-engine.ts";

async function writeTempFile(prefix, name, content) {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
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
	const editMutation = executeFileEdits(
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

	await assert.rejects(
		() => executeFileEdits(file, [{ oldText: 'needle\nfooter - untouched\n', newText: 'replaced\nfooter - untouched\n' }]),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, 'NOT_FOUND');
			assert.equal(
				error.message,
				"oldText was not found. Re-read the file and copy oldText exactly, including whitespace.",
			);
			assert.doesNotMatch(error.message, /story\.txt|edits\[0\]/);
			return true;
		},
	);
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
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, "NOT_FOUND");
			assert.equal(
				error.message,
				"replacement 2: oldText was not found. Re-read the file and copy oldText exactly, including whitespace.",
			);
			assert.doesNotMatch(error.message, /story\.txt|edits\[/);
			return true;
		},
	);
});

test("LF oldText matches CRLF file content and preserves the original line endings", async () => {
	const file = await writeTempFile("pi-edit-engine-crlf-", "win.txt", 'alpha\r\nbeta\r\nomega\r\n');

	const result = await executeFileEdits(file, [{ oldText: 'alpha\nbeta\n', newText: 'alpha\ngamma\n' }]);

	assert.equal(await fs.promises.readFile(file, "utf-8"), 'alpha\r\ngamma\r\nomega\r\n');
});

test("duplicate matches report their count and recovery", () => {
	assert.throws(
		() => applyEditsToNormalizedContent('aaaa', [{ oldText: 'aaa', newText: 'bbb' }]),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, 'DUPLICATE_MATCH');
			assert.equal(
				error.message,
				"oldText matched 2 locations. Add more lines or set replaceAll: true",
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
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, 'DUPLICATE_MATCH');
			assert.equal(
				error.message,
				"oldText matched 2 locations. Add more lines or set replaceAll: true",
			);
			return true;
		},
	);
});

test("permission errors omit the known path and name the required access", async () => {
	const error = new Error("Permission denied");
	error.code = "EACCES";

	await assert.rejects(
		() => executeFileEdits(
			"/tmp/locked.txt",
			[{ oldText: 'hello', newText: 'world' }],
			undefined,
			{
				access: async () => {
					throw error;
				},
				readFile: async () => 'hello\n',
				writeFile: async () => {},
			},
		),
		(error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "File must be readable and writable. Check permissions.");
			return true;
		},
	);
});

test("missing file diagnostics omit the known path", async () => {
	const error = new Error("Missing file");
	error.code = "ENOENT";

	await assert.rejects(
		() => executeFileEdits(
			"/tmp/missing.txt",
			[{ oldText: "hello", newText: "world" }],
			undefined,
			{
				stat: async () => ({ size: 0 }),
				access: async () => {
					throw error;
				},
				readFile: async () => "hello\n",
				writeFile: async () => {},
			},
		),
		(failure) => {
			assert.ok(failure instanceof Error);
			assert.equal(failure.message, "File not found.");
			return true;
		},
	);
});

test("identical replacement fails closed as a structured no-change edit error", async () => {
	const file = await writeTempFile("pi-edit-no-change-", "target.ts", "const answer = 42;\n");

	await assert.rejects(
		() => executeFileEdits(
			file,
			[{ oldText: "const answer = 42;", newText: "const answer = 42;" }],
		),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, "NO_CHANGE");
			assert.equal(error.message, "Replacement is identical; the patch may already be applied.");
			return true;
		},
	);

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
