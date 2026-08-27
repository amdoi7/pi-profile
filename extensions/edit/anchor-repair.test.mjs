/**
 * CJK/ASCII 标点的等价类:锚里把 `、` 写成 `,`、把 `，` 写成 `,` 这类转写漂移
 * 直接命中，不报错、不占往返——这是 harness 该自己吞掉的一类,不该教给模型。
 *
 * 先例:引擎早就对弯引号做同一件事(normalizeForFuzzyMatch + preserveQuoteStyle)。
 * 这里只是把等价类补齐,并补上一条更强的保序规则。
 *
 * 铁律(比折叠本身更重要):模糊命中后不得整段覆盖。模型**无意改动**的部分必须
 * 保留文件原字节,否则文件的标点风格会被悄悄改写——那才是真正的 silent fallback。
 * 判据:oldText 与 newText 的公共前后缀 = 模型无意改的部分 → 取文件字节;
 *      中间那段 = 模型的意图 → 取模型文本。
 *
 * 歧义仍然响亮:折叠后命中多处时照旧抛 DUPLICATE_MATCH(既有守卫)。
 * 语料 2026-08-27:474 个可复核失败锚上折叠产生的歧义为 0。
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { applyEditsToNormalizedContent } from "./edit-engine.ts";

test("a halfwidth comma in the anchor matches the file's ideographic comma", () => {
	// 本次对话的第一个失败(时序制约与前置边.md L287)。
	const content = [
		"的 (mode, status) 表消费:同一 `at_risk` 事实,gate 出导航卡、hard 出拒绝、",
		"guide 出引导卡、hint 出提醒。",
		"",
	].join("\n");
	const anchor = "hard 出拒绝,\nguide 出引导卡、hint 出提醒。";
	const replacement = "hard 出拒绝,\nguide 出文本双路说明、hint 出提醒。";

	const { newContent } = applyEditsToNormalizedContent(content, [
		{ oldText: anchor, newText: replacement },
	]);

	// 文件那个顿号原样保留——模型并没有打算改它。
	assert.match(newContent, /hard 出拒绝、\n/);
	// 模型真正的意图落地了。
	assert.match(newContent, /guide 出文本双路说明、hint 出提醒。/);
	assert.doesNotMatch(newContent, /引导卡/);
});

test("fullwidth punctuation in the file matches halfwidth in the anchor", () => {
	const content = ["取值范围（含边界）：0～100；超出即拒绝！", ""].join("\n");
	const anchor = "取值范围(含边界):0～100;超出即拒绝!";
	const replacement = "取值范围(含边界):0～200;超出即拒绝!";

	const { newContent } = applyEditsToNormalizedContent(content, [
		{ oldText: anchor, newText: replacement },
	]);

	// 全角标点一个都没被换掉，只有 100 → 200。
	assert.equal(newContent, "取值范围（含边界）：0～200；超出即拒绝！\n");
});

// 边界：全角空格参与**匹配**（锚写成普通空格也能命中），但不参与**回写**：
// 从一处全角空格学到 `space → 　` 会把 newText 里每个空格都改掉。
// 缩进类空白更是语义（Python），连匹配都不折。
test("the ideographic space folds for matching only, never for rewriting", () => {
	const { newContent } = applyEditsToNormalizedContent("项目　名称: alpha\n", [
		{ oldText: "项目 名称: alpha", newText: "项目 名称: beta" },
	]);
	assert.equal(newContent, "项目 名称: beta\n");

	assert.throws(
		() => applyEditsToNormalizedContent("def run():\n    return compute()\n", [
			{ oldText: "        return compute()", newText: "        return other()" },
		]),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			return true;
		},
	);
});

// 前后缀拼接只能表达**单段**差异：首尾各改一处时前后缀都为 0，中段整段覆盖，
// 文件那两个顿号就没了。等长对齐给出的局部方言映射才能盖住多段。
test("both file marks survive when the model changes two places at once", () => {
	const { newContent } = applyEditsToNormalizedContent("甲、乙、丙\n", [
		{ oldText: "甲,乙,丙", newText: "A,乙,B" },
	]);

	assert.equal(newContent, "A、乙、B\n");
});

// 同一写法在文件里对应两种形式时不猜：宁可按模型原文落盘，也不能拍一个。
test("an ambiguous dialect map falls back instead of guessing", () => {
	const { newContent } = applyEditsToNormalizedContent("甲、乙，丙\n", [
		{ oldText: "甲,乙,丙", newText: "甲,乙,丁" },
	]);

	assert.equal(newContent, "甲,乙,丁\n");
});

test("the model's own punctuation still wins inside the span it rewrites", () => {
	const content = ["标题、副标题", ""].join("\n");
	const { newContent } = applyEditsToNormalizedContent(content, [
		{ oldText: "标题、副标题", newText: "标题,说明" },
	]);

	// 这里模型改的正是那个标点，它的写法必须生效。
	assert.equal(newContent, "标题,说明\n");
});

test("two repairable places means ambiguous, so nothing is repaired", () => {
	// 两处都只差标点、那一处都不是精确命中 → 修复面模棱两可，拒绝动手。
	const content = ["甲、乙", "甲，乙", ""].join("\n");

	assert.throws(
		() => applyEditsToNormalizedContent(content, [{ oldText: "甲,乙", newText: "甲,丙" }]),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			// 拒绝也要交回原文，模型下一步才能改对。
			assert.match(error.message, /copy from the file:/);
			return true;
		},
	);
});

// replaceAll 不进修复，这是刻意的：「每一处」里各处的字节形式可能不同，
// 修成一种再全量替换会漏掉其余那些——漏掉比拒绝更坏。
test("replaceAll never enters the repair path", () => {
	const content = ["前置、旧值、后置", "前置，旧值，后置", ""].join("\n");

	assert.throws(
		() => applyEditsToNormalizedContent(content, [
			{ oldText: "前置,旧值,后置", newText: "前置,新值,后置", replaceAll: true },
		]),
		(error) => {
			assert.equal(error.kind, "NOT_FOUND");
			return true;
		},
	);
});

test("an exact match anywhere still beats a folded one", () => {
	const content = ["A、B", "A,B", ""].join("\n");
	const { newContent } = applyEditsToNormalizedContent(content, [
		{ oldText: "A,B", newText: "A,C" },
	]);

	// 第 2 行是精确命中，第 1 行不能被碰。
	assert.equal(newContent, "A、B\nA,C\n");
});
