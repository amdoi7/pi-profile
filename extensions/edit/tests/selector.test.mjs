import { test } from "vitest";
import assert from "node:assert/strict";

import { applyOpToNormalizedContent } from "../match.ts";

// 声明式选择器模型:replace 默认 = 全部替换(如 str.replace),位置/数量用选择器表达。
// 单一 match 原语：replace 默认全部命中，选择器收窄。

test("replace defaults to replacing all matches (str.replace semantics)", () => {
	const result = applyOpToNormalizedContent(
		"a a a",
		{ match: "a", new_str: "b" },
	);
	assert.equal(result.newContent, "b b b");
});

test("delete defaults to removing all matches", () => {
	const result = applyOpToNormalizedContent(
		"a a a",
		{ match: "a" },
	);
	assert.equal(result.newContent, "  ");
});

test("occurrence picks the Nth match", () => {
	const result = applyOpToNormalizedContent(
		"import a\nimport b\nimport c\n",
		{ match: "import", occurrence: 2, new_str: "IMPORT" },
	);
	assert.equal(result.newContent, "import a\nIMPORT b\nimport c\n");
});

test("occurrence beyond the match count fails with a concrete error", () => {
	assert.throws(
		() => applyOpToNormalizedContent("a a a", { match: "a", occurrence: 5, new_str: "b" }),
		/occurrence 5 exceeds 3 matches/,
	);
});

test("limit replaces the first M matches, leaving the rest", () => {
	const result = applyOpToNormalizedContent(
		"x x x x",
		{ match: "x", limit: 2, new_str: "y" },
	);
	assert.equal(result.newContent, "y y x x");
});

test("after constrains matching to text following the anchor", () => {
	const content = "class A:\n    foo = 1\nclass B:\n    foo = 2\n";
	const result = applyOpToNormalizedContent(
		content,
		{ match: "foo", after: "class B", new_str: "bar" },
	);
	assert.equal(result.newContent, "class A:\n    foo = 1\nclass B:\n    bar = 2\n");
});

test("after with a missing anchor fails with a concrete error", () => {
	assert.throws(
		() => applyOpToNormalizedContent("foo foo", { match: "foo", after: "nope", new_str: "bar" }),
		/after anchor "nope" not found/,
	);
});

test("before constrains matching to text preceding the anchor", () => {
	const content = "class A:\n    foo = 1\nclass B:\n    foo = 2\n";
	const result = applyOpToNormalizedContent(
		content,
		{ match: "foo", before: "class B", new_str: "bar" },
	);
	assert.equal(result.newContent, "class A:\n    bar = 1\nclass B:\n    foo = 2\n");
});

test("regex treats match as a pattern", () => {
	const result = applyOpToNormalizedContent(
		"v1 = 1\nv2 = 2\nv3 = 3\n",
		{ match: "v\\d", regex: true, new_str: "x" },
	);
	assert.equal(result.newContent, "x = 1\nx = 2\nx = 3\n");
});

test("regex + occurrence picks the Nth pattern match", () => {
	const result = applyOpToNormalizedContent(
		"a1 b2 c3",
		{ match: "[a-c]\\d", regex: true, occurrence: 2, new_str: "X" },
	);
	assert.equal(result.newContent, "a1 X c3");
});

test("occurrence + limit combined is rejected as ambiguous", () => {
	assert.throws(
		() => applyOpToNormalizedContent("a a a", { match: "a", occurrence: 2, limit: 2, new_str: "b" }),
		/occurrence and limit are mutually exclusive/,
	);
});

test("delete supports selectors too", () => {
	const result = applyOpToNormalizedContent(
		"keep\ndrop\ndrop\nkeep\n",
		{ match: "drop", occurrence: 2 },
	);
	assert.equal(result.newContent, "keep\ndrop\n\nkeep\n");
});
