import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../index.ts";
import { probeSocket, queryPeer, sendPeerMessage, socketPathFor } from "../src/transport.ts";

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
			getSessionName: () => "smoke",
			getSessionFile: () => null,
		},
	};
	return { pi, ctx, captured };
}

describe("index(接线冒烟:注册面 + 会话生命周期 + 收信注入,真 socket)", () => {
	test("加载注册 pi_peer 工具与 pi-peer 渲染器;session_start 后 who 可答;shutdown 后 socket 消失", async () => {
		process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-idx-"));
		const sessionId = "smoke-0001-4000-8000-abcdefabcdef";
		const { pi, ctx, captured } = host(sessionId);
		extension(pi);
		assert.ok(captured.tools.pi_peer, "工具注册在加载期(session 前可见 schema)");
		assert.ok(captured.renderers["pi-peer"], "收件渲染器注册在加载期");

		await captured.handlers.session_start({}, ctx);
		const sock = socketPathFor(sessionId);
		const r = await queryPeer(sock);
		assert.equal(r.status, "ok", "session_start 即刻在场,who 可答");
		assert.equal(r.who.name, "smoke");
		assert.equal(r.who.cwd, "/repo");

		// 收信注入:followUp 直译 deliverAs 并唤醒;quiet 无 opts(留痕不唤醒)
		await sendPeerMessage(sock, { from: { sessionId: "s2", name: "other", cwd: "/x" }, text: "hello", mode: "followUp", ts: 1 });
		await sendPeerMessage(sock, { from: { sessionId: "s2" }, text: "receipt", mode: "quiet", ts: 2 });
		assert.equal(captured.sent.length, 2, "ack 前已接管注入");
		assert.equal(captured.sent[0].msg.customType, "pi-peer");
		assert.equal(captured.sent[0].msg.details.text, "hello", "原文入 details 供渲染卡");
		assert.deepEqual(captured.sent[0].opts, { deliverAs: "followUp", triggerTurn: true });
		assert.equal(captured.sent[1].opts, undefined, "quiet 不唤醒");

		captured.handlers.session_shutdown();
		assert.ok(!existsSync(sock), "shutdown 关闭并移除 socket(即从名册消失)");
		assert.equal(await probeSocket(sock), false);
	});
});
