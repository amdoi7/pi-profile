import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanWorkerSessions } from "../src/recovery.ts";

/**
 * 启动恢复扫描:worker-sessions 目录即 registry(session jsonl = single source of truth)。
 * 解析委托 pi 原生 SessionManager(/resume 同路径);本层边界 = worker 身份判定 + skipped 声明。
 */

function fixture(dir, file, lines) {
	writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const HEADER = { type: "session", version: 3, id: "uuid-1", timestamp: "2026-08-12T10:00:00.000Z", cwd: "/repo" };
const INFO = (name) => ({ type: "session_info", id: "k1", parentId: null, timestamp: "2026-08-12T10:00:01.000Z", name });
const MSG = { type: "message", id: "m1", parentId: null, timestamp: "2026-08-12T10:00:02.000Z", message: { role: "user", content: "t" } };

describe("scanWorkerSessions(jsonl → 遗留 worker 身份,native SessionManager 解析)", () => {
	test("有效 worker session:id 取自 session_info name(--name 写入),显示名取 id 的 name 段,createdAt 取 header timestamp", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-rec-"));
		fixture(dir, "a.jsonl", [HEADER, INFO("pi-worker-hank#0123456789ab"), MSG]);
		const { sessions, skipped } = await scanWorkerSessions(dir);
		assert.deepEqual(skipped, []);
		assert.equal(sessions.length, 1);
		const s = sessions[0];
		assert.equal(s.id, "pi-worker-hank#0123456789ab");
		assert.equal(s.name, "hank");
		assert.equal(s.sessionFile, join(dir, "a.jsonl"));
		assert.equal(s.createdAt, Date.parse("2026-08-12T10:00:00.000Z"));
		assert.ok(s.updatedAt >= s.createdAt, "updatedAt = 最后活动时间(native modified)");
	});

	test("目录不存在 → 空结果(无遗留是合法态,不报错)", async () => {
		const { sessions, skipped } = await scanWorkerSessions(join(tmpdir(), `piw-rec-nonexistent-${Date.now()}`));
		assert.deepEqual(sessions, []);
		assert.deepEqual(skipped, []);
	});

	test("无 session_info / name 不匹配 worker id / 非 json → skipped 列文件名(丢弃范围显式,不静默)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-rec-"));
		fixture(dir, "no-info.jsonl", [HEADER, MSG]);
		fixture(dir, "not-worker.jsonl", [HEADER, INFO("随便一个名字"), MSG]);
		writeFileSync(join(dir, "garbage.jsonl"), "not json\n{broken\n");
		const { sessions, skipped } = await scanWorkerSessions(dir);
		assert.deepEqual(sessions, []);
		assert.deepEqual([...skipped].sort(), ["garbage.jsonl", "no-info.jsonl", "not-worker.jsonl"]);
	});

	test("非 jsonl 文件不进扫描面;多文件按 createdAt 排序(确定性)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-rec-"));
		writeFileSync(join(dir, "notes.txt"), "ignore me");
		fixture(dir, "b.jsonl", [HEADER, INFO("pi-worker-b#bbbbbbbbbbbb")]);
		fixture(dir, "a.jsonl", [{ ...HEADER, timestamp: "2026-08-11T09:00:00.000Z" }, INFO("pi-worker-a#aaaaaaaaaaaa")]);
		const { sessions, skipped } = await scanWorkerSessions(dir);
		assert.deepEqual(skipped, []);
		assert.deepEqual(sessions.map((s) => s.name), ["a", "b"]);
	});

	test("无 session header → native 判非 session → skipped(「什么算 session」由上游裁决,不本地发明)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-rec-"));
		fixture(dir, "c.jsonl", [
			{ type: "model_change", id: "x", parentId: null, timestamp: "2026-08-12T10:00:00.500Z" },
			INFO("pi-worker-c#cccccccccccc"),
		]);
		const { sessions, skipped } = await scanWorkerSessions(dir);
		assert.deepEqual(sessions, []);
		assert.deepEqual(skipped, ["c.jsonl"]);
	});
});

describe("ownership(同 cwd 多窗口:按父 pid 命名空间判定归属)", () => {
	const OWN = (pid) => ({ pid, pidAlive: (p) => p === 111 }); // 111 活,222 死

	function ownedFixture(base, sub, file, name, extra = []) {
		const dir = sub ? join(base, sub) : base;
		mkdirSync(dir, { recursive: true });
		fixture(dir, file, [HEADER, INFO(name), MSG, ...extra]);
	}

	test("本实例目录 → 恢复;活他窗口目录 → held 不恢复;死他窗口目录 → 孤儿恢复;平铺(未知归属)→ 恢复", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-own-"));
		ownedFixture(dir, null, "flat.jsonl", "pi-worker-flat#aaaaaaaaaaaa");
		ownedFixture(dir, "p999", "mine.jsonl", "pi-worker-mine#bbbbbbbbbbbb");
		ownedFixture(dir, "p111", "live.jsonl", "pi-worker-live#cccccccccccc");
		ownedFixture(dir, "p222", "dead.jsonl", "pi-worker-dead#dddddddddddd");
		const { sessions, heldElsewhere } = await scanWorkerSessions(dir, { pid: 999, pidAlive: OWN(999).pidAlive });
		assert.deepEqual(sessions.map((s) => s.name).sort(), ["dead", "flat", "mine"], "mine+flat+孤儿恢复");
		assert.deepEqual(heldElsewhere, ["pi-worker-live#cccccccccccc"], "活窗口持有显式声明");
	});

	test("collect 标记:session 尾部 pi-worker-collected 条目不恢复(进 collected 声明)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-col-"));
		ownedFixture(dir, null, "done.jsonl", "pi-worker-done#eeeeeeeeeeee", [
			{ type: "custom", customType: "pi-worker-collected", id: "c9", parentId: null, timestamp: "t", data: { verdict: "通过" } },
		]);
		ownedFixture(dir, null, "live.jsonl", "pi-worker-live#ffffffffffff");
		const { sessions, collected } = await scanWorkerSessions(dir, { pid: 999, pidAlive: () => false });
		assert.deepEqual(sessions.map((s) => s.name), ["live"], "已收起不恢复");
		assert.deepEqual(collected, ["done.jsonl"], "收起范围显式声明");
	});

	test("无 ownership 参数(兼容调用)→ 全量扫描平铺与子目录", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-noown-"));
		ownedFixture(dir, null, "flat.jsonl", "pi-worker-flat#aaaaaaaaaaaa");
		ownedFixture(dir, "p111", "sub.jsonl", "pi-worker-sub#bbbbbbbbbbbb");
		const { sessions } = await scanWorkerSessions(dir);
		assert.deepEqual(sessions.map((s) => s.name).sort(), ["flat", "sub"]);
	});
});
