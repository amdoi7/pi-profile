import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import { degradeToUnlocated, displayDiffFromLines, generateFinalDiff, isChangeStats, isDisplayDiff } from "./final-diff.ts";

test("change stats validator enforces the generated stats invariant", () => {
	assert.equal(isChangeStats({ additions: 2, deletions: 1, changedLines: 3 }), true);
	assert.equal(isChangeStats({ additions: 2, deletions: 1, changedLines: 4 }), false);
	assert.equal(isChangeStats({ additions: Number.NaN, deletions: 1, changedLines: 1 }), false);
	assert.equal(isChangeStats({ additions: -1, deletions: 1, changedLines: 0 }), false);
});

test("intent lines remain structured when absolute coordinates are unavailable", () => {
	const display = displayDiffFromLines([
		{ prefix: "-", text: "before" },
		{ prefix: "+", text: "after" },
	]);

	assert.deepEqual(display.rows.map((row) => row.highlights), [
		[{ start: 0, end: 6 }],
		[{ start: 0, end: 5 }],
	]);
});

test("word refinement maps one N:M changed block back to per-line ranges", () => {
	const diff = generateFinalDiff(
		"const first = oldValue;\nconst second = keep;\n",
		"const first = newValue;\nconst renamed = keep;\n",
		0,
	);

	assert.deepEqual(diff.display.rows, [
		{ kind: "remove", oldLine: 1, content: "const first = oldValue;", highlights: [{ start: 14, end: 22 }] },
		{ kind: "add", newLine: 1, content: "const first = newValue;", highlights: [{ start: 14, end: 22 }] },
		{ kind: "remove", oldLine: 2, content: "const second = keep;", highlights: [{ start: 6, end: 12 }] },
		{ kind: "add", newLine: 2, content: "const renamed = keep;", highlights: [{ start: 6, end: 13 }] },
	]);
});

test("similar changed lines pair up adjacent with word highlights", () => {
	const diff = generateFinalDiff(
		"alpha\nbeta\nfrom collections.abc import Callable\n",
		"alpha\nbeta\nimport asyncio\nimport json\nfrom collections.abc import AsyncIterator, Callable\n",
		0,
	);

	assert.deepEqual(diff.display.rows, [
		{ kind: "fold", omittedLines: 2 },
		{ kind: "add", newLine: 3, content: "import asyncio", highlights: [{ start: 0, end: 14 }] },
		{ kind: "add", newLine: 4, content: "import json", highlights: [{ start: 0, end: 11 }] },
		{ kind: "remove", oldLine: 3, content: "from collections.abc import Callable", highlights: [] },
		{ kind: "add", newLine: 5, content: "from collections.abc import AsyncIterator, Callable", highlights: [{ start: 28, end: 42 }] },
	]);
});

test("unpaired deletions stay in old order around paired rows", () => {
	const diff = generateFinalDiff(
		"const dead = 1;\nconst keep = 2;\nconst tail = 3;\n",
		"const keep = 4;\nconst tail = 3;\n",
		0,
	);

	assert.deepEqual(diff.display.rows, [
		{ kind: "remove", oldLine: 1, content: "const dead = 1;", highlights: [{ start: 0, end: 15 }] },
		{ kind: "remove", oldLine: 2, content: "const keep = 2;", highlights: [{ start: 13, end: 14 }] },
		{ kind: "add", newLine: 1, content: "const keep = 4;", highlights: [{ start: 13, end: 14 }] },
		{ kind: "fold", omittedLines: 1 },
	]);
});

test("dissimilar changed lines keep unified order with whole-line highlights", () => {
	const diff = generateFinalDiff(
		"alpha\nold line\nomega\n",
		"alpha\nbrand new\nomega\n",
		0,
	);

	assert.deepEqual(diff.display.rows.slice(1, 3), [
		{ kind: "remove", oldLine: 2, content: "old line", highlights: [{ start: 0, end: 8 }] },
		{ kind: "add", newLine: 2, content: "brand new", highlights: [{ start: 0, end: 9 }] },
	]);
});

test("word refinement strips surrounding whitespace from highlights", () => {
	const whitespaceOnly = displayDiffFromLines([
		{ prefix: "-", text: "a b" },
		{ prefix: "+", text: "a  b" },
	]);
	assert.deepEqual(whitespaceOnly.rows.map((row) => row.highlights), [[], []]);

	const inserted = displayDiffFromLines([
		{ prefix: "+", text: "  provider?: string;  " },
	]);
	assert.deepEqual(inserted.rows[0].highlights, [{ start: 2, end: 20 }]);
});

test("word refinement degrades to line highlighting beyond Pi output limits", () => {
	const oversizedText = "x".repeat(DEFAULT_MAX_BYTES + 1);
	const oversizedBytes = displayDiffFromLines([
		{ prefix: "-", text: oversizedText },
		{ prefix: "+", text: "y" },
	]);
	assert.deepEqual(oversizedBytes.rows.map((row) => row.highlights), [[], []]);

	const oversizedLines = displayDiffFromLines(Array.from(
		{ length: DEFAULT_MAX_LINES + 1 },
		(_, index) => ({ prefix: "-", text: `line ${index}` }),
	));
	assert.ok(oversizedLines.rows.every((row) => row.highlights.length === 0));
});

test("display diff validator requires bounded non-overlapping highlights", () => {
	const base = { kind: "remove", oldLine: 1, content: "abc" };
	assert.equal(isDisplayDiff({ lineNumberWidth: 1, rows: [{ ...base, highlights: [{ start: 1, end: 3 }] }] }), true);
	assert.equal(isDisplayDiff({ lineNumberWidth: 1, rows: [{ ...base, highlights: [{ start: 1, end: 4 }] }] }), false);
	assert.equal(isDisplayDiff({ lineNumberWidth: 1, rows: [{ ...base, highlights: [{ start: 1, end: 2 }, { start: 1, end: 3 }] }] }), false);
	assert.equal(isDisplayDiff({ lineNumberWidth: 1, rows: [base] }), false);
});

test("display diff keeps distinct old and new line numbers after an insertion", () => {
	const oldContent = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n") + "\n";
	const newContent = oldContent.replace("line2\n", "inserted-a\ninserted-b\nline2\n");

	const diff = generateFinalDiff(oldContent, newContent, 1);

	assert.deepEqual(diff.display.rows.slice(0, 4), [
		{ kind: "context", oldLine: 1, newLine: 1, content: "line1" },
		{ kind: "add", newLine: 2, content: "inserted-a", highlights: [{ start: 0, end: 10 }] },
		{ kind: "add", newLine: 3, content: "inserted-b", highlights: [{ start: 0, end: 10 }] },
		{ kind: "context", oldLine: 2, newLine: 4, content: "line2" },
	]);
	assert.deepEqual(diff.display.rows.at(-1), { kind: "fold", omittedLines: 8 });
});

test("display diff keeps source blank lines and source ellipses as context rows", () => {
	const oldContent = "alpha\n\n...\nomega\n";
	const newContent = "alpha\n\ninserted\n...\nomega\n";

	const diff = generateFinalDiff(oldContent, newContent, 3);

	assert.ok(diff.display.rows.some((row) =>
		row.kind === "context" && row.oldLine === 2 && row.newLine === 2 && row.content === ""));
	assert.ok(diff.display.rows.some((row) =>
		row.kind === "context" && row.oldLine === 3 && row.newLine === 4 && row.content === "..."));
	assert.equal(diff.display.rows.some((row) => row.kind === "fold"), false);
});

test("display diff advances only the old coordinate across deletions", () => {
	const diff = generateFinalDiff("a\nx\ny\nb\nc\n", "a\nb\nc\n", 1);

	assert.deepEqual(diff.display.rows, [
		{ kind: "context", oldLine: 1, newLine: 1, content: "a" },
		{ kind: "remove", oldLine: 2, content: "x", highlights: [{ start: 0, end: 1 }] },
		{ kind: "remove", oldLine: 3, content: "y", highlights: [{ start: 0, end: 1 }] },
		{ kind: "context", oldLine: 4, newLine: 2, content: "b" },
		{ kind: "fold", omittedLines: 1 },
	]);
});

test("display diff represents empty added lines and EOF annotations", () => {
	const added = generateFinalDiff("", "alpha\n\n", 1);
	assert.deepEqual(added.display.rows, [
		{ kind: "add", newLine: 1, content: "alpha", highlights: [{ start: 0, end: 5 }] },
		{ kind: "add", newLine: 2, content: "", highlights: [] },
	]);

	const noFinalNewline = generateFinalDiff("alpha\nbeta", "alpha\ngamma", 1);
	assert.deepEqual(noFinalNewline.display.rows.slice(-4), [
		{ kind: "remove", oldLine: 2, content: "beta", highlights: [{ start: 0, end: 4 }] },
		{ kind: "annotation", side: "old", content: "No newline at end of file" },
		{ kind: "add", newLine: 2, content: "gamma", highlights: [{ start: 0, end: 5 }] },
		{ kind: "annotation", side: "new", content: "No newline at end of file" },
	]);
});

test("display diff retains change semantics when the first output line exceeds Pi limits", () => {
	const diff = generateFinalDiff("x".repeat(DEFAULT_MAX_BYTES + 1), "y", 1);

	assert.equal(diff.truncated, true);
	assert.deepEqual(diff.display.rows, []);
	assert.deepEqual(diff.stats, { additions: 1, deletions: 1, changedLines: 2 });
});

// --- degraded path: jsdiff timeout fallback ---

function replacementLines(count, prefixLines = 0, suffixLines = 0) {
	const oldLines = [];
	for (let i = 0; i < prefixLines; i += 1) oldLines.push(`keep before ${i}`);
	for (let i = 0; i < count; i += 1) oldLines.push(`const a${i} = ${i};`);
	for (let i = 0; i < suffixLines; i += 1) oldLines.push(`keep after ${i}`);
	const newLines = oldLines.map((line, i) =>
		line.startsWith("keep") ? line : line.replace(`a${i - prefixLines}`, `b${i - prefixLines}`).replace(`= ${i - prefixLines}`, `= ${(i - prefixLines) * 2}`),
	);
	return { oldLines, newLines };
}

test("degraded path strips common prefix and suffix and keeps stats exact", () => {
	const { oldLines, newLines } = replacementLines(10, 5, 7);
	const { rows, stats } = degradeToUnlocated(oldLines.join("\n"), newLines.join("\n"));

	assert.deepEqual(stats, { additions: 10, deletions: 10, changedLines: 20 });
	assert.equal(rows.length, 20);
	assert.ok(rows.every((row) => !row.content.startsWith("keep")), "untouched rows are stripped");
	assert.deepEqual(rows.slice(0, 10).map((row) => [row.kind, row.operation]), [
		["unlocated", "remove"], ["unlocated", "remove"], ["unlocated", "remove"], ["unlocated", "remove"], ["unlocated", "remove"],
		["unlocated", "remove"], ["unlocated", "remove"], ["unlocated", "remove"], ["unlocated", "remove"], ["unlocated", "remove"],
	]);
	assert.deepEqual(rows.slice(10).map((row) => row.operation), Array(10).fill("add"));
});

test("degraded path reports pure deletion and pure insertion stats", () => {
	const base = Array.from({ length: 300 }, (_, i) => `line ${i}`);
	const deleted = degradeToUnlocated(base.join("\n"), base.slice(0, 250).join("\n"));
	assert.deepEqual(deleted.stats, { additions: 0, deletions: 50, changedLines: 50 });
	assert.equal(deleted.rows.length, 50);

	const inserted = degradeToUnlocated(
		base.join("\n"),
		[...base, ...Array.from({ length: 40 }, (_, i) => `new ${i}`)].join("\n"),
	);
	assert.deepEqual(inserted.stats, { additions: 40, deletions: 0, changedLines: 40 });
	assert.equal(inserted.rows.length, 40);
});

test("degraded path handles single-line middle deletion without word highlights", () => {
	const { rows, stats } = degradeToUnlocated("a\nb\nc\n", "a\nc\n");

	assert.deepEqual(stats, { additions: 0, deletions: 1, changedLines: 1 });
	assert.deepEqual(rows.map((row) => [row.kind, row.operation, row.content]), [
		["unlocated", "remove", "b"],
	]);
	assert.deepEqual(rows[0].highlights, [], "word refinement is skipped on the degraded path");
});

test("degraded path handles identical inputs as an empty diff", () => {
	const { rows, stats } = degradeToUnlocated("a\nb\nc\n", "a\nb\nc\n");

	assert.deepEqual(stats, { additions: 0, deletions: 0, changedLines: 0 });
	assert.deepEqual(rows, []);
});

test("timeout degrades whole-file replacement to unlocated rows with exact stats", () => {
	const { oldLines, newLines } = replacementLines(1000);
	const diff = generateFinalDiff(oldLines.join("\n"), newLines.join("\n"), 4, { timeoutMs: 1 });

	assert.equal(diff.degraded, true);
	assert.equal(diff.firstChangedLine, undefined);
	assert.deepEqual(diff.stats, { additions: 1000, deletions: 1000, changedLines: 2000 });
	assert.ok(diff.display.rows.every((row) => row.kind === "unlocated"));
	assert.ok(diff.display.rows.every((row) => row.highlights.length === 0));
	assert.ok(diff.display.rows.length <= DEFAULT_MAX_LINES, "truncation caps the output");
});

test("default timeout degrades a 5000-line full replacement", () => {
	const { oldLines, newLines } = replacementLines(5000);
	const diff = generateFinalDiff(oldLines.join("\n"), newLines.join("\n"));

	assert.deepEqual(diff.stats, { additions: 5000, deletions: 5000, changedLines: 10000 });
	if (process.env.PI_DIFF_ENGINE !== "js") {
		// Rust engine (auto or forced) completes within the 250ms budget, so it
		// yields a located diff instead of degrading (better behavior, same stats).
		assert.equal(diff.degraded, false);
		assert.ok(diff.display.rows.some((row) => row.kind === "remove"));
	} else {
		assert.equal(diff.degraded, true);
	}
});

test("small diffs are never degraded by a tiny timeout", () => {
	const diff = generateFinalDiff("const first = oldValue;\nconst second = keep;\n", "const first = newValue;\nconst second = keep;\n", 0, { timeoutMs: 1 });

	assert.equal(diff.degraded, false);
	assert.deepEqual(diff.display.rows[0], {
		kind: "remove",
		oldLine: 1,
		content: "const first = oldValue;",
		highlights: [{ start: 14, end: 22 }],
	});
});
