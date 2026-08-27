import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPeers, resolvePeer } from "../src/roster.ts";
import { socketPathFor, startPeerServer } from "../src/transport.ts";

/** 每测试独立 socket 目录(socketDir 每次调用读 env) */
const isolate = () => (process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-ro-")));

const identity = (over = {}) => ({ sessionId: "aaaa-bbbb", name: "a", cwd: "/repo", startedAt: 1, ...over });
const serve = (id) => startPeerServer(socketPathFor(id.sessionId), { who: () => id, deliver: async () => {} });

describe("roster(socket 目录即名册,零缓存)", () => {
	test("discover:活 server 列出(排除自己,新开张在前);身份来自 who 应答", async () => {
		isolate();
		const old = identity({ sessionId: "old-old-old", name: "elder", startedAt: 100 });
		const young = identity({ sessionId: "new-new-new", name: "younger", startedAt: 200 });
		const me = identity({ sessionId: "me-me-me", name: "self", startedAt: 300 });
		const s1 = await serve(old);
		const s2 = await serve(young);
		const s3 = await serve(me);
		const alive = await discoverPeers("me-me-me");
		assert.deepEqual(alive.map((p) => p.name), ["younger", "elder"], "排除自己,按 startedAt 降序");
		s1.close();
		s2.close();
		s3.close();
	});

	test("尸体 .sock(拒连)即扫即清——内核真相,活进程的 socket 不会拒连,无误杀", async () => {
		const dir = isolate();
		writeFileSync(join(dir, "corpse-1234-abcdef1234.sock"), ""); // 无进程持有
		const live = identity({ sessionId: "live-live", name: "live" });
		const s = await serve(live);
		const alive = await discoverPeers("me");
		assert.deepEqual(alive.map((p) => p.name), ["live"]);
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
		const alive = await discoverPeers("me", query);
		assert.deepEqual(alive, []);
		assert.ok(readdirSync(dir).includes("mute-1234-abcdef1234.sock"), "不确定的文件不动");
		silent.close();
	});

	test("目录不存在 = 从未有 peer 上线,空名册不抛", async () => {
		process.env.PI_PEER_DIR = join(tmpdir(), `pi-peer-never-${Date.now()}`);
		assert.deepEqual(await discoverPeers("me"), []);
	});
});

describe("resolvePeer(name/sessionId 寻址)", () => {
	const peer = (over = {}) => identity(over);

	test("name 精确命中;sessionId 前缀命中;同 cwd 优先于跨目录同名", () => {
		const peers = [
			peer({ sessionId: "aaaaaaaa-1", name: "api", cwd: "/other" }),
			peer({ sessionId: "bbbbbbbb-2", name: "api", cwd: "/repo" }),
		];
		const byName = resolvePeer(peers, "api", "/repo");
		assert.ok(byName.ok && byName.peer.sessionId === "bbbbbbbb-2", "同目录优先");
		const byPrefix = resolvePeer(peers, "aaaaaaaa", "/repo");
		assert.ok(byPrefix.ok && byPrefix.peer.sessionId === "aaaaaaaa-1", "前缀命中");
	});

	test("未找到/歧义:错误带可行动指引(list 或 sessionId 精确指定)", () => {
		const peers = [peer({ sessionId: "aaaaaaaa-1", name: "x", cwd: "/a" }), peer({ sessionId: "bbbbbbbb-2", name: "x", cwd: "/b" })];
		const miss = resolvePeer(peers, "ghost", "/repo");
		assert.ok(!miss.ok && miss.reason.includes("action=list"));
		const ambi = resolvePeer(peers, "x", "/elsewhere");
		assert.ok(!ambi.ok && ambi.reason.includes("ambiguous") && ambi.reason.includes("aaaaaaaa"), "歧义列候选短码");
	});
});
