import { test } from "vitest";
import assert from "node:assert/strict";

import { generateFinalDiff, serializeDisplayDiff } from "../../_shared/final-diff.ts";
import { applyOpToNormalizedContent } from "../match.ts";
import { diffFromSpans } from "../span-diff.ts";

const CONTEXT = 4;

/**
 * 等价性是这个模块的正确性判据：用已知 span 构造的展示 diff 必须与
 * 「把整个文件交给通用 diff」逐字节同构（行号、fold、词级高亮、stats）。
 */
function assertSameAsWholeFileDiff(oldContent, op, label) {
	const { newContent, matchedSpans } = applyOpToNormalizedContent(oldContent, op);
	const whole = generateFinalDiff(oldContent, newContent, CONTEXT);
	const spanBased = diffFromSpans(oldContent, newContent, matchedSpans, CONTEXT);

	assert.equal(serializeDisplayDiff(spanBased.display), serializeDisplayDiff(whole.display), `display differs: ${label}`);
	assert.deepEqual(spanBased.stats, whole.stats, `stats differ: ${label}`);
	assert.equal(spanBased.firstChangedLine, whole.firstChangedLine, `firstChangedLine differs: ${label}`);
	assert.equal(spanBased.truncated, whole.truncated, `truncated differs: ${label}`);
	assert.deepEqual(
		spanBased.display.rows.flatMap((row) => row.highlights ?? []),
		whole.display.rows.flatMap((row) => row.highlights ?? []),
		`word highlights differ: ${label}`,
	);
	return spanBased;
}

function numbered(lines, { trailingNewline = true } = {}) {
	const body = Array.from({ length: lines }, (_, i) => `const value${i} = ${i}; // padding`).join("\n");
	return trailingNewline ? `${body}\n` : body;
}

test("single replace in the middle of a file matches the whole-file diff", () => {
	assertSameAsWholeFileDiff(
		numbered(100),
		{ op: "replace", old_str: "const value50 = 50; // padding", new_str: "const value50 = 500; // padded" },
		"middle replace",
	);
});

test("replace at the very first line has no leading fold", () => {
	const spanBased = assertSameAsWholeFileDiff(
		numbered(40),
		{ op: "replace", old_str: "const value0 = 0; // padding", new_str: "const value0 = 1; // padding" },
		"first line",
	);
	assert.doesNotMatch(serializeDisplayDiff(spanBased.display).split("\n")[0], /omitted/);
});

test("replace at EOF without a trailing newline keeps the annotation row", () => {
	assertSameAsWholeFileDiff(
		numbered(30, { trailingNewline: false }),
		{ op: "replace", old_str: "const value29 = 29; // padding", new_str: "const value29 = 30; // padded" },
		"eof no newline",
	);
});

test("multi-line replacement inside a block matches the whole-file diff", () => {
	const oldContent = [
		"import (",
		'    "bytes"',
		'    "encoding/json"',
		'    "io"',
		")",
		"",
		"func main() {}",
		"",
	].join("\n");
	const spanBased = assertSameAsWholeFileDiff(
		oldContent,
		{
			op: "replace",
			old_str: 'import (\n    "bytes"\n    "encoding/json"\n    "io"\n)',
			new_str: 'import (\n    "bytes"\n    "context"\n    "encoding/json"\n    "io"\n)',
		},
		"block replacement",
	);
	assert.deepEqual(spanBased.stats, { additions: 1, deletions: 0, changedLines: 1 });
});

test("insert after line 21 matches the whole-file diff", () => {
	const spanBased = assertSameAsWholeFileDiff(
		numbered(50),
		{ op: "insert", insert_line: 21, new_str: "const inserted = 1;\n" },
		"insert after line 21",
	);
	assert.deepEqual(spanBased.stats, { additions: 1, deletions: 0, changedLines: 1 });
});

test("insert at the file top places the text as the first line", () => {
	const oldContent = "module.exports = {\n  name: 'old',\n};\n";
	const { newContent, matchedSpans } = applyOpToNormalizedContent(
		oldContent,
		{ op: "insert", insert_line: 0, new_str: "/* generated */\n" },
	);
	assert.equal(newContent, "/* generated */\nmodule.exports = {\n  name: 'old',\n};\n");
	assert.equal(matchedSpans.length, 1);
});

test("insert after the last line appends without a blank line", () => {
	const oldContent = "const list = [1, 2];\n";
	const { newContent } = applyOpToNormalizedContent(
		oldContent,
		{ op: "insert", insert_line: 1, new_str: "const extra = 3;\n" },
	);
	assert.equal(newContent, "const list = [1, 2];\nconst extra = 3;\n");
});

test("whole-line deletion matches the whole-file diff", () => {
	assertSameAsWholeFileDiff(
		numbered(50),
		{ op: "delete", old_str: "const value10 = 10; // padding\n" },
		"delete line",
	);
});

test("replaceAll across many lines matches the whole-file diff", () => {
	assertSameAsWholeFileDiff(
		numbered(80),
		{ op: "replaceAll", old_str: "padding", new_str: "padded" },
		"replaceAll",
	);
});

test("whole-file rewrite keeps exact stats without the Myers path", () => {
	const oldContent = numbered(2000);
	const { newContent, matchedSpans } = applyOpToNormalizedContent(
		oldContent,
		{ op: "replace", old_str: oldContent, new_str: oldContent.replace(/const/g, "let") },
	);
	const spanBased = diffFromSpans(oldContent, newContent, matchedSpans, CONTEXT);

	assert.deepEqual(spanBased.stats, { additions: 2000, deletions: 2000, changedLines: 4000 });
	assert.equal(spanBased.truncated, true, "2000-line replace exceeds the display limit");
});

test("diff cost follows the edit size, not the file size", () => {
	// 5MB 文件、末尾改一处：整文件 Myers 是 O(N·D)，span 版只碰改动窗口。
	const oldContent = numbered(80_000);
	const { newContent, matchedSpans } = applyOpToNormalizedContent(
		oldContent,
		{ op: "replace", old_str: "const value79999 = 79999; // padding", new_str: "const value79999 = 80000; // padded" },
	);

	const spanStart = performance.now();
	const spanBased = diffFromSpans(oldContent, newContent, matchedSpans, CONTEXT);
	const spanMs = performance.now() - spanStart;

	const wholeStart = performance.now();
	const whole = generateFinalDiff(oldContent, newContent, CONTEXT);
	const wholeMs = performance.now() - wholeStart;

	assert.equal(serializeDisplayDiff(spanBased.display), serializeDisplayDiff(whole.display));
	assert.ok(spanMs * 3 < wholeMs, `expected span diff to dominate: span=${spanMs.toFixed(1)}ms whole=${wholeMs.toFixed(1)}ms`);
});