import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { projectTranscript, transcriptTitle } from "../src/transcript.ts";

/** 构造 v3 jsonl:header + message 条目链。 */
function jsonl(entries) {
	const header = { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" };
	return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

let seq = 0;
/** message 条目:默认沿文件序自动链 parentId;显式 id/parentId 覆盖(分支测试用)。 */
function msg(message, id, parentId) {
	seq += 1;
	return { type: "message", id: id ?? `e${seq}`, parentId: parentId === undefined ? (seq > 1 ? `e${seq - 1}` : null) : parentId, timestamp: "t", message };
}

describe("projectTranscript", () => {
	test("user 消息:❯ accent 前缀,多行缩进", () => {
		const content = jsonl([msg({ role: "user", content: "fix\nauth" })]);
		const lines = projectTranscript(content);
		assert.deepEqual(lines, [
			{ text: "❯ fix", color: "accent", anchor: true },
			{ text: "  auth", color: "accent" },
		]);
	});

	test("assistant:message 粒度——thinking 不投影(占位行零信息量),text Markdown", () => {
		const content = jsonl([
			msg({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "l1\nl2\nl3\nl4\nl5" },
					{ type: "text", text: "答案" },
				],
			}),
		]);
		const lines = projectTranscript(content);
		assert.deepEqual(lines, [
			{ text: "答案", color: "muted", markdown: true, anchor: true },
		], "thinking 占位行取消;text 走 Markdown 管线且是消息锚点");
	});

	test("toolCall 摘要(≤2 连续):首个标量=主语裸值(pi schema 惯例),无键白名单;多参 key=value;非标量跳过", () => {
		const content = jsonl([
			msg({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm test" } },
					{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "/a.ts", oldText: "old", newText: "new" } },
				],
			}),
		]);
		const lines = projectTranscript(content);
		assert.deepEqual(lines[0], { text: "⚒ bash: pnpm test", color: "dim", anchor: true });
		assert.ok(lines[1].text.startsWith("⚒ edit: /a.ts"), lines[1].text);
		assert.ok(lines[1].text.includes("oldText=old") && lines[1].text.includes("newText=new"), "多参 key=value");
	});

	test("toolCall 刷屏折叠:≥3 连续聚合为一行(⚒ ×N + 去重名序),防轨迹链刷屏", () => {
		const content = jsonl([
			msg({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg a" } },
					{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "rg b" } },
					{ type: "toolCall", id: "c3", name: "read", arguments: { path: "/a.ts" } },
					{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "rg c" } },
					{ type: "toolCall", id: "c5", name: "read", arguments: { path: "/b.ts" } },
					{ type: "toolCall", id: "c6", name: "edit", arguments: { path: "/a.ts", oldText: "o", newText: "n" } },
				],
			}),
		]);
		const lines = projectTranscript(content);
		assert.equal(lines.length, 1, "6 连 toolCall 折叠为一行");
		assert.equal(lines[0].text, "⚒ ×6 bash · read · edit", "聚合计数 + 去重名序(首次出现序)");
		assert.equal(lines[0].color, "dim");
		assert.equal(lines[0].anchor, true, "折叠行是浏览锚点");
	});

	test("toolResult 不投影(只有 text 与 toolCall;成败信号由 pane 诊断/回调承担)", () => {
		const content = jsonl([
			msg({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false }),
		]);
		assert.deepEqual(projectTranscript(content), []);
	});

	test("custom/bashExecution/compaction/未知 role 均不投影,不抛错", () => {
		const content = jsonl([
			msg({ role: "custom", customType: "pi-worker", content: "settled id=x", display: true }),
			msg({ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false }),
			msg({ role: "compactionSummary", summary: "压缩摘要", tokensBefore: 100 }),
			msg({ role: "futureRole", foo: 1 }),
		]);
		assert.deepEqual(projectTranscript(content), []);
	});

	test("分支解析:沿 parentId 取当前分支(文件末尾 tip 回溯),旧分支不投影", () => {
		// e1 → e2(旧分支);e1 → e3(当前分支,文件末尾为 tip)
		const content = jsonl([
			msg({ role: "user", content: "根" }, "e1", null),
			msg({ role: "user", content: "旧分支" }, "e2", "e1"),
			msg({ role: "user", content: "新分支" }, "e3", "e1"),
		]);
		const lines = projectTranscript(content);
		const texts = lines.map((l) => l.text);
		assert.ok(texts.includes("❯ 根"));
		assert.ok(!texts.includes("❯ 旧分支"), "旧分支不投影");
		assert.ok(texts.includes("❯ 新分支"));
	});

	test("空内容/坏行 → 空数组,不抛错", () => {
		assert.deepEqual(projectTranscript(""), []);
		assert.deepEqual(projectTranscript("{bad json\n"), []);
	});

	test("长文本行不截断(渲染层按宽度截断,投影保真)", () => {
		const content = jsonl([msg({ role: "user", content: "x".repeat(500) })]);
		assert.equal(projectTranscript(content)[0].text.length, 502);
	});
});

describe("transcriptTitle", () => {
	const rec = {
		id: "pi-worker-hank#a1b2c3d4e5f6",
		name: "hank",
		state: "running",
		processExited: false,
		turns: 2,
		createdAt: 1_000_000_000,
		updatedAt: 0,
		recent: [],
		modelInfo: { provider: "opencode-go", id: "deepseek-v4-flash", thinkingLevel: "low" },
		currentActivity: "tool: rg x",
	};

	test("标题栏 = 徽章槽:图标 + 模型·think + cost + Σtok(name/runtime/活动归主行,不重复)", () => {
		const t = transcriptTitle(rec);
		assert.equal(t.text, "● opencode-go/deepseek-v4-flash · think:low");
		assert.equal(t.color, "accent");
		const withStats = transcriptTitle({
			...rec,
			latestStats: { cost: 0.0042, tokens: { input: 8200, output: 4100, cacheRead: 3400, total: 15700 } },
		});
		assert.equal(withStats.text, "● opencode-go/deepseek-v4-flash · think:low · cost $0.0042 · 15.7k tok");
	});

	test("idle:✓ dim;无任何徽章时回退 name(区域标识最小集)", () => {
		const t = transcriptTitle({ ...rec, state: "idle", currentActivity: undefined });
		assert.equal(t.text, "✓ opencode-go/deepseek-v4-flash · think:low");
		const bare = transcriptTitle({ ...rec, modelInfo: undefined, model: undefined });
		assert.equal(bare.text, "● hank");
	});

	test("记录缺失(静态回退):name only dim", () => {
		const t = transcriptTitle(undefined, { fallbackName: "hank" });
		assert.deepEqual(t, { text: "● hank", color: "dim" });
	});
});

describe("Markdown 高亮(panel history 渲染管线)", () => {
	test("assistant text 块标 markdown:true;user/thinking/tool/result 保持纯行", () => {
		const content = jsonl([
			msg({ role: "user", content: "问" }),
			msg({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "想" },
					{ type: "text", text: "**答**" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				],
			}),
		]);
		const lines = projectTranscript(content);
		assert.deepEqual(lines.find((l) => l.text === "**答**"), { text: "**答**", color: "muted", markdown: true, anchor: true });
		assert.ok(!lines.find((l) => l.text.includes("❯"))?.markdown, "user 不走 markdown");
		assert.ok(!lines.some((l) => l.text === "..."), "thinking 不投影");
		assert.ok(!lines.find((l) => l.text.startsWith("⚒"))?.markdown);
	});
});
