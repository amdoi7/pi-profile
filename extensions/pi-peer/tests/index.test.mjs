import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../index.ts";
import { probeSocket, queryPeer, sendPeerMessage, socketPathFor, startPeerServer } from "../src/transport.ts";

/** 假 pi 宿主:抓注册面与注入面;假 ctx:无 UI headless 会话。 */
function host(sessionId) {
	const captured = { tools: {}, renderers: {}, handlers: {}, sent: [] };
	const pi = {
		registerTool: (t) => (captured.tools[t.name] = t),
		registerMessageRenderer: (type, fn) => (captured.renderers[type] = fn),
		on: (event, fn) => (captured.handlers[event] = fn),
		sendMessage: (msg, opts) => captured.sent.push({ msg, opts }),
	};
	const ctx = {
		cwd: "/repo",
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => null,
		},
	};
	return { pi, ctx, captured };
}

describe("index(接线冒烟:注册面 + 会话生命周期 + 收信注入,真 socket)", () => {
	test("加载注册 peer 工具与 pi-peer 渲染器;session_start 后 who 可答;shutdown 后 socket 消失", async () => {
		process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-idx-"));
		const sessionId = "smoke-0001-4000-8000-abcdefabcdef";
		const { pi, ctx, captured } = host(sessionId);
		extension(pi);
		assert.ok(captured.tools.peer_list && captured.tools.peer_send, "两个工具都注册在加载期(session 前可见 schema)");
		assert.ok(captured.renderers["pi-peer"], "收件渲染器注册在加载期");

		await captured.handlers.session_start({}, ctx);
		const sock = socketPathFor(sessionId, "/repo");
		const r = await queryPeer(sock);
		assert.equal(r.status, "ok", "session_start 即刻在场,who 可答");
		assert.equal(r.who.sessionId, sessionId, "同目录内 id 即全部身份");
		assert.ok(existsSync(sock.replace(/\.sock$/, ".heartbeat")), "serving 即写心跳(身份在服务)");

		// 收信注入:pi-send 语义 steer（在跑注入工具边界后；不在跑 triggerTurn 起新轮）。
		await sendPeerMessage(sock, { from: "s2-other-0001", text: "hello", ts: 1 });
		await sendPeerMessage(sock, { from: "s2-other-0001", text: "again", ts: 2 });
		assert.equal(captured.sent.length, 2, "ack 前已接管注入");
		assert.equal(captured.sent[0].msg.customType, "pi-peer");
		assert.equal(captured.sent[0].msg.details.text, "hello", "原文入 details 供渲染卡");
		assert.deepEqual(captured.sent[0].opts, { deliverAs: "steer", triggerTurn: true });
		assert.deepEqual(captured.sent[1].opts, { deliverAs: "steer", triggerTurn: true });

		captured.handlers.session_shutdown();
		assert.ok(!existsSync(sock), "shutdown 关闭并移除 socket(即从名册消失)");
		assert.ok(!existsSync(sock.replace(/\.sock$/, ".heartbeat")), "shutdown 一并移除心跳");
		assert.equal(await probeSocket(sock), false);
	});

	// 回归(2026-09-10,fork/resume):心跳 = "我在服务此身份",仅 serving 方代写。
	// fork 双活时输家不再写同一心跳文件(pid 不翻摆);现状(无条件写)此测试应红。
	test("让位(他人持有身份)不写心跳:输家不代写,pid 不翻摆", async () => {
		process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-idx-"));
		const sessionId = "yield-0001-4000-8000-abcdefabcdef";
		const { pi, ctx, captured } = host(sessionId);
		extension(pi);
		const sock = socketPathFor(sessionId, "/repo");
		const hbPath = sock.replace(/\.sock$/, ".heartbeat");
		const opponent = await startPeerServer(sock, {
			who: () => ({ sessionId, startedAt: 1 }),
			deliver: async () => {},
		});
		await captured.handlers.session_start({}, ctx);
		assert.ok(!existsSync(hbPath), "让位:输家不写心跳");
		opponent.close();
		captured.handlers.session_shutdown();
	});
});
