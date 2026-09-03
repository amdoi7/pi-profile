/**
 * NOT_FOUND 的载荷契约:把文件里真实的那几行原样带回。
 *
 * 语料:913 次 NOT_FOUND 里 70% 的下一步是重读同一个文件,15% 是原样重试——
 * 工具手里就有那段字节,失败响应必须自带权威原文,而不是更好的措辞。
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { applyOpToNormalizedContent } from "../match.ts";

function failureOf(content, op) {
	try {
		applyOpToNormalizedContent(content, op);
	} catch (error) {
		return error;
	}
	throw new Error("expected the edit to fail");
}

const replace = (oldStr, newStr) => ({ op: "replace", old_str: oldStr, new_str: newStr });

test("the file's real lines come back verbatim with their line numbers", () => {
	const content = [
		"# 标题",
		"",
		"维护面,需要时再拆。",
		"",
		"**默认假设**:产品先行,包纪律保持。",
		"",
	].join("\n");
	const old_str = "维护面,需要时再拆。\n\n## 一、分层与依赖法则";

	const error = failureOf(content, replace(old_str, "x"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /^old_str was not found;/);
	assert.match(error.message, /3\|维护面,需要时再拆。/);
	assert.match(error.message, /5\|\*\*默认假设\*\*:产品先行,包纪律保持。/);
	assert.match(error.message, /L\d+/);
});

test("the reported column counts codepoints, not UTF-16 units", () => {
	const content = ["定位基准🌟A", ""].join("\n");
	const error = failureOf(content, replace("定位基准🌟B", "x"));

	assert.match(error.message, /L1 col 6:/);
	assert.match(error.message, /file "A" U\+0041 ≠ old_str "B" U\+0042/);
});

test("a rewritten line comes back as the file has it", () => {
	const content = [
		"function total(items) {",
		"  const sum = items.reduce((a, b) => a + b, 0);",
		"  return sum;",
		"}",
		"",
	].join("\n");
	const old_str = "  const sum = items.reduce((acc, item) => acc + item, 0);\n  return sum;";

	const error = failureOf(content, replace(old_str, "x"));

	assert.match(error.message, /2\|  const sum = items\.reduce\(\(a, b\) => a \+ b, 0\);/);
	assert.match(error.message, /3\|  return sum;/);
	assert.match(error.message, /L2 col \d+/);
	assert.doesNotMatch(error.message, /U\+/);
});

test("invisible whitespace drift is named, not just shown", () => {
	const content = ["def run():", "    return compute()", ""].join("\n");
	const old_str = "        return compute()";

	const error = failureOf(content, replace(old_str, "x"));

	assert.match(error.message, /2\|    return compute\(\)/);
	assert.match(error.message, /space/);
});

test("mixed whitespace is shown, never miscounted as tabs or spaces", () => {
	const content = ["\t  return compute()", ""].join("\n");
	const error = failureOf(content, replace("  \treturn compute()", "x"));

	assert.match(error.message, /L1 col 1:/);
	assert.match(error.message, /"\\t  "/);
	assert.doesNotMatch(error.message, /3 tabs|3 spaces/);
});

test("no similar text is said plainly, with no invented location", () => {
	const content = ["alpha", "beta", "gamma", ""].join("\n");
	const old_str = "totally unrelated payload that shares nothing";

	const error = failureOf(content, replace(old_str, "x"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /no similar text/);
	assert.doesNotMatch(error.message, /\bL\d+|\d\|/);
});

test("a widely drifted block still comes back verbatim — that is what the model needs", () => {
	const content = [
		"step one: collect the facts",
		"step two: derive the status",
		"step three: project the surfaces",
		"",
	].join("\n");
	const old_str = [
		"step one: collect every fact from the ledger",
		"step two: derive the six states",
		"step three: project all five surfaces of the table",
	].join("\n");

	const error = failureOf(content, replace(old_str, "x"));

	assert.match(error.message, /1\|step one: collect the facts/);
	assert.match(error.message, /3\|step three: project the surfaces/);
});

test("the diagnostic asserts the old_str name and stays silent about the path", () => {
	const error = failureOf("first\n", replace("missing", "replacement"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /^old_str was not found;/);
	assert.doesNotMatch(error.message, /story\.txt|edits\[/);
});

test("the payload is bounded: long lines truncate and the window is capped", () => {
	const content = ["head", `  value = "${"x".repeat(400)}"`, "tail", ""].join("\n");
	const old_str = `  value = "${"x".repeat(200)}Y${"x".repeat(199)}"`;

	const error = failureOf(content, replace(old_str, "z"));

	assert.ok(error.message.length < 400, `payload too long: ${error.message.length}`);
	assert.match(error.message, /…/);
});

test("a long old_str reports only the first lines of the region", () => {
	const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the file`).join("\n");
	const old_str = Array.from({ length: 20 }, (_, index) => `line ${index + 1} of the FILE`).join("\n");

	const error = failureOf(content, replace(old_str, "x"));

	const shown = [...error.message.matchAll(/^\s*(\d+)\|/gm)].map((match) => Number(match[1]));
	assert.ok(shown.length <= 8, `window not capped: ${shown.length} lines`);
	assert.deepEqual(shown, shown.slice().sort((a, b) => a - b));
	assert.equal(shown[0], 1);
});