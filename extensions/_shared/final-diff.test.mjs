import { test } from "vitest";
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

	// 对称全配对块（2:2 全部配对）= 整块替换，保持 unified 块形态（- 全部在前 + 全部在后），
	// 不逐行交错；词级高亮仍按配对映射回每行。
	assert.deepEqual(diff.display.rows, [
		{ kind: "remove", oldLine: 1, content: "const first = oldValue;", highlights: [{ start: 14, end: 22 }] },
		{ kind: "remove", oldLine: 2, content: "const second = keep;", highlights: [{ start: 6, end: 12 }] },
		{ kind: "add", newLine: 1, content: "const first = newValue;", highlights: [{ start: 14, end: 22 }] },
		{ kind: "add", newLine: 2, content: "const renamed = keep;", highlights: [{ start: 6, end: 13 }] },
	]);
});

test("symmetric fully-paired reindent block keeps unified scope order", () => {
	const diff = generateFinalDiff(
		"      }).catch((error) => {\n          // keep comment\n          return run();\n      });\n",
		"         .catch((error) => {\n             // keep comment\n             return run();\n         });\n",
		0,
	);

	// 整块缩进变化：所有行配对但差异仅为空白，展示为整块替换（scope 粒度），
	// 不逐行 -+ 交错；空白差异 trim 后无词级高亮（首行 `}).` → `.` 是实质变化，保留高亮）。
	assert.deepEqual(diff.display.rows, [
		{ kind: "remove", oldLine: 1, content: "      }).catch((error) => {", highlights: [{ start: 6, end: 8 }] },
		{ kind: "remove", oldLine: 2, content: "          // keep comment", highlights: [] },
		{ kind: "remove", oldLine: 3, content: "          return run();", highlights: [] },
		{ kind: "remove", oldLine: 4, content: "      });", highlights: [] },
		{ kind: "add", newLine: 1, content: "         .catch((error) => {", highlights: [] },
		{ kind: "add", newLine: 2, content: "             // keep comment", highlights: [] },
		{ kind: "add", newLine: 3, content: "             return run();", highlights: [] },
		{ kind: "add", newLine: 4, content: "         });", highlights: [] },
	]);
});

test("changed lines keep unified order with word highlights on paired rows", () => {
	const diff = generateFinalDiff(
		"alpha\nbeta\nfrom collections.abc import Callable\n",
		"alpha\nbeta\nimport asyncio\nimport json\nfrom collections.abc import AsyncIterator, Callable\n",
		0,
	);

	// Zed/VS Code 同款：unified 块形态（- 全部在前 + 全部在后，不重排），
	// 配对仅用于词级高亮；未配对行整行高亮。
	assert.deepEqual(diff.display.rows, [
		{ kind: "fold", omittedLines: 2 },
		{ kind: "remove", oldLine: 3, content: "from collections.abc import Callable", highlights: [] },
		{ kind: "add", newLine: 3, content: "import asyncio", highlights: [{ start: 0, end: 14 }] },
		{ kind: "add", newLine: 4, content: "import json", highlights: [{ start: 0, end: 11 }] },
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

test("whole-file replacement is resolved by the no-shared-lines fast path", () => {
	const { oldLines, newLines } = replacementLines(1000);
	// 无共享行 fast path：O(N) 定位，即使 timeout 极小也不退化。
	const diff = generateFinalDiff(oldLines.join("\n") + "\n", newLines.join("\n") + "\n", 4, { timeoutMs: 1 });

	assert.equal(diff.degraded, false);
	assert.equal(diff.firstChangedLine, 1);
	assert.deepEqual(diff.stats, { additions: 1000, deletions: 1000, changedLines: 2000 });
	assert.ok(diff.display.rows.every((row) => row.kind === "remove" || row.kind === "add"));
	assert.ok(diff.display.rows.length <= DEFAULT_MAX_LINES, "truncation caps the output");
});

test("mid-file replacement is resolved by the core-segment fast path", () => {
	// 前一半相同（有共享行）：公共前后缀剥离后，核心段（后半 500 行）无共享行 →
	// O(N) fast path 直接构造带偏移的整段替换 hunk，不跑 Myers，不退化。
	const oldLines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
	const newLines = oldLines.map((line, i) => (i < 500 ? line : `${line} changed`));
	const diff = generateFinalDiff(oldLines.join("\n") + "\n", newLines.join("\n") + "\n", 4, { timeoutMs: 1 });

	assert.equal(diff.degraded, false);
	assert.equal(diff.firstChangedLine, 501);
	assert.deepEqual(diff.stats, { additions: 500, deletions: 500, changedLines: 1000 });
	assert.ok(diff.display.rows.some((row) => row.kind === "remove"));
	assert.ok(diff.display.rows.some((row) => row.kind === "add"));
	assert.ok(diff.display.rows.every((row) => row.kind !== "unlocated"));
	assert.ok(diff.display.rows.length <= DEFAULT_MAX_LINES, "truncation caps the output");
});

test("default timeout resolves a 5000-line full replacement via fast path", () => {
	const { oldLines, newLines } = replacementLines(5000);
	const diff = generateFinalDiff(oldLines.join("\n"), newLines.join("\n"));

	assert.deepEqual(diff.stats, { additions: 5000, deletions: 5000, changedLines: 10000 });
	assert.equal(diff.degraded, false);
	assert.ok(diff.display.rows.some((row) => row.kind === "remove"));
	assert.ok(diff.truncated, "presentation rows are capped at Pi output limits");
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

test("word refinement budget counts characters, not whitespace-separated tokens", () => {
	// 单个 \S+ token 但上千 jsdiff word token 的行（minified/长字面量形态）：
	// 预算若按 \S+ 计数会漏放，Myers 词级 diff 无超时爆炸（worker 5s watchdog →
	// 主线程同步 fallback 卡死 TUI）。字符数是 token 数的上界，超预算必须跳过细化。
	const packedLine = (tag) =>
		`const m={${Array.from({ length: 160 }, (_, i) => `k${i}:${tag}${i}`).join(",")}};`.padEnd(1600, ";");
	const diff = generateFinalDiff(`${packedLine("a")}\n`, `${packedLine("b")}\n`, 0);

	assert.equal(diff.degraded, false);
	// 预算跳过的既有约定（同 block 级 DEFAULT_MAX_BYTES 跳过）：不计算词级高亮，行保持无 range。
	for (const row of diff.display.rows) {
		assert.deepEqual(row.highlights, [], "over-budget pair skips word refinement");
	}
});

test("word refinement still runs on normal-length low-whitespace lines", () => {
	const packedLine = (tag) => `const m={${Array.from({ length: 16 }, (_, i) => `k${i}:${tag}${i}`).join(",")}};`;
	const diff = generateFinalDiff(`${packedLine("a")}\n`, `${packedLine("b")}\n`, 0);

	const removeRow = diff.display.rows.find((row) => row.kind === "remove");
	assert.ok(removeRow.highlights.length >= 1, "refinement produced word-level highlights");
	const spanned = removeRow.highlights.reduce((sum, range) => sum + range.end - range.start, 0);
	assert.ok(spanned < removeRow.content.length, "highlights are narrower than the whole row");
});
