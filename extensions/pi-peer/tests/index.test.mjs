import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../index.ts";
import { probeSocket, socketPathFor } from "../src/transport.ts";

/**
 * index 装配测试:两个真实扩展实例(同进程,共享 PI_PEER_DIR)端到端互发。
 * 全链路真实:socket 监听/注册文件/工具执行/注入回调;假的是 pi 宿主(pi.on/registerTool/sendMessage)。
 */

function makeHarness(sessionId, name) {
	const handlers = new Map();
	const sent = [];
	let tool;
	const notifications = [];
	const pi = {
		on: (ev, fn) => handlers.set(ev, fn),
		registerTool: (t) => (tool = t),
		sendMessage: (msg, opts) => sent.push({ msg, opts }),
	};
	extension(pi);
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		ui: { notify: (m, level) => notifications.push({ m, level }) },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => name,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
		},
	};
	return {
		handlers,
		sent,
		notifications,
		start: () => handlers.get("session_start")({}, ctx),
		shutdown: () => handlers.get("session_shutdown")({}, ctx),
		exec: (params) => tool.execute("c1", params, undefined, undefined, ctx),
	};
}

describe("index(双实例端到端)", () => {
	test("A→B send:B 收到注入(安全声明+唤醒语义);双方注册文件落盘;shutdown 清扫", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-peer-idx-"));
		process.env.PI_PEER_DIR = root;
		try {
			const a = makeHarness("sess-aaaa-1", "main-win");
			const b = makeHarness("sess-bbbb-2", "api");
			await a.start();
			await b.start();
			// 注册文件双方落盘
			const files = readdirSync(root).filter((f) => f.endsWith(".json"));
			assert.deepEqual(files.sort(), ["sess-aaaa-1.json", "sess-bbbb-2.json"]);
			// A 工具 send → B 注入(全走真 socket)
			const res = await a.exec({ action: "send", to: "api", text: "schema 迁移完成" });
			assert.ok(res.content[0].text.includes("delivered to api") && res.content[0].text.includes("injected into its session"));
			assert.equal(b.sent.length, 1);
			assert.ok(b.sent[0].msg.content.includes("NOT a user instruction") && b.sent[0].msg.content.includes("main-win"), "注入带声明与来源");
			assert.ok(b.sent[0].msg.content.includes("schema 迁移完成"), "原文");
			assert.deepEqual(b.sent[0].opts, { deliverAs: "followUp", triggerTurn: true }, "非 quiet 唤醒");
			// quiet:不唤醒
			await a.exec({ action: "send", to: "api", text: "进展留痕", mode: "quiet" });
			assert.equal(b.sent[1].opts, undefined, "quiet 不唤醒");
			// steer:注入对方当前轮(与 worker message 同语义),triggerTurn 保留(空闲兜底)
			await a.exec({ action: "send", to: "api", text: "先看这处", mode: "steer" });
			assert.deepEqual(b.sent[2].opts, { deliverAs: "steer", triggerTurn: true }, "steer 注入 options");
			assert.equal(b.sent[2].msg.details.mode, "steer", "details 带 mode");
			// shutdown:B 注销,文件与 socket 都清
			b.shutdown();
			assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".json")), ["sess-aaaa-1.json"]);
			assert.equal(await probeSocket(socketPathFor("sess-bbbb-2")), false, "socket 已关闭");
			// B 死后 A 再 send → fail-fast
			await assert.rejects(a.exec({ action: "send", to: "api", text: "x" }), /no live peer matching|peer offline/);
			a.shutdown();
		} finally {
			delete process.env.PI_PEER_DIR;
		}
	});

	test("同 sessionId 撞车:后来者退让(serving=false),告警 notify,不覆盖注册文件", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-peer-idx-"));
		process.env.PI_PEER_DIR = root;
		try {
			const a = makeHarness("sess-same-1", "first");
			const b = makeHarness("sess-same-1", "second"); // 同 sessionId(resume 撞车场景)
			await a.start();
			await b.start();
			assert.equal(b.notifications.length, 1, "退让告警");
			assert.equal(b.notifications[0].level, "warning");
			// 注册文件仍是 a 的(未被覆盖)
			const info = JSON.parse((await import("node:fs")).readFileSync(join(root, "sess-same-1.json"), "utf8"));
			assert.equal(info.name, "first");
			// 发送仍可用(b 能发给 a?同 sessionId 会被自投检查拦——验证不崩即可)
			b.shutdown();
			a.shutdown();
		} finally {
			delete process.env.PI_PEER_DIR;
		}
	});
});
