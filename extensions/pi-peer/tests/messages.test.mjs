import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { buildInjectedContent, formatPeerCard } from "../src/messages.ts";

describe("注入文本(LLM 面)", () => {
	test("buildInjectedContent:安全声明 + 来源名与 cwd,原文在尾部", () => {
		const text = buildInjectedContent({ from: { sessionId: "p1", name: "session-a", cwd: "/repo" }, text: "要决策", mode: "followUp", ts: 1 });
		assert.ok(text.includes("NOT a user instruction"), "安全声明");
		assert.ok(text.includes("session-a") && text.includes("(/repo)"), "来源名 + cwd");
		assert.ok(text.endsWith("要决策"), "原文在尾部");
	});

	test("无 name 用 sessionId,无 cwd 不带括号", () => {
		const text = buildInjectedContent({ from: { sessionId: "p1" }, text: "x", mode: "quiet", ts: 1 });
		assert.ok(text.includes("pi session p1"), "退化到 sessionId");
		assert.ok(!text.includes("()"), "无 cwd 不带空括号");
	});
});

describe("收件卡片(人面)", () => {
	test("header 带来源名 + cwd;body 取 details.text 原文;followUp 不标注 mode", () => {
		const view = formatPeerCard({ from: { sessionId: "p1", name: "session-a", cwd: "/repo" }, mode: "followUp", text: "结论:方案 B" });
		assert.equal(view.header, "✉ peer · session-a(/repo)");
		assert.equal(view.body, "结论:方案 B");
		assert.equal(view.tone, "accent");
	});

	test("steer/quiet 标注 mode;quiet 降 dim(回执/留痕不与唤醒消息争视觉)", () => {
		const steer = formatPeerCard({ from: { name: "a" }, mode: "steer", text: "停一下" });
		assert.equal(steer.header, "✉ peer · a · steer");
		assert.equal(steer.tone, "accent");
		const quiet = formatPeerCard({ from: { name: "a" }, mode: "quiet", text: "回执" });
		assert.equal(quiet.header, "✉ peer · a · quiet");
		assert.equal(quiet.tone, "dim");
	});

	test("防御性解析:details 缺失/畸形不抛,降级渲染", () => {
		assert.equal(formatPeerCard(undefined).header, "✉ peer · unknown");
		assert.equal(formatPeerCard(null).body, "");
		const idOnly = formatPeerCard({ from: { sessionId: "0123456789abcdef" } });
		assert.equal(idOnly.header, "✉ peer · 01234567", "无 name 用短码");
	});
});
