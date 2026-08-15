import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { TranscriptZone } from "../src/transcript.ts";

// getMarkdownTheme 依赖 pi 主题子系统;测试环境显式初始化(无 watcher)
initTheme(undefined, false);

const theme = {
	fg: (c, t) => `<${c}>${t}</>`,
	bold: (t) => `*${t}*`,
};

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
