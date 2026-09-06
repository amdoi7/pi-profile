import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPeers, resolvePeer } from "../src/roster.ts";
import { socketDir, socketPathFor, startPeerServer } from "../src/transport.ts";
import { writeHeartbeat } from "../src/process.ts";

/** 每测试独立 socket 目录(socketDir 每次调用读 env) */
const CWD = "/repo";
const isolate = () => {
	process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-ro-"));
	const dir = socketDir(CWD);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const identity = (over = {}) => ({ sessionId: "aaaa-bbbb", startedAt: 1, ...over });
/** 建 server + 写新鲜心跳(名册成员 = heartbeat) */
const serve = async (id) => {
	const sockPath = socketPathFor(id.sessionId, CWD);
	writeHeartbeat(sockPath.replace(/\.sock$/, ".heartbeat"), process.pid);
	return startPeerServer(sockPath, { who: () => id, deliver: async () => {} });
};

describe("roster(socket 目录即名册,零缓存)", () => {
	test("discover:活 server 列出(排除自己,新开张在前);身份来自 who 应答", async () => {
		isolate();
		const old = identity({ sessionId: "old-old-old", startedAt: 100 });
		const young = identity({ sessionId: "new-new-new", startedAt: 200 });
		const me = identity({ sessionId: "me-me-me", startedAt: 300 });
		const s1 = await serve(old);
		const s2 = await serve(young);
		const s3 = await serve(me);
		const roster = await discoverPeers("me-me-me", CWD);
		assert.deepEqual(roster.alive.map((p) => p.sessionId), ["new-new-new", "old-old-old"], "排除自己,按 startedAt 降序");
		assert.deepEqual(roster.suspended, [], "无挂起位");
		assert.deepEqual(roster.unknown, [], "无 unknown 位");
		s1.close();
		s2.close();
		s3.close();
	});

	test("尸体 .sock(拒连)即扫即清——内核真相,活进程的 socket 不会拒连,无误杀", async () => {
		const dir = isolate();
		writeFileSync(join(dir, "corpse-1234-abcdef1234.sock"), ""); // 无进程持有
		const live = identity({ sessionId: "live-live" });
		const s = await serve(live);
		const roster = await discoverPeers("me", CWD);
		assert.deepEqual(roster.alive.map((p) => p.sessionId), ["live-live"]);
		assert.deepEqual(roster.suspended, []);
		assert.deepEqual(roster.unknown, []);
		assert.ok(!readdirSync(dir).includes("corpse-1234-abcdef1234.sock"), "尸体文件已回收");
		s.close();
	});

	// mute socket:不列为 peer、不回收。观察者用 heartbeat(pid+时间戳)+ kill 0 分类——
	// 心跳过期但进程活 → suspended(显式上报);进程已死 → 尸体清;
	// 无心跳的孤儿 .sock = 旧版本残留 → 一律清(不向后兼容)。
	test("mute socket(可连不应答):心跳过期进程活 → suspended;进程死 → 清尸;无心跳孤儿 → 清", async () => {
		const dir = isolate();
		const mutePath = join(dir, "mute-1234-abcdef1234.sock");
		const silent = createServer(() => {});
		await new Promise((r) => silent.listen(mutePath, r));
		const query = (p) => import("../src/transport.ts").then((t) => t.queryPeer(p, 100));
		// 1) 心跳过期 + 进程活(挂起)→ suspended
		writeFileSync(join(dir, "mute-1234-abcdef1234.heartbeat"), `${process.pid} ${Date.now() - 200_000}\n`);
		const roster = await discoverPeers("me", CWD, query);
		assert.deepEqual(roster.alive, []);
		assert.deepEqual(roster.suspended, [{ path: "mute-1234-abcdef1234.heartbeat", pid: process.pid }], "挂起占位显式上报");
		assert.deepEqual(roster.unknown, []);
		assert.ok(readdirSync(dir).includes("mute-1234-abcdef1234.sock"), "挂起占位不动");
		// 2) 进程已死 → 尸体,连 socket+heartbeat 一并清
		writeFileSync(join(dir, "mute-1234-abcdef1234.heartbeat"), `999999999 ${Date.now()}\n`);
		const roster3 = await discoverPeers("me", CWD, query);
		assert.deepEqual(roster3.suspended, []);
		assert.deepEqual(roster3.unknown, []);
		assert.ok(!readdirSync(dir).includes("mute-1234-abcdef1234.sock"), "尸体 socket 已清");
		assert.ok(!readdirSync(dir).includes("mute-1234-abcdef1234.heartbeat"), "尸体 heartbeat 已清");
		// 3) 无心跳孤儿 .sock(旧版本残留)→ 一律清
		const orphanPath = join(dir, "orphan-1234-abcdef1234.sock");
		writeFileSync(orphanPath, ""); // 无 heartbeat
		const roster4 = await discoverPeers("me", CWD, query);
		assert.deepEqual(roster4.suspended, []);
		assert.deepEqual(roster4.unknown, []);
		assert.ok(!readdirSync(dir).includes("orphan-1234-abcdef1234.sock"), "无心跳孤儿 socket 已清");
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
		const a = await serve(here);
		mkdirSync(socketDir("/elsewhere"), { recursive: true });
		const bSock = socketPathFor(elsewhere.sessionId, "/elsewhere");
		writeHeartbeat(bSock.replace(/\.sock$/, ".heartbeat"), process.pid);
		const b = await startPeerServer(bSock, { who: () => elsewhere, deliver: async () => {} });
		assert.deepEqual((await discoverPeers("me", CWD)).alive.map((p) => p.sessionId), ["same-dir-01"]);
		assert.deepEqual((await discoverPeers("me", "/elsewhere")).alive.map((p) => p.sessionId), ["other-dir-1"]);
		a.close();
		b.close();
	});

	test("目录不存在 = 从未有 peer 上线,空名册不抛", async () => {
		process.env.PI_PEER_DIR = join(tmpdir(), `pi-peer-never-${Date.now()}`);
		const roster = await discoverPeers("me", CWD);
		assert.deepEqual(roster.alive, []);
		assert.deepEqual(roster.suspended, []);
		assert.deepEqual(roster.unknown, []);
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

describe("roster(同 sessionId 多代心跳:reload 前/后)", () => {
	test("同一 sessionId 两代心跳:旧代被清,新代列出;自己的旧代也清但不列", async () => {
		const dir = isolate();
		// 自己的两代:旧代(-old)心跳旧 + socket mute;新代(-new)心跳新 + who ok
		const meOld = "me-old-0001";
		const meNew = "me-new-0001";
		writeFileSync(join(dir, `${meOld}-abcdef.heartbeat`), `${process.pid} ${Date.now() - 200_000}\n`); // 旧心跳
		const silent = createServer(() => {});
		const oldSock = join(dir, `${meOld}-abcdef.sock`);
		await new Promise((r) => silent.listen(oldSock, r)); // 旧 socket mute(无 who 应答)
		writeFileSync(join(dir, `${meNew}-abcdef.heartbeat`), `${process.pid} ${Date.now()}\n`); // 新心跳
		const newSock = join(dir, `${meNew}-abcdef.sock`);
		const srv = await startPeerServer(newSock, { who: () => identity({ sessionId: "me-new-0001-xxxx" }), deliver: async () => {} });

		// selfId 前缀 = me(新旧同前缀)
		const roster = await discoverPeers("me-new-0001-xxxx", CWD);
		assert.deepEqual(roster.alive.map((p) => p.sessionId), [], "自己的新代不列");
		assert.deepEqual(roster.suspended, [], "自己的旧代不列");
		assert.deepEqual(roster.unknown, [], "无 unknown");
		assert.ok(!readdirSync(dir).includes(`${meOld}-abcdef.sock`), "自己的旧代 socket 已清");
		assert.ok(!readdirSync(dir).includes(`${meOld}-abcdef.heartbeat`), "自己的旧代 heartbeat 已清");
		assert.ok(readdirSync(dir).includes(`${meNew}-abcdef.sock`), "自己的新代 socket 保留");
		assert.ok(readdirSync(dir).includes(`${meNew}-abcdef.heartbeat`), "自己的新代 heartbeat 保留");
		srv.close();
		silent.close();
	});

	test("别的会话两代心跳:旧代清,新代(活)列出", async () => {
		const dir = isolate();
		const peerOld = "peerold-0001";
		const peerNew = "peernew-0001";
		writeFileSync(join(dir, `${peerOld}-abcdef.heartbeat`), `999999999 ${Date.now()}\n`); // 旧代:pid 死
		writeFileSync(join(dir, `${peerOld}-abcdef.sock`), "");
		writeFileSync(join(dir, `${peerNew}-abcdef.heartbeat`), `${process.pid} ${Date.now()}\n`); // 新代:活
		const srv = await startPeerServer(join(dir, `${peerNew}-abcdef.sock`), { who: () => identity({ sessionId: "peernew-0001-xxxx" }), deliver: async () => {} });
		const roster = await discoverPeers("me", CWD);
		assert.deepEqual(roster.alive.map((p) => p.sessionId), ["peernew-0001-xxxx"], "新代列出");
		assert.ok(!readdirSync(dir).includes(`${peerOld}-abcdef.sock`), "旧代 socket 已清");
		assert.ok(!readdirSync(dir).includes(`${peerOld}-abcdef.heartbeat`), "旧代 heartbeat 已清");
		srv.close();
	});
});

describe("roster(孤儿回收:代际替代 / 挂起超时,不杀进程)", () => {
	test("同 sessionId 有更新代且 who ok → 旧代(挂起)被回收(socket+heartbeat 清)", async () => {
		const dir = isolate();
		// 同一 sessionId 两代:旧代挂起(心跳过期 + 进程活 + socket mute),新代活(who ok)
		const sid = "orphgen00"; // 同前缀 = 同 sessionId
		writeFileSync(join(dir, `${sid}-aaaa.heartbeat`), `${process.pid} ${Date.now() - 200_000}\n`);
		const oldSilent = createServer(() => {});
		const oldSock = join(dir, `${sid}-aaaa.sock`);
		await new Promise((r) => oldSilent.listen(oldSock, r)); // 旧代 mute(不应答)
		writeFileSync(join(dir, `${sid}-bbbb.heartbeat`), `${process.pid} ${Date.now()}\n`);
		const newSrv = await startPeerServer(join(dir, `${sid}-bbbb.sock`), { who: () => identity({ sessionId: "orphgen00-xxxx" }), deliver: async () => {} });

		const roster = await discoverPeers("me", CWD);
		assert.ok(!readdirSync(dir).includes(`${sid}-aaaa.sock`), "旧代 socket 已回收");
		assert.ok(!readdirSync(dir).includes(`${sid}-aaaa.heartbeat`), "旧代 heartbeat 已回收");
		assert.deepEqual(roster.suspended.map((s) => s.path), [], "回收后不再列 suspended");
		assert.deepEqual(roster.alive.map((p) => p.sessionId), ["orphgen00-xxxx"], "新代列出");
		newSrv.close();
		oldSilent.close();
	});

	test("无替代者的挂起超时(>15min)→ 回收;未超时 → 保留 suspended", async () => {
		const dir = isolate();
		// 超时孤儿:心跳很旧 + 进程活 + socket mute,无新代
		const old = "orphan1-0001";
		writeFileSync(join(dir, `${old}-aaaa.heartbeat`), `${process.pid} ${Date.now() - 20 * 60_000}\n`); // 20min > 15min
		const silent = createServer(() => {});
		await new Promise((r) => silent.listen(join(dir, `${old}-aaaa.sock`), r));
		const roster = await discoverPeers("me", CWD);
		assert.ok(!readdirSync(dir).includes(`${old}-aaaa.sock`), "超时孤儿 socket 已回收");
		assert.ok(!readdirSync(dir).includes(`${old}-aaaa.heartbeat`), "超时孤儿 heartbeat 已回收");
		assert.deepEqual(roster.suspended, [], "已回收,不列");

		// 未超时:心跳 5min 前 + 进程活 → 保留 suspended
		const fresh = "orphan2-0001";
		writeFileSync(join(dir, `${fresh}-bbbb.heartbeat`), `${process.pid} ${Date.now() - 5 * 60_000}\n`); // 5min < 15min
		const silent2 = createServer(() => {});
		await new Promise((r) => silent2.listen(join(dir, `${fresh}-bbbb.sock`), r));
		const roster2 = await discoverPeers("me", CWD);
		assert.deepEqual(roster2.suspended.map((s) => s.path), [`${fresh}-bbbb.heartbeat`], "未超时挂起保留");
		assert.ok(readdirSync(dir).includes(`${fresh}-bbbb.sock`), "未超时 socket 保留");
		silent.close();
		silent2.close();
	});
});
