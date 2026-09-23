/**
 * NOT_FOUND 的载荷契约:closest —— 文件里最接近 match 的整行原文,结构化字段
 * (startLine/text/truncated)逐字带回,照抄即 match。
 *
 * 语料(2026-09-09,111 session/371 次 NOT_FOUND):失败后 71% 的下一步是外取文件
 * (read/sed/grep),只有 19% 的重发用上了报错 prose 里的窗口行(剥 `NN|` 前缀
 * 重打,正是二次失败的来源);而照抄重发的一次成功率最高(88–90%)。所以窗口
 * 从 message prose(带行号前缀)移进结构化字段 closest,照抄是机械操作。
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { applyEntryToNormalizedContent } from "../match.ts";

function failureOf(content, op) {
	try {
		applyEntryToNormalizedContent(content, op);
	} catch (error) {
		return error;
	}
	throw new Error("expected the edit to fail");
}

const replace = (oldStr, newStr) => ({ match: oldStr, new_str: newStr });

test("closest carries the file's real lines verbatim, without prefixes", () => {
	const content = [
		"# 标题",
		"",
		"维护面,需要时再拆。",
		"",
		"**默认假设**:产品先行,包纪律保持。",
		"",
	].join("\n");
	const needle = "维护面,需要时再拆。\n\n## 一、分层与依赖法则";

	const error = failureOf(content, replace(needle, "x"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /^match was not found;/);
	assert.ok(error.closest, "closest must be present");
	assert.equal(error.closest.startLine, 3);
	// needle 是 2 行,窗口取 needle 行数(含未命中的第 2 行在文件里的实况)。
	assert.equal(error.closest.text, "维护面,需要时再拆。\n\n**默认假设**:产品先行,包纪律保持。");
	assert.equal(error.closest.truncated, false);
});

test("a multi-line needle gets a multi-line closest verbatim", () => {
	const content = [
		"function total(items) {",
		"  const sum = items.reduce((a, b) => a + b, 0);",
		"  return sum;",
		"}",
		"",
	].join("\n");
	const needle = "  const sum = items.reduce((acc, item) => acc + item, 0);\n  return sum;";

	const error = failureOf(content, replace(needle, "x"));

	assert.equal(error.closest.startLine, 2);
	assert.equal(error.closest.text, "  const sum = items.reduce((a, b) => a + b, 0);\n  return sum;");
	assert.equal(error.closest.truncated, false);
	// message 只有一行 pointer + 指令,不再嵌窗口文本。
	assert.doesNotMatch(error.message, /copy from the file:/);
});

test("the pointer names the first divergence verbatim (codepoint columns)", () => {
	const content = ["定位基准🌟A", ""].join("\n");
	const error = failureOf(content, replace("定位基准🌟B", "x"));

	assert.match(error.message, /L1 col 6:/);
	assert.match(error.message, /file "A" U\+0041 ≠ match "B" U\+0042/);
	assert.ok(error.closest, "pointer and closest are given together");
	assert.equal(error.closest.text, "定位基准🌟A");
});

test("invisible whitespace drift is named, not just shown", () => {
	const content = ["def run():", "    return compute()", ""].join("\n");
	const needle = "        return compute()";

	const error = failureOf(content, replace(needle, "x"));

	assert.match(error.message, /space/);
	assert.ok(error.closest);
	// 单行 needle → 单行窗口,取对齐行 L2。
	assert.equal(error.closest.text, "    return compute()");
});

test("a widely drifted block still comes back verbatim — that is what the model needs", () => {
	const content = [
		"step one: collect the facts",
		"step two: derive the status",
		"step three: project the surfaces",
		"",
	].join("\n");
	const needle = [
		"step one: collect every fact from the ledger",
		"step two: derive the six states",
		"step three: project all five surfaces of the table",
	].join("\n");

	const error = failureOf(content, replace(needle, "x"));

	assert.equal(error.closest.text.split("\n")[0], "step one: collect the facts");
	assert.equal(error.closest.text.split("\n")[2], "step three: project the surfaces");
});

test("closest is capped at 8 lines and flags truncation instead of lying", () => {
	const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the file`).join("\n");
	const needle = Array.from({ length: 20 }, (_, index) => `line ${index + 1} of the FILE`).join("\n");

	const error = failureOf(content, replace(needle, "x"));

	assert.equal(error.closest.text.split("\n").length, 8, "window must be capped at 8 lines");
	assert.equal(error.closest.truncated, true, "needle longer than window must be flagged");
	assert.equal(error.closest.startLine, 1);
	const lines = error.closest.text.split("\n");
	assert.deepEqual([...lines].sort((a, b) => a.localeCompare(b)), lines, "lines stay in file order");
});

test("no similar text is said plainly, with no invented location and no closest", () => {
	const content = ["alpha", "beta", "gamma", ""].join("\n");
	const needle = "totally unrelated payload that shares nothing";

	const error = failureOf(content, replace(needle, "x"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /no similar text/);
	assert.doesNotMatch(error.message, /\bL\d+|\d\|/);
	assert.equal(error.closest, undefined);
});

test("the diagnostic asserts the match name and stays silent about the path", () => {
	const error = failureOf("first\n", replace("missing", "replacement"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /^match was not found;/);
	assert.doesNotMatch(error.message, /story\.txt|edits\[/);
});

test("oversized window flags truncation (char budget) without chopping text", () => {
	const content = ["head", `  value = "${"x".repeat(4000)}"`, "tail", ""].join("\n");
	const needle = `  value = "${"x".repeat(2000)}Y${"x".repeat(1999)}"`;

	const error = failureOf(content, replace(needle, "z"));

	assert.equal(error.closest.truncated, true);
	// 文本不截断掺假:哪行进窗口整行进。
	assert.ok(error.closest.text.includes("x".repeat(4000)));
	// 截断时指令与载荷同向:该重读,而不是照抄半截窗口。
	assert.match(error.message, /closest window is truncated — re-read the file, then re-send/);
	assert.doesNotMatch(error.message, /no re-read needed/);
});

test("needle beyond the line budget switches the pointer to re-read", () => {
	const content = [...Array.from({ length: 12 }, (_, i) => `line ${i}: alpha "beta" gamma`), ""].join("\n");
	const needle = Array.from({ length: 10 }, (_, i) => `line ${i}: alpha \u201cbeta\u201c gamma`).join("\n");

	const error = failureOf(content, replace(needle, "z"));

	assert.equal(error.closest.truncated, true);
	assert.match(error.message, /closest window is truncated — re-read the file, then re-send/);
	assert.doesNotMatch(error.message, /no re-read needed/);
});

test("a complete window keeps the copy-verbatim no-re-read instruction", () => {
	const content = ["alpha", "beta", "gamma", ""].join("\n");
	const error = failureOf(content, replace("alpa", "z"));

	assert.equal(error.closest.truncated, false);
	assert.match(error.message, /copy-verbatim the closest field and re-send — no re-read needed/);
	assert.doesNotMatch(error.message, /closest window is truncated/);
});

test("the instruction says to copy closest verbatim and re-send without re-reading", () => {
	const error = failureOf("alpha\n", replace("alpba", "x"));
	assert.match(error.message, /copy-verbatim the closest field and re-send — no re-read needed/);
	assert.ok(error.closest);
});

// ─── 撤修契约(2026-09-09):一切分歧显式化,引擎不再修写任何变体 ──────────────

test("halfwidth/fullwidth punctuation mismatch is a NOT_FOUND with closest, never a silent repair", () => {
	const content = ["hard 出拒绝、", "guide 出引导卡、hint 出提醒。", ""].join("\n");
	const needle = "hard 出拒绝,\nguide 出引导卡、hint 出提醒。";

	const error = failureOf(content, replace(needle, "x"));

	assert.equal(error.kind, "NOT_FOUND");
	assert.ok(error.closest);
	// 文件两行,closest 原样带回两行全角顿号 —— 照抄重发即命中。
	assert.equal(error.closest.text, "hard 出拒绝、\nguide 出引导卡、hint 出提醒。");
	assert.ok(error.closest.text.includes("出拒绝、"));
	assert.doesNotMatch(error.message, /copy from the file:/);
});

test("the ideographic space is not folded: explicit closest is the only recovery", () => {
	const error = failureOf("项目　名称: alpha\n", replace("项目 名称: alpha", "x"));
	assert.equal(error.kind, "NOT_FOUND");
	assert.ok(error.closest);
	assert.equal(error.closest.text, "项目　名称: alpha");
});

test("curly-vs-straight quote drift is a NOT_FOUND with closest, never a rewrite", () => {
	const error = failureOf("x’y x’y\n".replace(/x’y/g, "it’s"), replace("it's", "z"));
	assert.equal(error.kind, "NOT_FOUND");
	assert.ok(error.closest);
	assert.ok(error.closest.text.includes("’"), "closest keeps the file's curly quote verbatim");
});
