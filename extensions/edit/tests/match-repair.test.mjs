/**
 * CJK/ASCII 标点的等价类:old_str 里把 `、` 写成 `,`、把 `，` 写成 `,` 这类转写漂移
 * 直接命中,不报错、不占往返。弯引号折叠是同一先例,这里只是把等价类补齐,
 * 并补上一条更强的保序规则。
 *
 * 铁律:模糊命中后不得整段覆盖。模型**无意改动**的部分必须保留文件原字节;
 * 判据:old_str 与 new_str 的公共前后缀 = 模型无意改的部分 → 取文件字节;中间那段
 * = 模型的意图 → 取模型文本。歧义仍然响亮出错(DUPLICATE_MATCH)。
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { applyOpToNormalizedContent } from "../match.ts";

const replace = (oldStr, newStr) => ({ op: "replace", old_str: oldStr, new_str: newStr });
const replaceAll = (oldStr, newStr) => ({ op: "replaceAll", old_str: oldStr, new_str: newStr });

test("a halfwidth comma in the old_str matches the file's ideographic comma", () => {
	const content = [
		"的 (mode, status) 表消费:同一 `at_risk` 事实,gate 出导航卡、hard 出拒绝、",
		"guide 出引导卡、hint 出提醒。",
		"",
	].join("\n");
	const old_str = "hard 出拒绝,\nguide 出引导卡、hint 出提醒。";
	const replacement = "hard 出拒绝,\nguide 出文本双路说明、hint 出提醒。";

	const { newContent } = applyOpToNormalizedContent(content, replace(old_str, replacement));

	assert.match(newContent, /hard 出拒绝、\n/);
	assert.match(newContent, /guide 出文本双路说明、hint 出提醒。/);
	assert.doesNotMatch(newContent, /引导卡/);
});

test("fullwidth punctuation in the file matches halfwidth in the old_str", () => {
	const content = ["取值范围（含边界）：0～100；超出即拒绝！", ""].join("\n");
	const old_str = "取值范围(含边界):0～100;超出即拒绝!";
	const replacement = "取值范围(含边界):0～200;超出即拒绝!";

	const { newContent } = applyOpToNormalizedContent(content, replace(old_str, replacement));

	assert.equal(newContent, "取值范围（含边界）：0～200；超出即拒绝！\n");
});

// 边界：全角空格参与**匹配**（old_str 写成普通空格也能命中），但不参与**回写**。
// 缩进类空白更是语义（Python），连匹配都不折。
test("the ideographic space folds for matching only, never for rewriting", () => {
	const { newContent } = applyOpToNormalizedContent(
		"项目　名称: alpha\n",
		replace("项目 名称: alpha", "项目 名称: beta"),
	);
	assert.equal(newContent, "项目 名称: beta\n");

	assert.throws(
		() => applyOpToNormalizedContent(
			"def run():\n    return compute()\n",
			replace("        return compute()", "        return other()"),
		),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			return true;
		},
	);
});

// 前后缀拼接只能表达**单段**差异：等长对齐给出的局部方言映射才能盖住多段。
test("both file marks survive when the model changes two places at once", () => {
	const { newContent } = applyOpToNormalizedContent("甲、乙、丙\n", replace("甲,乙,丙", "A,乙,B"));

	assert.equal(newContent, "A、乙、B\n");
});

// 同一写法在文件里对应两种形式时不猜：宁可按模型原文落盘，也不能拍一个。
test("an ambiguous dialect map falls back instead of guessing", () => {
	const { newContent } = applyOpToNormalizedContent("甲、乙，丙\n", replace("甲,乙,丙", "甲,乙,丁"));

	assert.equal(newContent, "甲,乙,丁\n");
});

test("the model's own punctuation still wins inside the span it rewrites", () => {
	const { newContent } = applyOpToNormalizedContent("标题、副标题\n", replace("标题、副标题", "标题,说明"));

	assert.equal(newContent, "标题,说明\n");
});

test("two repairable places means ambiguous, so nothing is repaired", () => {
	const content = ["甲、乙", "甲，乙", ""].join("\n");

	assert.throws(
		() => applyOpToNormalizedContent(content, replace("甲,乙", "甲,丙")),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			assert.match(error.message, /copy from the file:/);
			return true;
		},
	);
});

// replaceAll 不进修复：「每一处」里各处的字节形式可能不同，修成一种会漏其余。
test("replaceAll never enters the repair path", () => {
	const content = ["前置、旧值、后置", "前置，旧值，后置", ""].join("\n");

	assert.throws(
		() => applyOpToNormalizedContent(content, replaceAll("前置,旧值,后置", "前置,新值,后置")),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			return true;
		},
	);
});

test("an exact match anywhere still beats a folded one", () => {
	const { newContent } = applyOpToNormalizedContent("A、B\nA,B\n", replace("A,B", "A,C"));

	assert.equal(newContent, "A、B\nA,C\n");
});