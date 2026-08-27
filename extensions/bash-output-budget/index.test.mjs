/**
 * 胖尾裁剪的契约:超预算的 bash 结果保留头尾、中段挪进溢出文件,并说清挪走了什么。
 *
 * 语料 2026-08-27(560 session / 73,423 次 bash 结果,合计 105.1M 字符):
 * 输出中位数只有 598 字符,但最胖 10% 的调用吃掉 52% 的字节。按 8000 字符阈值 +
 * 头 40/尾 20 行模拟:只动 1,556 次调用(2.1%),省下 20.8M 字符(20%)。降到 4000
 * 要多动 3 倍调用只多省 8 个百分点——取最小干预点。
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";

import { applyOutputBudget } from "./budget.ts";
import bashOutputBudgetExtension from "./index.ts";

function captureHandler() {
	const handlers = new Map();
	bashOutputBudgetExtension({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	const onToolResult = handlers.get("tool_result");
	assert.ok(onToolResult, "extension must register a tool_result handler");
	return onToolResult;
}

function bashResult(text) {
	return { toolName: "bash", isError: false, content: [{ type: "text", text }] };
}

function lines(count, prefix = "line") {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

test("output under budget is returned untouched", () => {
	const text = lines(50);
	const result = applyOutputBudget(text);

	assert.equal(result, undefined, "under budget must produce no change at all");
});

test("a fat result keeps its head and tail and names what moved", () => {
	const text = lines(4000, "row that is long enough to blow the byte budget");
	const result = applyOutputBudget(text);

	assert.ok(result, "over budget must produce a clipped result");
	const kept = result.text.split("\n");
	assert.equal(kept[0], "row that is long enough to blow the byte budget 1");
	assert.equal(kept.at(-1), "row that is long enough to blow the byte budget 4000");
	// 头 40 + 标记 + 尾 20
	assert.equal(kept.length, 40 + 1 + 20);
	assert.match(result.text, /3940 lines elided/);
	assert.match(result.text, /41-3980 of 4000/);
});

test("the elided middle is spilled to a file the marker names", () => {
	const text = lines(4000, "row that is long enough to blow the byte budget");
	const result = applyOutputBudget(text);

	const spill = /full output: (\S+)/.exec(result.text)?.[1];
	assert.ok(spill, `marker must name the spill file: ${result.text.slice(-200)}`);
	assert.equal(fs.readFileSync(spill, "utf-8"), text, "spill must hold the original verbatim");
	fs.rmSync(spill, { force: true });
});

test("a single huge line is clipped by characters, not dropped", () => {
	const text = `{"payload":"${"x".repeat(40000)}"}`;
	const result = applyOutputBudget(text);

	assert.ok(result);
	assert.ok(result.text.length < 9000, `still too long: ${result.text.length}`);
	assert.match(result.text, /characters elided/);
	assert.ok(result.text.startsWith('{"payload":"xxx'), "head must survive");
	assert.ok(result.text.trimEnd().endsWith('"}'), "tail must survive");
	const spill = /full output: (\S+)/.exec(result.text)?.[1];
	assert.equal(fs.readFileSync(spill, "utf-8"), text);
	fs.rmSync(spill, { force: true });
});

test("the handler clips only bash results that blow the budget", () => {
	const onToolResult = captureHandler();
	const fat = lines(4000, "row that is long enough to blow the byte budget");

	const clipped = onToolResult(bashResult(fat));
	assert.ok(clipped, "a fat bash result must come back clipped");
	assert.match(clipped.content[0].text, /lines elided/);
	const spill = /full output: (\S+)/.exec(clipped.content[0].text)?.[1];
	assert.equal(fs.readFileSync(spill, "utf-8"), fat);
	fs.rmSync(spill, { force: true });

	assert.equal(onToolResult(bashResult(lines(50))), undefined, "small output must pass through");
	assert.equal(
		onToolResult({ ...bashResult(fat), toolName: "edit" }),
		undefined,
		"only bash results are in scope",
	);
});

test("an unexpected content shape is left alone", () => {
	const onToolResult = captureHandler();
	const fat = lines(4000, "row that is long enough to blow the byte budget");

	assert.equal(
		onToolResult({ toolName: "bash", content: [{ type: "text", text: fat }, { type: "text", text: "tail" }] }),
		undefined,
		"multi-block results are not this extension's contract",
	);
	assert.equal(onToolResult({ toolName: "bash", content: undefined }), undefined);
});

test("when the spill cannot be written nothing is clipped", () => {
	const text = lines(4000, "row that is long enough to blow the byte budget");
	const result = applyOutputBudget(text, {
		writeSpill: () => {
			throw new Error("read-only filesystem");
		},
	});

	assert.equal(result, undefined, "losing the middle without a spill would destroy information");
});
