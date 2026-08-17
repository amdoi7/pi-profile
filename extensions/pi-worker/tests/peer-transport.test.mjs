import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPeerMessage, probeSocket, sendPeerMessage, socketPathFor, startPeerServer } from "../src/transport.ts";

const msg = (text, over = {}) => ({
	from: { sessionId: "sender-1", name: "sender", cwd: "/repo" },
	text,
	mode: "followUp",
	ts: 1,
	...over,
});

/** 测试用 socket 路径:tmpdir 下唯一名(避免与固定 socketDir 冲突) */
const sockPath = () => join(mkdtempSync(join(tmpdir(), "pi-peer-t-")), "s.sock");

describe("transport(窄协议 NDJSON:投递→注入→ack 同步往返)", () => {
	test("投递成功:handler 收到原文,ack 在 handler 之后(成功=已注入)", async () => {
		const got = [];
		const path = sockPath();
		const srv = await startPeerServer(path, async (m) => got.push(m));
		await sendPeerMessage(path, msg("同步语义"));
		assert.equal(got.length, 1);
		assert.equal(got[0].text, "同步语义");
		assert.equal(got[0].from.name, "sender");
		srv.close();
	});

	test("peer offline(无 socket)→ 显式失败,无黑洞", async () => {
		await assert.rejects(sendPeerMessage(join(tmpdir(), "pi-peer-no-such.sock"), msg("x")), /peer offline/);
	});

	test("handler 抛错 → 发送方收到「peer rejected: <原因>」(注入失败显形)", async () => {
		const path = sockPath();
		const srv = await startPeerServer(path, async () => {
			throw new Error("session 正忙");
		});
		await assert.rejects(sendPeerMessage(path, msg("x")), /peer rejected: session 正忙/);
		srv.close();
	});

	test("并发多连接:各自独立 ack,互不串线", async () => {
		const path = sockPath();
		const got = [];
		const srv = await startPeerServer(path, async (m) => {
			await new Promise((r) => setTimeout(r, 20));
			got.push(m.text);
		});
		await Promise.all([0, 1, 2, 3, 4].map((i) => sendPeerMessage(path, msg(`m${i}`))));
		assert.deepEqual([...got].sort(), ["m0", "m1", "m2", "m3", "m4"]);
		srv.close();
	});

	test("stale 文件接管:非 socket 残留文件被 unlink 后正常 listen", async () => {
		const path = sockPath();
		writeFileSync(path, "stale"); // 死进程残留(或脏文件)
		const srv = await startPeerServer(path, async () => {});
		assert.equal(srv.serving, true);
		await sendPeerMessage(path, msg("ok")); // 接管后可用
		srv.close();
	});

	test("活进程冲突 → 退让(serving=false,不抢 socket);退让方 close 无害", async () => {
		const path = sockPath();
		const a = await startPeerServer(path, async () => {});
		const b = await startPeerServer(path, async () => {});
		assert.equal(a.serving, true);
		assert.equal(b.serving, false);
		b.close(); // 不得影响 a
		await sendPeerMessage(path, msg("仍通"));
		a.close();
		assert.equal(await probeSocket(path), false, "close 后 socket 移除");
	});

	test("isPeerMessage 形状校验:缺字段/mode 非法拒绝(无版本概念,形状即契约)", () => {
		assert.ok(isPeerMessage(msg("x")));
		assert.ok(isPeerMessage(msg("x", { mode: "steer" })));
		assert.ok(isPeerMessage(msg("x", { mode: "quiet" })));
		assert.ok(!isPeerMessage({ ...msg("x"), mode: "bogus" }));
		assert.ok(!isPeerMessage({ from: { sessionId: "a" }, text: "x" })); // 缺 mode
		assert.ok(!isPeerMessage({ from: { sessionId: "a" }, mode: "followUp" })); // 缺 text
		assert.ok(!isPeerMessage(null));
	});

	test("socketPathFor 短路径:macOS sun_path 104 上限内", () => {
		const p = socketPathFor("01a00180-8a4b-7cb9-90a3-01c1b4aa3375");
		assert.ok(p.length < 100, `路径过长: ${p}`);
	});
});
