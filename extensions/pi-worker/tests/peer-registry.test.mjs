import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPeers, registerSelf, resolvePeer, unregisterSelf } from "../src/registry.ts";

const NOW = 1_800_000_000_000;
const peer = (partial) => ({
	v: 2,
	sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	name: "agent-3f",
	cwd: "/repo",
	socketPath: `/tmp/fake-${Math.random().toString(36).slice(2)}.sock`,
	startedAt: NOW - 60_000,
	...partial,
});

describe("registry(rendezvous 注册/探活/清扫)", () => {
	test("registerSelf 原子落盘 → listPeers 列出;自己排除;unregisterSelf 移除", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-peer-reg-"));
		const me = peer({ sessionId: "me-me-me-me-me-me" });
		const other = peer({ sessionId: "other-other-other", name: "api-worker" });
		registerSelf(root, me);
		registerSelf(root, other);
		const { alive } = await listPeers(root, me.sessionId, async () => true);
		assert.deepEqual(alive.map((p) => p.sessionId), ["other-other-other"], "只列他人");
		unregisterSelf(root, other.sessionId);
		assert.deepEqual((await listPeers(root, me.sessionId, async () => true)).alive, []);
	});

	test("读时 socket 探活:不可达不列出且文件即扫即清(连接即真相,无心跳无 pid)", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-peer-reg-"));
		registerSelf(root, peer({ sessionId: "dead-dead-dead", socketPath: "/tmp/dead.sock" }));
		registerSelf(root, peer({ sessionId: "live-live-live", socketPath: "/tmp/live.sock" }));
		const probe = async (p) => p === "/tmp/live.sock";
		const { alive } = await listPeers(root, "me", probe);
		assert.deepEqual(alive.map((p) => p.sessionId), ["live-live-live"]);
		assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".json")), ["live-live-live.json"], "死文件已清扫");
	});

	test("损坏/旧版(v1)注册文件:跳过并计数(不静默),活文件不受影响", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-peer-reg-"));
		writeFileSync(join(root, "broken.json"), "{oops\n");
		writeFileSync(join(root, "legacy.json"), JSON.stringify({ v: 1, sessionId: "old" })); // v1 直接判损坏
		registerSelf(root, peer({ sessionId: "good-good-good" }));
		const { alive, corrupt } = await listPeers(root, "me", async () => true);
		assert.equal(corrupt, 2);
		assert.deepEqual(alive.map((p) => p.sessionId), ["good-good-good"]);
	});
});

describe("resolvePeer(name/sessionId 寻址)", () => {
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
