import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
	applyEditsToNormalizedContent,
	EditToolError,
	executeFileGroupEdits,
	generateEditPreview,
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
	const editMutation = executeFileGroupEdits(
		file,
		"target.txt",
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
		"demo.txt",
	);

	assert.equal(
		newContent,
		['title: “keep me”', 'message: “new value”', 'footer — untouched', ''].join("\n"),
	);
});

test("non-quote fuzzy mismatches fail with NOT_FOUND guidance on exact whitespace matching", async () => {
	const original = ['title: “keep me”', 'needle   ', 'footer — untouched', ''].join("\n");
	const file = await writeTempFile("pi-edit-engine-fuzzy-", "story.txt", original);

	await assert.rejects(
		() => executeFileGroupEdits(file, 'story.txt', [{ oldText: 'needle\nfooter - untouched\n', newText: 'replaced\nfooter - untouched\n' }]),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, 'NOT_FOUND');
			assert.ok(
				error.message.startsWith('NOT_FOUND the text in story.txt. oldText must match the file content exactly, including whitespace; line endings and curly quotes are normalized before matching.'),
				error.message,
			);
			assert.match(error.message, /Re-read the file and copy oldText character-for-character/);
			return true;
		},
	);
	assert.equal(await fs.promises.readFile(file, "utf-8"), original);
});

test("LF oldText matches CRLF file content and preserves the original line endings", async () => {
	const file = await writeTempFile("pi-edit-engine-crlf-", "win.txt", 'alpha\r\nbeta\r\nomega\r\n');

	const result = await executeFileGroupEdits(file, 'win.txt', [{ oldText: 'alpha\nbeta\n', newText: 'alpha\ngamma\n' }]);

	assert.match(result.summary, /updated win\.txt/);
	assert.equal(await fs.promises.readFile(file, "utf-8"), 'alpha\r\ngamma\r\nomega\r\n');
});

test("overlapping exact matches are rejected with a DUPLICATE_MATCH error prefix", () => {
	assert.throws(
		() => applyEditsToNormalizedContent('aaaa', [{ oldText: 'aaa', newText: 'bbb' }], 'demo.txt'),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, 'DUPLICATE_MATCH');
			assert.match(error.message, /DUPLICATE_MATCH .*\(2 occurrences\)/);
			return true;
		},
	);
});

test("exact unique match wins over fuzzy-equivalent quote variants elsewhere", () => {
	const { newContent } = applyEditsToNormalizedContent(
		'x: “v”\nx: "v"\n',
		[{ oldText: 'x: “v”\n', newText: 'x: “w”\n' }],
		'demo.txt',
	);

	assert.equal(newContent, 'x: “w”\nx: "v"\n');
});

test("explicit expectedOccurrences replaces every exact occurrence", () => {
	const { newContent, matchedSpans } = applyEditsToNormalizedContent(
		'const oldName = oldName + oldName;\n',
		[{ oldText: 'oldName', newText: 'newName', expectedOccurrences: 3 }],
		'demo.ts',
	);

	assert.equal(newContent, 'const newName = newName + newName;\n');
	assert.equal(matchedSpans.length, 3);
});

test("explicit expectedOccurrences replaces all when the actual count differs", () => {
	// expectedOccurrences is a declaration of intent ("replace all"), not a
	// constraint: fewer actual matches still replace everything found.
	const { newContent, matchedSpans } = applyEditsToNormalizedContent(
		'const oldName = oldName;\n',
		[{ oldText: 'oldName', newText: 'newName', expectedOccurrences: 3 }],
		'demo.ts',
	);

	assert.equal(newContent, 'const newName = newName;\n');
	assert.equal(matchedSpans.length, 2);
});

test("implicit single occurrence keeps duplicate-match guidance", () => {
	assert.throws(
		() => applyEditsToNormalizedContent(
			'const oldName = oldName;\n',
			[{ oldText: 'oldName', newText: 'newName' }],
			'demo.ts',
		),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, 'DUPLICATE_MATCH');
			assert.match(error.message, /oldText is not unique/);
			return true;
		},
	);
});

test("access errors are surfaced instead of being mislabeled as file not found", async () => {
	const error = new Error("Permission denied");
	error.code = "EACCES";

	await assert.rejects(
		() => executeFileGroupEdits(
			"/tmp/locked.txt",
			"locked.txt",
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
		/Permission denied/,
	);
});

test("identical replacement fails closed as a structured no-change edit error", async () => {
	const file = await writeTempFile("pi-edit-no-change-", "target.ts", "const answer = 42;\n");

	await assert.rejects(
		() => executeFileGroupEdits(
			file,
			"target.ts",
			[{ oldText: "const answer = 42;", newText: "const answer = 42;" }],
		),
		(error) => {
			assert.ok(error instanceof EditToolError);
			assert.equal(error.kind, "NO_CHANGE");
			assert.match(error.message, /No changes made/);
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
		"sample.ts",
	);

	const preview = generateEditPreview(oldContent, newContent);

	assert.equal(
		preview.previewText,
		"-1 const total = oldLeft + oldRight;\n+1 const total = newLeft + newRight;\n 2 next();",
	);
	assert.equal(preview.previewStartLine, 1);
	assert.deepEqual(preview.changeStats, { additions: 1, deletions: 1, changedLines: 2 });
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
		"sample.go",
	);
	const preview = generateEditPreview(oldContent, newContent);

	assert.match(preview.previewText, /"bytes"/);
	assert.match(preview.previewText, /"context"/);
	assert.match(preview.previewText, /^\+ 5/m);
	assert.doesNotMatch(preview.previewText, /^- 4/m);
	assert.ok((preview.previewStartLine ?? 0) > 0);
});
