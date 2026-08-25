import { test } from "vitest";
import assert from "node:assert/strict";

import { generateFinalDiff, serializeDisplayDiff } from "../_shared/final-diff.ts";
import { applyEditsToNormalizedContent } from "./edit-engine.ts";
import { diffFromSpans } from "./span-diff.ts";

const CONTEXT = 4;

/**
 * 等价性是这个模块的正确性判据：用已知 span 构造的展示 diff 必须与
 * 「把整个文件交给通用 diff」逐字节同构（行号、fold、词级高亮、stats）。
 */
function assertSameAsWholeFileDiff(oldContent, edits, label) {
	const { newContent, matchedSpans } = applyEditsToNormalizedContent(oldContent, edits);
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

test("single edit in the middle of a file matches the whole-file diff", () => {
	assertSameAsWholeFileDiff(
		numbered(100),
		[{ oldText: "const value50 = 50; // padding", newText: "const value50 = 500; // padded" }],
		"middle edit",
	);
});

test("two edits on the same line collapse into one remove/add pair", () => {
	const spanBased = assertSameAsWholeFileDiff(
		"const total = oldLeft + oldRight;\nnext();\n",
		[
			{ oldText: "oldLeft", newText: "newLeft" },
			{ oldText: "oldRight", newText: "newRight" },
		],
		"same line",
	);
	assert.equal(
		serializeDisplayDiff(spanBased.display),
		"-1   │ const total = oldLeft + oldRight;\n+  1 │ const total = newLeft + newRight;\n 2 2 │ next();",
	);
});

test("edits far apart keep separate windows with an exact fold between them", () => {
	const spanBased = assertSameAsWholeFileDiff(
		numbered(200),
		[
			{ oldText: "const value10 = 10; // padding", newText: "const value10 = 11; // padding" },
			{ oldText: "const value180 = 180; // padding", newText: "const value180 = 181; // padding" },
		],
		"far apart",
	);
	const rendered = serializeDisplayDiff(spanBased.display);
	assert.equal((rendered.match(/unchanged lines omitted/g) ?? []).length, 3, rendered);
});

test("edits within one context span merge into a single window", () => {
	const spanBased = assertSameAsWholeFileDiff(
		numbered(60),
		[
			{ oldText: "const value20 = 20; // padding", newText: "const value20 = 21; // padding" },
			{ oldText: "const value23 = 23; // padding", newText: "const value23 = 24; // padding" },
		],
		"near each other",
	);
	// 中间两行未改动 → 作为 context 出现,而不是被折叠。
	assert.match(serializeDisplayDiff(spanBased.display), / 22 22 │ const value21 = 21; \/\/ padding/);
});

test("edit at the very first line has no leading fold", () => {
	const spanBased = assertSameAsWholeFileDiff(
		numbered(40),
		[{ oldText: "const value0 = 0; // padding", newText: "const value0 = 1; // padding" }],
		"first line",
	);
	assert.doesNotMatch(serializeDisplayDiff(spanBased.display).split("\n")[0], /omitted/);
});

test("edit at EOF without a trailing newline keeps the annotation row", () => {
	assertSameAsWholeFileDiff(
		numbered(30, { trailingNewline: false }),
		[{ oldText: "const value29 = 29; // padding", newText: "const value29 = 30; // padded" }],
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
		[{
			oldText: 'import (\n    "bytes"\n    "encoding/json"\n    "io"\n)',
			newText: 'import (\n    "bytes"\n    "context"\n    "encoding/json"\n    "io"\n)',
		}],
		"block replacement",
	);
	// 块内未改动的行仍然是 context（+1 行，而不是整块删增）。
	assert.deepEqual(spanBased.stats, { additions: 1, deletions: 0, changedLines: 1 });
});

test("insertion and deletion of whole lines match the whole-file diff", () => {
	assertSameAsWholeFileDiff(
		numbered(50),
		[
			{ oldText: "const value10 = 10; // padding\n", newText: "" },
			{ oldText: "const value30 = 30; // padding\n", newText: "const value30 = 30; // padding\nconst extra = 1;\n" },
		],
		"insert and delete",
	);
});

test("replaceAll across many lines matches the whole-file diff", () => {
	assertSameAsWholeFileDiff(
		numbered(80),
		[{ oldText: "padding", newText: "padded", replaceAll: true }],
		"replaceAll",
	);
});

test("whole-file rewrite keeps exact stats without the Myers path", () => {
	const oldContent = numbered(2000);
	const { newContent, matchedSpans } = applyEditsToNormalizedContent(oldContent, [
		{ oldText: oldContent, newText: oldContent.replace(/const/g, "let") },
	]);
	const spanBased = diffFromSpans(oldContent, newContent, matchedSpans, CONTEXT);

	assert.deepEqual(spanBased.stats, { additions: 2000, deletions: 2000, changedLines: 4000 });
	assert.equal(spanBased.truncated, true, "2000-line rewrite exceeds the display limit");
});

test("diff cost follows the edit size, not the file size", () => {
	// 5MB 文件、末尾改一处：整文件 Myers 是 O(N·D)，span 版只碰改动窗口。
	const oldContent = numbered(80_000);
	const edits = [{ oldText: "const value79999 = 79999; // padding", newText: "const value79999 = 80000; // padded" }];
	const { newContent, matchedSpans } = applyEditsToNormalizedContent(oldContent, edits);

	const spanStart = performance.now();
	const spanBased = diffFromSpans(oldContent, newContent, matchedSpans, CONTEXT);
	const spanMs = performance.now() - spanStart;

	const wholeStart = performance.now();
	const whole = generateFinalDiff(oldContent, newContent, CONTEXT);
	const wholeMs = performance.now() - wholeStart;

	assert.equal(serializeDisplayDiff(spanBased.display), serializeDisplayDiff(whole.display));
	assert.ok(spanMs * 3 < wholeMs, `expected span diff to dominate: span=${spanMs.toFixed(1)}ms whole=${wholeMs.toFixed(1)}ms`);
});
