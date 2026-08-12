import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { buildSpawnArgs } from "../src/spawner.ts";
import { buildWorkerCharter } from "../src/contract.ts";

/** spawn 参数组装单测:pi CLI 注入面(瘦身 + 宪法)不回归。 */
describe("buildSpawnArgs", () => {
	test("瘦身注入:no-skills/no-context-files/no-extensions + 工具白名单", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			sessionDir: "/repo/.pi/worker/sessions",
			id: "pi-worker-a#123abc",
			name: "a",
		});
		assert.ok(args.includes("--no-skills"), "worker 不需要父的 skills");
		assert.ok(args.includes("--no-context-files"), "worker 不加载父 AGENTS.md(治理由 charter 注入)");
		assert.ok(args.includes("--no-extensions"), "子进程不加载父扩展列表");

		const eIdx = args.indexOf("-e");
		assert.ok(eIdx >= 0 && args[eIdx + 1]?.endsWith("index.ts"), "显式加载 pi-worker 自身(send_message 工具)");

		const tIdx = args.indexOf("-t");
		assert.equal(args[tIdx + 1], "read,bash,edit,write,send_message", "工具白名单:通信 + 基础工作面");
	});

	test("charter 经 append-system-prompt 注入", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			sessionDir: "/repo/.pi/worker/sessions",
			id: "pi-worker-a#123abc",
			name: "a",
		});
		const idx = args.indexOf("--append-system-prompt");
		assert.ok(idx >= 0, "charter 注入通道存在");
		const charter = args[idx + 1] ?? "";
		assert.ok(charter.includes("worker「a」"), "含身份");
		assert.ok(charter.includes("四要素"), "含交付契约");
		assert.ok(charter.includes("回执"), "含先回执再执行");
		assert.ok(charter.includes("/repo/.pi/worker/sessions"), "含审计路径");
	});

	test("model/thinking 参数透传,charter 不重复", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			sessionDir: "/repo/.pi/worker/sessions",
			id: "pi-worker-a#123abc",
			name: "a",
			model: "provider/m",
			thinking: "high",
		});
		assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "provider/m");
		assert.ok(args.includes("--thinking") && args[args.indexOf("--thinking") + 1] === "high");
		// charter 只注入一次
		assert.equal(args.filter((a) => a === "--append-system-prompt").length, 1);
	});
});

describe("buildWorkerCharter", () => {
	test("治理契约自含:不依赖父 AGENTS.md(子进程 --no-context-files)", () => {
		const charter = buildWorkerCharter({
			name: "a",
			id: "pi-worker-a#123abc",
			sessionDir: "/repo/.pi/worker/sessions",
		});
		assert.ok(charter.includes("四要素"), "交付呈报契约");
		assert.ok(charter.includes("先回执"), "先回执再执行");
		assert.ok(charter.includes("收紧输入重派"), "失败归因:先检查输入");
		assert.ok(charter.includes("repo 产物与测试结果"), "事实核验优先级");
	});
});
