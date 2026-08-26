import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPeerMessage, probeSocket, queryPeer, sendPeerMessage, socketPathFor, startPeerServer } from "../src/transport.ts";

process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-tr-"));

const msg = (text, over = {}) => ({
	from: { sessionId: "sender-1", name: "sender", cwd: "/repo" },
	text,
	mode: "followUp",
	ts: 1,
	...over,
});

const who = (over = {}) => ({ sessionId: "srv-srv-srv", name: "srv", cwd: "/repo", startedAt: 1, ...over });
/** 缺省 handlers:身份固定,消息丢弃;单测按需覆盖 */
const handlers = (over = {}) => ({ who: () => who(), deliver: async () => {}, ...over });
const sockPath = () => join(mkdtempSync(join(tmpdir(), "pi-peer-t-")), "s.sock");

describe("transport(窄协议 NDJSON:deliver 投递→接管→ack / who 实时身份)", () => {
	test("deliver 成功:handler 收到原文,ack 在 handler 之后(成功=已接管)", async () => {
		const got = [];
		const path = sockPath();
		const srv = await startPeerServer(path, handlers({ deliver: async (m) => void got.push(m) }));
		await sendPeerMessage(path, msg("同步语义"));
		assert.equal(got.length, 1);
		assert.equal(got[0].text, "同步语义");
		assert.equal(got[0].from.name, "sender");
		srv.close();
	});

	test("peer offline(无 socket)→ 显式失败,无黑洞", async () => {
		await assert.rejects(sendPeerMessage(join(tmpdir(), "pi-peer-no-such.sock"), msg("x")), /peer offline/);
	});

	test("deliver handler 抛错 → 发送方收到「peer rejected: <原因>」(注入失败显形)", async () => {
		const path = sockPath();
		const srv = await startPeerServer(path, handlers({ deliver: async () => { throw new Error("session 正忙"); } }));
		await assert.rejects(sendPeerMessage(path, msg("x")), /peer rejected: session 正忙/);
		srv.close();
	});

	test("who:身份实时求值——改名后再问即变(新鲜性不需要维护)", async () => {
		const path = sockPath();
		let name = "before";
		const srv = await startPeerServer(path, handlers({ who: () => who({ name }) }));
		const first = await queryPeer(path);
		assert.equal(first.status, "ok");
		assert.equal(first.who.name, "before");
		name = "after";
		const second = await queryPeer(path);
		assert.equal(second.who.name, "after");
		srv.close();
	});

	test("queryPeer 三态:ok / dead(拒连=尸体)/ mute(可连但不回=不确定)", async () => {
		const okPath = sockPath();
		const srv = await startPeerServer(okPath, handlers());
		assert.equal((await queryPeer(okPath)).status, "ok");
		srv.close();
		assert.equal((await queryPeer(join(tmpdir(), "pi-peer-no-such.sock"))).status, "dead");
		// mute:裸 TCP 服务收连接但永不应答(wedged 进程/异物)
		const mutePath = sockPath();
		const silent = createServer(() => {});
		await new Promise((r) => silent.listen(mutePath, r));
		assert.equal((await queryPeer(mutePath, 100)).status, "mute");
		silent.close();
	});

	test("并发多连接:各自独立 ack,互不串线", async () => {
		const path = sockPath();
		const got = [];
		const srv = await startPeerServer(path, handlers({
			deliver: async (m) => {
				await new Promise((r) => setTimeout(r, 20));
				got.push(m.text);
			},
		}));
		await Promise.all([0, 1, 2, 3, 4].map((i) => sendPeerMessage(path, msg(`m${i}`))));
		assert.deepEqual([...got].sort(), ["m0", "m1", "m2", "m3", "m4"]);
		srv.close();
	});

	test("stale 文件接管:非 socket 残留文件被 unlink 后正常 listen", async () => {
		const path = sockPath();
		writeFileSync(path, "stale"); // 死进程残留(或脏文件)
		const srv = await startPeerServer(path, handlers());
		assert.equal(srv.serving, true);
		await sendPeerMessage(path, msg("ok")); // 接管后可用
		srv.close();
	});

	test("活进程冲突 → 退让(serving=false,不抢 socket);退让方 close 无害", async () => {
		const path = sockPath();
		const a = await startPeerServer(path, handlers());
		const b = await startPeerServer(path, handlers());
		assert.equal(a.serving, true);
		assert.equal(b.serving, false);
		b.close(); // 不得影响 a
		await sendPeerMessage(path, msg("仍通"));
		a.close();
		assert.equal(await probeSocket(path), false, "close 后 socket 移除");
	});

	test("isPeerMessage 形状校验:缺字段/mode 非法拒绝(形状即契约)", () => {
		assert.ok(isPeerMessage(msg("x")));
		assert.ok(isPeerMessage(msg("x", { mode: "steer" })));
		assert.ok(isPeerMessage(msg("x", { mode: "quiet" })));
		assert.ok(!isPeerMessage({ ...msg("x"), mode: "bogus" }));
		assert.ok(!isPeerMessage({ from: { sessionId: "a" }, text: "x" })); // 缺 mode
		assert.ok(!isPeerMessage({ from: { sessionId: "a" }, mode: "followUp" })); // 缺 text
		assert.ok(!isPeerMessage(null));
	});

	test("socketPathFor:sun_path 104 上限内;同毫秒 UUIDv7(长公共前缀)不同 id 不碰撞", () => {
		// UUIDv7 前 12 hex 是时间戳:同毫秒创建的两个会话只差尾部随机位。
		// 裸前缀截断会撞路径 → 后启动方假退让 → 收信静默失联;哈希消歧锁死此洞。
		const a = socketPathFor("01a00180-8a4b-7cb9-90a3-01c1b4aa3375");
		const b = socketPathFor("01a00180-8a4b-7cb9-90a3-01c1b4aa3376");
		assert.ok(a.length < 104, `路径过长: ${a}`);
		assert.notEqual(a, b, "同前缀不同 id 必须映射到不同 socket 路径");
	});
});
