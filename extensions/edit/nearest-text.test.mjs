/**
 * NOT_FOUND 的载荷契约:把文件里真实的那几行原样带回。
 *
 * 语料(2026-08-27,560 session / 14396 次 edit):913 次 NOT_FOUND 里 70% 的下一步
 * 是重读同一个文件(bash 59% + read 11%),15% 是原样重试。工具手里就有那段字节,
 * 却让模型再花一次往返去取——所以失败响应必须自带权威原文,而不是更好的措辞。
 * 锚规模:中位 195 字符,39% ≤3 行,故带回的区域按锚长封顶即可。
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { applyEditsToNormalizedContent } from "./edit-engine.ts";

function failureOf(content, edits) {
	try {
		applyEditsToNormalizedContent(content, edits);
	} catch (error) {
		return error;
	}
	throw new Error("expected the edit to fail");
}

test("the file's real lines come back verbatim with their line numbers", () => {
	// 真实语料(Dangwu 时序制约与前置边.md L287):文件是顿号,锚写成半角逗号。
	const content = [
		"# 标题",
		"",
		"的 (mode, status) 表消费:同一 `at_risk` 事实,gate 出导航卡、hard 出拒绝、",
		"guide 出引导卡、hint 出提醒。",
		"",
	].join("\n");
	const anchor = "gate 出导航卡、hard 出拒绝,\nguide 出引导卡、hint 出提醒。";

	const error = failureOf(content, [{ oldText: anchor, newText: "x" }]);

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /^oldText was not found;/);
	// 权威原文按行带回：模型下一步是复制，不是再读一遍文件。
	assert.match(error.message, /3\|的 \(mode, status\) 表消费:同一 `at_risk` 事实,gate 出导航卡、hard 出拒绝、/);
	assert.match(error.message, /4\|guide 出引导卡、hint 出提醒。/);
	// 肉眼不可辨的差异必须指名到码位。
	assert.match(error.message, /L3 col \d+/);
	assert.match(error.message, /U\+3001/);
	assert.match(error.message, /U\+002C/);
});

test("the reported column counts codepoints, not UTF-16 units", () => {
	// 前置 4 个汉字 + 1 个 emoji（代理对）：分歧字符在第 6 列，而非第 7 个单元。
	const content = ["定位基准🌟A", ""].join("\n");
	const error = failureOf(content, [{ oldText: "定位基准🌟B", newText: "x" }]);

	assert.match(error.message, /L1 col 6:/);
	assert.match(error.message, /file "A" U\+0041 ≠ oldText "B" U\+0042/);
});

test("a rewritten line comes back as the file has it", () => {
	const content = [
		"function total(items) {",
		"  const sum = items.reduce((a, b) => a + b, 0);",
		"  return sum;",
		"}",
		"",
	].join("\n");
	const anchor = "  const sum = items.reduce((acc, item) => acc + item, 0);\n  return sum;";

	const error = failureOf(content, [{ oldText: anchor, newText: "x" }]);

	assert.match(error.message, /2\|  const sum = items\.reduce\(\(a, b\) => a \+ b, 0\);/);
	assert.match(error.message, /3\|  return sum;/);
	// 分歧段两侧都短,可以逐字指认，但不是单字符 → 不报码位。
	assert.match(error.message, /L2 col \d+/);
	assert.doesNotMatch(error.message, /U\+/);
});

test("invisible whitespace drift is named, not just shown", () => {
	const content = ["def run():", "    return compute()", ""].join("\n");
	const anchor = "        return compute()";

	const error = failureOf(content, [{ oldText: anchor, newText: "x" }]);

	assert.match(error.message, /2\|    return compute\(\)/);
	assert.match(error.message, /space/);
});

test("no similar text is said plainly, with no invented location", () => {
	const content = ["alpha", "beta", "gamma", ""].join("\n");
	const anchor = "totally unrelated payload that shares nothing";

	const error = failureOf(content, [{ oldText: anchor, newText: "x" }]);

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
	const anchor = [
		"step one: collect every fact from the ledger",
		"step two: derive the six states",
		"step three: project all five surfaces of the table",
	].join("\n");

	const error = failureOf(content, [{ oldText: anchor, newText: "x" }]);

	assert.match(error.message, /1\|step one: collect the facts/);
	assert.match(error.message, /3\|step three: project the surfaces/);
});

test("the replacement prefix and path silence of the diagnostic are unchanged", () => {
	const error = failureOf(
		"first\n",
		[
			{ oldText: "first", newText: "updated" },
			{ oldText: "missing", newText: "replacement" },
		],
	);

	assert.equal(error.kind, "NOT_FOUND");
	assert.match(error.message, /^replacement 2: oldText was not found;/);
	assert.doesNotMatch(error.message, /story\.txt|edits\[/);
});

test("every failed anchor in one batch carries its own payload", () => {
	const error = failureOf(
		"alpha\nbeta\n",
		[
			{ oldText: "alphaa", newText: "x" },
			{ oldText: "gamma-delta-epsilon-zeta", newText: "y" },
		],
	);

	assert.match(error.message, /^edit failed \(2 of 2\):/);
	assert.match(error.message, /1\|alpha/);
	assert.match(error.message, /no similar text/);
});

test("the payload is bounded: long lines truncate and the window is capped", () => {
	const content = ["head", `  value = "${"x".repeat(400)}"`, "tail", ""].join("\n");
	// 行内只差一个字符：对齐成立，带回的那行却远超展示预算。
	const anchor = `  value = "${"x".repeat(200)}Y${"x".repeat(199)}"`;

	const error = failureOf(content, [{ oldText: anchor, newText: "z" }]);

	assert.ok(error.message.length < 400, `payload too long: ${error.message.length}`);
	assert.match(error.message, /…/);
});

test("a long anchor reports only the first lines of the region", () => {
	const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the file`).join("\n");
	const anchor = Array.from({ length: 20 }, (_, index) => `line ${index + 1} of the FILE`).join("\n");

	const error = failureOf(content, [{ oldText: anchor, newText: "x" }]);

	const shown = [...error.message.matchAll(/^\s*(\d+)\|/gm)].map((match) => Number(match[1]));
	assert.ok(shown.length <= 8, `window not capped: ${shown.length} lines`);
	assert.deepEqual(shown, shown.slice().sort((a, b) => a - b));
	assert.equal(shown[0], 1);
});
