import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPeers, resolvePeer } from "../src/roster.ts";
import { socketDir, socketPathFor, startPeerServer } from "../src/transport.ts";

/** 每测试独立 socket 目录(socketDir 每次调用读 env) */
const CWD = "/repo";
const isolate = () => {
	process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-ro-"));
	const dir = socketDir(CWD);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const identity = (over = {}) => ({ sessionId: "aaaa-bbbb", startedAt: 1, ...over });
const serve = (id) => startPeerServer(socketPathFor(id.sessionId, CWD), { who: () => id, deliver: async () => {} });

describe("roster(socket 目录即名册,零缓存)", () => {
	test("discover:活 server 列出(排除自己,新开张在前);身份来自 who 应答", async () => {
		isolate();
		const old = identity({ sessionId: "old-old-old", startedAt: 100 });
		const young = identity({ sessionId: "new-new-new", startedAt: 200 });
		const me = identity({ sessionId: "me-me-me", startedAt: 300 });
		const s1 = await serve(old);
		const s2 = await serve(young);
		const s3 = await serve(me);
		const alive = await discoverPeers("me-me-me", CWD);
		assert.deepEqual(alive.map((p) => p.sessionId), ["new-new-new", "old-old-old"], "排除自己,按 startedAt 降序");
		s1.close();
		s2.close();
		s3.close();
	});

	test("尸体 .sock(拒连)即扫即清——内核真相,活进程的 socket 不会拒连,无误杀", async () => {
		const dir = isolate();
		writeFileSync(join(dir, "corpse-1234-abcdef1234.sock"), ""); // 无进程持有
		const live = identity({ sessionId: "live-live" });
		const s = await serve(live);
		const alive = await discoverPeers("me", CWD);
		assert.deepEqual(alive.map((p) => p.sessionId), ["live-live"]);
		assert.ok(!readdirSync(dir).includes("corpse-1234-abcdef1234.sock"), "尸体文件已回收");
		s.close();
	});

	// 能连上就说明监听进程还活着 → 不删文件；也不向调用方报数（零可行动性的遥测）。
	test("mute socket(可连不应答):不列出、不回收、也不上报", async () => {
		const dir = isolate();
		const mutePath = join(dir, "mute-1234-abcdef1234.sock");
		const silent = createServer(() => {});
		await new Promise((r) => silent.listen(mutePath, r));
		const query = (p) => import("../src/transport.ts").then((t) => t.queryPeer(p, 100));
		const alive = await discoverPeers("me", CWD, query);
		assert.deepEqual(alive, []);
		assert.ok(readdirSync(dir).includes("mute-1234-abcdef1234.sock"), "不确定的文件不动");
		silent.close();
	});

	// 一个会话走 symlink 进来、另一个走真路径,仍然是同一个目录——否则彼此静默隐身。
	test("分区键走 canonical 路径:symlink 与真路径同一名册", () => {
		const real = mkdtempSync(join(tmpdir(), "pi-peer-real-"));
		const link = join(mkdtempSync(join(tmpdir(), "pi-peer-link-")), "alias");
		symlinkSync(real, link);
		assert.equal(socketDir(link), socketDir(real));
		assert.equal(socketDir(`${real}/`), socketDir(real), "尾斜杠同一目录");
	});

	// 只和同目录会话通信是结构保证(socket 目录按 cwd 分区),不是运行期过滤。
	test("别的目录的会话根本不在名册里", async () => {
		isolate();
		const here = identity({ sessionId: "same-dir-01" });
		const elsewhere = identity({ sessionId: "other-dir-1" });
		const a = await startPeerServer(socketPathFor(here.sessionId, CWD), { who: () => here, deliver: async () => {} });
		mkdirSync(socketDir("/elsewhere"), { recursive: true });
		const b = await startPeerServer(socketPathFor(elsewhere.sessionId, "/elsewhere"), { who: () => elsewhere, deliver: async () => {} });
		assert.deepEqual((await discoverPeers("me", CWD)).map((p) => p.sessionId), ["same-dir-01"]);
		assert.deepEqual((await discoverPeers("me", "/elsewhere")).map((p) => p.sessionId), ["other-dir-1"]);
		a.close();
		b.close();
	});

	test("目录不存在 = 从未有 peer 上线,空名册不抛", async () => {
		process.env.PI_PEER_DIR = join(tmpdir(), `pi-peer-never-${Date.now()}`);
		assert.deepEqual(await discoverPeers("me", CWD), []);
	});
});

describe("resolvePeer(sessionId 前缀寻址)", () => {
	const peer = (over = {}) => identity(over);

	test("前缀命中唯一会话;全 id 也是前缀", () => {
		const peers = [peer({ sessionId: "aaaaaaaa-1" }), peer({ sessionId: "bbbbbbbb-2" })];
		const byPrefix = resolvePeer(peers, "aaaaaaaa");
		assert.ok(byPrefix.ok && byPrefix.peer.sessionId === "aaaaaaaa-1", "前缀命中");
		const byFull = resolvePeer(peers, "bbbbbbbb-2");
		assert.ok(byFull.ok && byFull.peer.sessionId === "bbbbbbbb-2", "全 id 命中");
	});

	// 未命中只报事实：当前名册由工具层随错误交回（它手里就有），roster 不猜下一步。
	test("未找到/歧义:未找到报目标本身，歧义列候选", () => {
		const peers = [peer({ sessionId: "aaaaaaaa-1" }), peer({ sessionId: "aaaaaaaa-2" })];
		const miss = resolvePeer(peers, "ghost");
		assert.ok(!miss.ok && miss.reason.includes("no live peer matching") && miss.reason.includes("ghost"));
		const ambi = resolvePeer(peers, "aaaa");
		assert.ok(!ambi.ok && ambi.reason.includes("ambiguous") && ambi.reason.includes("aaaaaaaa"), "歧义列候选短码");
	});
});
