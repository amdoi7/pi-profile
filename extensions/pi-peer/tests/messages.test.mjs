import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { buildInjectedContent, formatIncomingCard, formatOutgoingCall } from "../src/messages.ts";

describe("注入文本(LLM 面)", () => {
	// 收信方需要三件事：这是谁（且能拿着它回信）、它怎么到的（唤醒/插队/留痕）、
	// 它没有用户权限。其余都是每条消息都付的 token。
	// 极简 XML:<peer from=id> 标签本身即类型声明(peer 非 user)+ 来源寻址,正文在标签内。
	test("buildInjectedContent:极简 XML 包裹,from 属性可寻址,正文在标签内", () => {
		const text = buildInjectedContent({ from: "p1abcdef-9999", text: "要决策", ts: 1 });
		assert.equal(text, `<peer from="p1abcdef">要决策</peer>`);
	});

	test("极简 XML:短 id 前缀可作 peer_send 的 to,标签即 peer 类型声明", () => {
		const text = buildInjectedContent({ from: "01a04647-4a56-7b89", text: "x", ts: 1700000000000 });
		assert.ok(text.startsWith('<peer from="01a04647">'), "以 peer 标签 + 可寻址来源开头");
		assert.ok(text.endsWith("x</peer>"), "正文在标签内");
		assert.ok(!text.includes("user"), "无冗余声明,标签即类型");
	});

	test("极简 XML:畸形 ts 不影响格式,正文原样保留", () => {
		const text = buildInjectedContent({ from: "01a0", text: "x\ny", ts: "bad" });
		assert.equal(text, `<peer from="01a0">x\ny</peer>`);
	});
});

describe("收件卡片(人面)", () => {
	test("header 带来源 id;body 取 details.text 原文", () => {
		const view = formatIncomingCard({ from: "p1abcdef-9999", text: "结论:方案 B" });
		assert.equal(view.header, "✉ peer message from p1abcdef");
		assert.equal(view.body, "结论:方案 B");
		assert.equal(view.tone, "accent");
	});

	// details 来自 session jsonl：旧会话回放的形状不得把渲染器抛掉。
	test("防御性解析:details 缺失/畸形不抛,降级渲染", () => {
		assert.equal(formatIncomingCard(undefined).header, "✉ peer message from unknown");
		assert.equal(formatIncomingCard(null).body, "");
		assert.equal(formatIncomingCard({ from: { sessionId: "0123456789abcdef" } }).header, "✉ peer message from unknown");
	});
});

describe("发件行(人面)", () => {
	// 发出去的正文是这次调用的载荷：不渲染就只能从参数 JSON 里认。
	test("头部 = 目标短码;正文默认折叠到 3 行", () => {
		const args = { to: ["01a04647-4a56", "01a04620-177a"], text: "L1\nL2\nL3\nL4\nL5" };
		const folded = formatOutgoingCall(args, false);
		assert.equal(folded.head, "01a04647, 01a04620");
		assert.deepEqual(folded.lines, ["L1", "L2", "L3"]);
		assert.equal(folded.folded, 2);
		const full = formatOutgoingCall(args, true);
		assert.equal(full.lines.length, 5);
		assert.equal(full.folded, 0);
	});

	test("默认到达方式不标注;裸字符串 to 与流式残缺参数不抛", () => {
		assert.equal(formatOutgoingCall({ to: "01a04647-4a56", text: "x" }, false).head, "01a04647");
		const partial = formatOutgoingCall({ to: ["01a0"] }, false);
		assert.deepEqual(partial.lines, []);
		assert.equal(partial.folded, 0);
		assert.equal(formatOutgoingCall(undefined, false).head, "");
	});
});
