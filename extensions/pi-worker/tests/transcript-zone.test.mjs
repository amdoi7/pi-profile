import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { TranscriptZone } from "../src/transcript.ts";

// getMarkdownTheme 依赖 pi 主题子系统;测试环境显式初始化(无 watcher)
initTheme(undefined, false);

const theme = {
	fg: (c, t) => `<${c}>${t}</>`,
	bold: (t) => `*${t}*`,
};

export function fixtureFile(lines) {
	const dir = mkdtempSync(join(tmpdir(), "pi-worker-tz-"));
	const file = join(dir, "s.jsonl");
	const header = { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" };
	let parent = null;
	const entries = [header];
	lines.forEach((message, i) => {
		const id = `e${i}`;
		entries.push({ type: "message", id, parentId: parent, timestamp: "t", message });
		parent = id;
	});
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return { file, append: (message) => {
		const id = `e${entries.length - 1}`;
		appendFileSync(file, JSON.stringify({ type: "message", id, parentId: parent, timestamp: "t", message }) + "\n");
	} };
}

describe("TranscriptZone(合并窗口的内嵌 transcript 区)", () => {
	test("renderBody:投影行窗口化;缺文件给提示不抛错", () => {
		const { file } = fixtureFile([{ role: "user", content: "修 bug" }]);
		const z = new TranscriptZone({ file, theme });
		assert.ok(z.renderBody(80, 5).join("\n").includes("❯ 修 bug"));
		const missing = new TranscriptZone({ file: "/nonexistent/x.jsonl", theme });
		assert.ok(missing.renderBody(80, 5).join("\n").includes("无 session 文件"));
	});

	test("setFile 重定向:滚动复位到底部(follow),新文件内容投影", () => {
		const a = fixtureFile([{ role: "user", content: "任务A" }]);
		const b = fixtureFile([{ role: "user", content: "任务B" }]);
		const z = new TranscriptZone({ file: a.file, theme });
		assert.ok(z.renderBody(80, 5).join("\n").includes("任务A"));
		z.setFile(b.file);
		const out = z.renderBody(80, 5).join("\n");
		assert.ok(out.includes("任务B"));
		assert.ok(!out.includes("任务A"));
	});

	test("follow bottom:在底部时文件增长自动跟随;向上滚动后脱离 follow 不跳", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `L${i}` }] }));
		const { file, append } = fixtureFile(many);
		const z = new TranscriptZone({ file, theme });
		// 初始在底部
		assert.ok(z.renderBody(80, 5).join("\n").includes("L19"), "初始底部");
		append({ role: "assistant", content: [{ type: "text", text: "L20" }] });
		assert.ok(z.renderBody(80, 5).join("\n").includes("L20"), "follow:新行自动可见");
		// 向上滚动脱离 follow
		z.scroll(-10);
		append({ role: "assistant", content: [{ type: "text", text: "L21" }] });
		const out = z.renderBody(80, 5).join("\n");
		assert.ok(!out.includes("L21"), "脱离 follow 后不被新内容拉动");
		assert.ok(!out.includes("L19"), "视口保持在上方");
		// 滚回底部恢复 follow
		z.scroll(1000);
		assert.ok(z.renderBody(80, 5).join("\n").includes("L21"), "回底恢复 follow");
	});

	test("窗口高度约束:输出恒 ≤ height", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `L${i}` }] }));
		const { file } = fixtureFile(many);
		const z = new TranscriptZone({ file, theme });
		assert.equal(z.renderBody(80, 7).length, 7);
		assert.equal(z.renderBody(80, 3).length, 3);
	});

	test("scrollMessage:↑↓ 按消息锚点逐条浏览(视口顶落在消息起点,非按行)", () => {
		const { file } = fixtureFile([
			{ role: "user", content: "任务" },
			{ role: "assistant", content: [{ type: "text", text: "回复一\n第二行\n第三行" }] },
			{ role: "user", content: "追问" },
			{ role: "assistant", content: [{ type: "text", text: "回复二" }] },
		]);
		const z = new TranscriptZone({ file, theme });
		// 投影行:[❯任务, 回复一, 第二行, 第三行, ❯追问, 回复二];height 2 初始 follow 底部
		assert.ok(z.renderBody(80, 2).join("\n").includes("回复二"), "初始底部");
		z.scrollMessage(-1);
		const prev1 = z.renderBody(80, 2).join("\n");
		assert.ok(prev1.includes("回复一") && prev1.includes("第二行"), "上一条:多行块首起");
		assert.ok(!prev1.includes("追问") && !prev1.includes("回复二"), "视口顶在消息起点");
		z.scrollMessage(-1);
		assert.ok(z.renderBody(80, 2).join("\n").includes("❯ 任务"), "再上一条:user 消息锚点");
		z.scrollMessage(1);
		assert.ok(z.renderBody(80, 2).join("\n").includes("回复一"), "下一条回退");
	});
});

describe("TranscriptZone markdown 高亮渲染", () => {
	test("assistant text 经 Markdown 管线:粗体标记不裸露,代码块语法高亮(ANSI 着色)", () => {
		const { file } = fixtureFile([
			{ role: "assistant", content: [{ type: "text", text: "**加粗** 与 `code`\n\n```bash\npnpm test\n```" }] },
		]);
		const z = new TranscriptZone({ file, theme });
		const out = z.renderBody(80, 10).join("\n");
		assert.ok(!out.includes("**"), `粗体标记不应裸露: ${out}`);
		assert.ok(out.includes("加粗"), "内容在");
		assert.ok(out.includes("pnpm"), "代码内容在");
		assert.ok(/\u001b\[38;/.test(out), "语法高亮 ANSI 着色生效(与父 transcript 同一管线)");
	});

	test("宽度变化重渲染 markdown(缓存按宽度失效)", () => {
		const long = "词 ".repeat(60).trim();
		const { file } = fixtureFile([{ role: "assistant", content: [{ type: "text", text: long }] }]);
		const z = new TranscriptZone({ file, theme });
		const narrow = z.renderBody(30, 20);
		const wide = z.renderBody(100, 20);
		assert.ok(narrow.length > wide.length || narrow.join("").length !== wide.join("").length, "宽度变化产生不同换行");
	});
});
