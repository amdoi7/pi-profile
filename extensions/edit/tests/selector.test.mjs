import { test } from "vitest";
import assert from "node:assert/strict";

import { applyEntryToNormalizedContent } from "../match.ts";

// 无选择器：match 必须在文件里唯一命中；多处命中即 DUPLICATE_MATCH——
// 收窄的唯一办法是把 match 加长到唯一。

test("replace applies to the unique match", () => {
	const result = applyEntryToNormalizedContent(
		"a b a b a: target a b a",
		{ match: "target a", new_str: "hit b" },
	);
	assert.equal(result.newContent, "a b a b a: hit b b a");
});

test("delete removes the unique match", () => {
	const result = applyEntryToNormalizedContent(
		"keep drop keep",
		{ match: "drop " },
	);
	assert.equal(result.newContent, "keep keep");
});

test("multiple matches are rejected as DUPLICATE_MATCH with line numbers", () => {
	assert.throws(
		() => applyEntryToNormalizedContent("a a a", { match: "a", new_str: "b" }),
		(error) => {
			assert.equal(error.kind, "DUPLICATE_MATCH");
			assert.match(error.message, /matched 3 locations/);
			assert.match(error.message, /use a longer or more specific match/);
			return true;
		},
	);
});

test("a longer match disambiguates repeated text", () => {
	const content = "foo = 1\nbar\nfoo = 2\n";
	const result = applyEntryToNormalizedContent(
		content,
		{ match: "bar\nfoo = 2", new_str: "bar\nfoo = 3" },
	);
	assert.equal(result.newContent, "foo = 1\nbar\nfoo = 3\n");
});

test("replace_all replaces every occurrence and reports a span per hit", () => {
	const { newContent, matchedSpans } = applyEntryToNormalizedContent(
		"const oldName = oldName + oldName;\n",
		{ match: "oldName", new_str: "newName", replace_all: true },
	);
	assert.equal(newContent, "const newName = newName + newName;\n");
	assert.equal(matchedSpans.length, 3);
});

test("replace_all delete removes every occurrence", () => {
	const result = applyEntryToNormalizedContent(
		"a, a, a",
		{ match: ", ", replace_all: true },
	);
	assert.equal(result.newContent, "aaa");
});

test("replace_all with zero hits fails as NOT_FOUND", () => {
	assert.throws(
		() => applyEntryToNormalizedContent("foo bar", { match: "nope", new_str: "x", replace_all: true }),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			return true;
		},
	);
});

test("replace_all with identical replacement fails as NO_CHANGE", () => {
	assert.throws(
		() => applyEntryToNormalizedContent("a a a", { match: "a", new_str: "a", replace_all: true }),
		(error) => {
			assert.equal(error.kind, "NO_CHANGE");
			return true;
		},
	);
});

test("multi-line match is exact, newline included", () => {
	const result = applyEntryToNormalizedContent(
		"first\nsecond\nthird\n",
		{ match: "second\nthird", new_str: "2nd\n3rd" },
	);
	assert.equal(result.newContent, "first\n2nd\n3rd\n");
});
