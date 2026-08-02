import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

import { displayDiffFromLines, generateFinalDiff, isChangeStats } from "./final-diff.ts";

test("change stats validator enforces the generated stats invariant", () => {
	assert.equal(isChangeStats({ additions: 2, deletions: 1, changedLines: 3 }), true);
	assert.equal(isChangeStats({ additions: 2, deletions: 1, changedLines: 4 }), false);
	assert.equal(isChangeStats({ additions: Number.NaN, deletions: 1, changedLines: 1 }), false);
	assert.equal(isChangeStats({ additions: -1, deletions: 1, changedLines: 0 }), false);
});

test("intent lines remain structured when absolute coordinates are unavailable", () => {
	assert.deepEqual(displayDiffFromLines([
		{ prefix: "-", text: "before" },
		{ prefix: "+", text: "after" },
	]), {
		lineNumberWidth: 1,
		rows: [
			{ kind: "unlocated", operation: "remove", content: "before" },
			{ kind: "unlocated", operation: "add", content: "after" },
		],
	});
});

test("display diff keeps distinct old and new line numbers after an insertion", () => {
	const oldContent = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n") + "\n";
	const newContent = oldContent.replace("line2\n", "inserted-a\ninserted-b\nline2\n");

	const diff = generateFinalDiff(oldContent, newContent, 1);

	assert.deepEqual(diff.display.rows.slice(0, 4), [
		{ kind: "context", oldLine: 1, newLine: 1, content: "line1" },
		{ kind: "add", newLine: 2, content: "inserted-a" },
		{ kind: "add", newLine: 3, content: "inserted-b" },
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
		{ kind: "remove", oldLine: 2, content: "x" },
		{ kind: "remove", oldLine: 3, content: "y" },
		{ kind: "context", oldLine: 4, newLine: 2, content: "b" },
		{ kind: "fold", omittedLines: 1 },
	]);
});

test("display diff represents empty added lines and EOF annotations", () => {
	const added = generateFinalDiff("", "alpha\n\n", 1);
	assert.deepEqual(added.display.rows, [
		{ kind: "add", newLine: 1, content: "alpha" },
		{ kind: "add", newLine: 2, content: "" },
	]);

	const noFinalNewline = generateFinalDiff("alpha\nbeta", "alpha\ngamma", 1);
	assert.deepEqual(noFinalNewline.display.rows.slice(-4), [
		{ kind: "remove", oldLine: 2, content: "beta" },
		{ kind: "annotation", side: "old", content: "No newline at end of file" },
		{ kind: "add", newLine: 2, content: "gamma" },
		{ kind: "annotation", side: "new", content: "No newline at end of file" },
	]);
});

test("display diff retains change semantics when the first output line exceeds Pi limits", () => {
	const diff = generateFinalDiff("x".repeat(DEFAULT_MAX_BYTES + 1), "y", 1);

	assert.equal(diff.truncated, true);
	assert.deepEqual(diff.display.rows, []);
	assert.deepEqual(diff.stats, { additions: 1, deletions: 1, changedLines: 2 });
});
