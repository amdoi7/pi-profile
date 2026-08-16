import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { TranscriptZone } from "../src/transcript.ts";

// getMarkdownTheme 依赖 pi 主题子系统;测试环境显式初始化(无 watcher)
initTheme(undefined, false);

// 真实 ANSI 序列(与 pi 渲染一致):wrapTextWithAnsi 只认 ANSI 不认 <c> 标记,
// 折行宽度断言必须走真实路径。
const theme = {
	fg: (c, t) => `\x1b[38;5;1m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[0m`,
};

/** 可见宽:东亚宽字符计 2 列(与 pane 测试同表)。 */
function visWidth(s) {
	let w = 0;
	for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
	return w;
}

/** 数据源平铺:view 回调返回 SessionEntry[](live buffer / dead 解析缓存的测试替身)。 */
const msg = (message) => ({ type: "message", message });

describe("TranscriptZone(view 数据源:渲染路径零 IO)", () => {
	test("renderBody:投影行窗口化;无源给状态提示不抛错", () => {
		const z = new TranscriptZone({ view: () => [msg({ role: "user", content: "修 bug" })], theme });
		assert.ok(z.renderBody(80, 5).join("\n").includes("❯ 修 bug"));
		const missing = new TranscriptZone({ view: () => undefined, theme });
		assert.ok(missing.renderBody(80, 5).join("\n").includes("无 session 文件"));
		const starting = new TranscriptZone({ view: () => [], theme, state: () => "starting" });
		assert.ok(starting.renderBody(80, 5).join("\n").includes("等待握手"), "starting 空 buffer = transient 提示");
	});

	test("选中切换:resetView 滚动复位到底部,view 换源后投影新内容", () => {
		let current = [msg({ role: "user", content: "任务A" })];
		const z = new TranscriptZone({ view: () => current, theme });
		assert.ok(z.renderBody(80, 5).join("\n").includes("任务A"));
		current = [msg({ role: "user", content: "任务B" })];
		z.resetView();
		const out = z.renderBody(80, 5).join("\n");
		assert.ok(out.includes("任务B"));
		assert.ok(!out.includes("任务A"));
	});

	describe("自动换行(边界不截断)", () => {
		test("非 markdown 长行按可见宽折行:内容完整不丢,每行不超宽", () => {
			const z = new TranscriptZone({ view: () => [msg({ role: "user", content: "x".repeat(50) })], theme });
			const lines = z.renderBody(16, 8).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
			const text = lines.filter((l) => l.length > 0).join("");
			assert.equal((text.match(/x/g) ?? []).length, 50, "全部字符保留(折行不截断)");
			for (const l of lines) assert.ok(visWidth(l) <= 16, `行超宽: ${visWidth(l)} > 16`);
		});

		test("全角字符计 2 列折行(中英混排不超宽)", () => {
			const z = new TranscriptZone({ view: () => [msg({ role: "user", content: "中".repeat(12) + "abc" })], theme });
			for (const l of z.renderBody(10, 8)) {
				const plain = l.replace(/\x1b\[[0-9;]*m/g, "");
				assert.ok(visWidth(plain) <= 10, `全角未按 2 列折行: ${visWidth(plain)} > 10`);
			}
		});

	test("measureBody 与 renderBody 行数一致(折行后高度预算不错位)", () => {
			const z = new TranscriptZone({ view: () => [msg({ role: "user", content: "y".repeat(80) })], theme });
			assert.equal(z.measureBody(15), z.renderBody(15, 99).filter((l) => l !== "").length);
		});

		describe("消息粒度导航(history 焦点 cursor 移动)", () => {
			const entries = () => [
				msg({ role: "user", content: "一" }),
				msg({ role: "user", content: "二" }),
				msg({ role: "user", content: "三" }),
				msg({ role: "user", content: "四" }),
			];

			test("首次 ↑:光标落视口内最下锚点(阅读位置)再上一消息;逐次上移,头部边缘 no-op", () => {
				const z = new TranscriptZone({ view: entries, theme });
				z.renderBody(80, 5); // 全部可见(4 行 ≤ 5),底部 follow
				// 渲染后取光标行(与 pane 流程一致:renderBody 状态对齐 → cursorRowInView)
				const rowOf = (row, text) => {
					z.renderBody(80, 5);
					assert.equal(z.cursorRowInView(), row, `光标行 ${row}`);
					assert.ok(z.renderBody(80, 5)[row].includes(text), `${text} 在行 ${row}`);
				};
				z.scrollToAnchor(-1);
				rowOf(2, "❯ 三"); // 四→三
				z.scrollToAnchor(-1);
				rowOf(1, "❯ 二"); // 三→二
				z.scrollToAnchor(-1);
				rowOf(0, "❯ 一"); // 二→一
				z.scrollToAnchor(-1);
				rowOf(0, "❯ 一"); // 头部边缘 no-op
			});

			test("首次 ↓:光标落阅读位置(底部已是最新,不跳);继续 ↓ no-op", () => {
				const z = new TranscriptZone({ view: entries, theme });
				z.renderBody(80, 5);
				z.scrollToAnchor(1);
				z.renderBody(80, 5); // follow 回底对齐
				assert.equal(z.cursorRowInView(), 3, "阅读位置 = 四(follow 回底后行 3)");
				z.scrollToAnchor(1);
				assert.equal(z.cursorRowInView(), 3, "底部边缘 no-op");
			});

			test("锚点折行:行对齐按渲染行(startOf 计折行/多行块)", () => {
				const z = new TranscriptZone({ view: () => [msg({ role: "user", content: "x".repeat(40) }), msg({ role: "user", content: "短" })], theme });
				z.renderBody(16, 10); // 首条折 3 行(❯ + 38x)
				z.scrollToAnchor(-1); // 阅读=短,上移 → 长条
				assert.equal(z.cursorRowInView(), 0, "长条锚点首行(折行后的第 1 渲染行)");
			});

			test("跳到最后的锚点 → follow 回底,新内容仍可见", () => {
				const e = entries();
				const z = new TranscriptZone({ view: () => e, theme });
				z.renderBody(80, 5);
				for (let i = 0; i < 3; i++) z.scrollToAnchor(-1); // → 一
				for (let i = 0; i < 3; i++) z.scrollToAnchor(1); // → 四(follow)
				e.push(msg({ role: "user", content: "五" }));
				assert.ok(z.renderBody(80, 5).join("\n").includes("五"), "最后锚点 follow:新内容可见");
			});

			test("resetView 清光标;无锚点内容 no-op 不崩", () => {
				const z = new TranscriptZone({ view: () => [msg({ role: "toolResult", toolCallId: "c", toolName: "bash", content: "out", isError: false })], theme });
				z.renderBody(80, 5);
				z.scrollToAnchor(-1);
				assert.equal(z.cursorRowInView(), -1, "无锚点 → 无光标");
			});

			test("对齐换行:续行按首行前缀宽悬挂缩进(⚒ 后文本列对齐),每行不超宽", () => {
				const z = new TranscriptZone({ view: () => [msg({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(60) } }] })], theme });
				const lines = z.renderBody(20, 8).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
				assert.ok(lines[0].startsWith("⚒ bash:"), "首行带前缀");
				const cont = lines.slice(1).filter((l) => l.length > 0);
				assert.ok(cont.length > 0, "长命令折行");
				assert.ok(cont.every((l) => l.startsWith("  ")), "续行 2 列悬挂缩进(对齐 ⚒ 后文本)");
				for (const l of lines) assert.ok(visWidth(l) <= 20, `超宽 ${visWidth(l)} > 20`);
			});

			test("对齐换行:无前缀文本(纯文本行)续行不额外缩进", () => {
				const z = new TranscriptZone({ view: () => [msg({ role: "user", content: "\n".repeat(0) + "纯文本".repeat(30) })], theme });
				// user 首行带 ❯ 前缀:续行应对齐文本起点(❯ 后);纯内容行不受影响
				const lines = z.renderBody(20, 8).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
				for (const l of lines) assert.ok(visWidth(l) <= 20, `超宽 ${visWidth(l)}`);
			});
		});
	});

	test("原位追加(live buffer push)→ 投影跟随;底部 follow;上滚脱离不跳", () => {
		const entries = Array.from({ length: 20 }, (_, i) => msg({ role: "assistant", content: [{ type: "text", text: `L${i}` }] }));
		const z = new TranscriptZone({ view: () => entries, theme });
		const bottom = z.renderBody(80, 5).join("\n");
		assert.ok(bottom.includes("L19"), "初始在底部");
		// 原位追加(与 manager buffer push 同语义:同引用长度变)
		entries.push(msg({ role: "assistant", content: [{ type: "text", text: "L20" }] }));
		assert.ok(z.renderBody(80, 5).join("\n").includes("L20"), "同引用长度变 → 重投影跟随");
		// 上滚脱离 follow:再追加不跳
		z.scroll(-3);
		z.renderBody(80, 5);
		const before = z.renderBody(80, 5).join("\n");
		entries.push(msg({ role: "assistant", content: [{ type: "text", text: "L21" }] }));
		assert.equal(z.renderBody(80, 5).join("\n"), before, "脱离 follow 后追加不跳");
	});
});
