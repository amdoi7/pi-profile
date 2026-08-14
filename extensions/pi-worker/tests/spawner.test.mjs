import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSpawnArgs } from "../src/spawner.ts";
import { buildWorkerPreamble } from "../src/contract.ts";

/** spawn 参数组装单测:pi CLI 注入面(瘦身 + preamble)不回归。 */
describe("buildSpawnArgs", () => {
	test("瘦身注入:AGENTS.md 链/skills 由 pi 机制加载(与父同);extensions 隔离 + 工具白名单", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			id: "pi-worker-a#123abc",
			name: "a",
		});
		assert.ok(!args.includes("--no-skills"), "skills 由 pi 机制加载");
		assert.ok(!args.includes("--no-context-files"), "AGENTS.md 链由 pi 机制加载(与父同),不进 preamble");
		assert.ok(args.includes("--no-extensions"), "子进程不加载父扩展列表");

		const eIdx = args.indexOf("-e");
		assert.ok(eIdx >= 0 && args[eIdx + 1]?.endsWith("index.ts"), "显式加载 pi-worker 自身(send_message 工具)");

		const tIdx = args.indexOf("-t");
		assert.equal(args[tIdx + 1], "read,bash,edit,write,send_message", "工具白名单:通信 + 基础工作面");
	});

	test("preamble 经 append-system-prompt 注入", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			id: "pi-worker-a#123abc",
			name: "a",
		});
		const idx = args.indexOf("--append-system-prompt");
		assert.ok(idx >= 0, "preamble 注入通道存在");
		const preamble = args[idx + 1] ?? "";
		assert.ok(preamble.includes("worker「a」"), "含身份");
		assert.ok(preamble.includes("先回执"), "含先回执契约");
	});

	test("model/thinking 参数透传,preamble 不重复", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			id: "pi-worker-a#123abc",
			name: "a",
			model: "provider/m",
			thinking: "high",
		});
		assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "provider/m");
		assert.ok(args.includes("--thinking") && args[args.indexOf("--thinking") + 1] === "high");
		// preamble 只注入一次
		assert.equal(args.filter((a) => a === "--append-system-prompt").length, 1);
	});

	test("run 合约 tools 透传 -t(只读审计面);缺省白名单由既有测试守卫", () => {
		const args = buildSpawnArgs({
			cwd: "/repo",
			id: "pi-worker-a#123abc",
			name: "a",
			tools: "find,ls,read",
		});
		const tIdx = args.indexOf("-t");
		assert.equal(args[tIdx + 1], "find,ls,read", "tools 覆盖缺省白名单");
	});

	test("PI_WORKER_PREAMBLE_FILE 整体替换 preamble(拟合循环 A/B 钩子)", () => {
		const f = join(tmpdir(), `pi-worker-preamble-${process.pid}.txt`);
		writeFileSync(f, "OLD CHARTER\n");
		process.env.PI_WORKER_PREAMBLE_FILE = f;
		try {
			const args = buildSpawnArgs({ cwd: "/repo", id: "pi-worker-a#123abc", name: "a" });
			const idx = args.indexOf("--append-system-prompt");
			assert.equal(args[idx + 1], "OLD CHARTER", "env 文件内容替换 buildWorkerPreamble 输出");
		} finally {
			delete process.env.PI_WORKER_PREAMBLE_FILE;
			rmSync(f, { force: true });
		}
	});
});

describe("buildWorkerPreamble", () => {
	test("worker 特有交互契约自含;四要素/治理由 pi 机制加载(AGENTS.md),不进 preamble", () => {
		const preamble = buildWorkerPreamble({
			name: "a",
			id: "pi-worker-a#123abc",
		});
		assert.ok(preamble.includes("先回执"), "先回执契约");
		assert.ok(!preamble.includes("四要素"), "四要素在质量契约(机制加载),不重复");
		assert.ok(!preamble.includes("AGENTS.md"), "机制(AGENTS.md 加载)不写成 prompt");
	});
});

test("spawn 归属:--session-dir 带父 pid 命名空间(同 cwd 多 TUI 窗口不互相认领)", () => {
	const args = buildSpawnArgs({ cwd: "/repo", id: "pi-worker-a#123abc", name: "a" });
	const i = args.indexOf("--session-dir");
	assert.equal(args[i + 1], `/repo/.pi/worker-sessions/p${process.pid}`, "归属 = 当前父进程 pid");
});
