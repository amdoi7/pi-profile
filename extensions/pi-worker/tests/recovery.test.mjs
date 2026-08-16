import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COLLECTED_MARKER, hasCollectedMarker, scanLeftoverSessions } from "../src/recovery.ts";

/**
 * 重启认领扫描:父重启后子进程随父死(stdin EOF 自退),worker jsonl 留在
 * <cwd>/.pi/worker-sessions——扫描把它们认领回 live 记录(send 冷恢复 / collect 清账)。
 * 身份判定委托 pi 原生 SessionManager(与 /resume 同路径);本层边界 = worker 身份
 * 判定 + skipped/collected 声明。
 */

function fixture(dir, file, lines) {
	writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function dirFor(cwd) {
	const dir = join(cwd, ".pi", "worker-sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

const HEADER = { type: "session", version: 3, id: "uuid-1", timestamp: "2026-08-12T10:00:00.000Z", cwd: "/repo" };
const INFO = (name) => ({ type: "session_info", id: "k1", parentId: null, timestamp: "2026-08-12T10:00:01.000Z", name });
const MSG = { type: "message", id: "m1", parentId: null, timestamp: "2026-08-12T10:00:02.000Z", message: { role: "user", content: "t" } };
const COLLECTED = { type: "custom", customType: COLLECTED_MARKER, id: "worker-collect", parentId: null, timestamp: "2026-08-12T10:00:03.000Z", data: {} };

describe("scanLeftoverSessions(重启认领:磁盘 jsonl → 遗留 worker 身份)", () => {
	test("有效 worker:身份取 session_info name(--name 写入),createdAt 取 header 时间", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		fixture(dir, "a.jsonl", [HEADER, INFO("pi-worker-hank#0123456789ab"), MSG]);
		const { sessions, skipped, collected } = await scanLeftoverSessions(cwd);
		assert.deepEqual(skipped, []);
		assert.deepEqual(collected, []);
		assert.equal(sessions.length, 1);
		const s = sessions[0];
		assert.equal(s.id, "pi-worker-hank#0123456789ab");
		assert.equal(s.name, "hank");
		assert.equal(s.sessionFile, join(dir, "a.jsonl"));
		assert.equal(s.cwd, cwd, "路径无 anchor 时回退扫描 cwd");
		assert.equal(s.createdAt, Date.parse("2026-08-12T10:00:00.000Z"));
	});

	test("目录不存在 → 空结果(无遗留是合法态,不报错)", async () => {
		const { sessions, skipped } = await scanLeftoverSessions(join(tmpdir(), `piw-rec-missing-${Date.now()}`));
		assert.deepEqual(sessions, []);
		assert.deepEqual(skipped, []);
	});

	test("已 collect 的文件排除(恢复去重,审计保留)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		fixture(dir, "a.jsonl", [HEADER, INFO("pi-worker-hank#0123456789ab"), MSG, COLLECTED]);
		const { sessions, collected } = await scanLeftoverSessions(cwd);
		assert.deepEqual(sessions, []);
		assert.equal(collected.length, 1);
	});

	test("非 worker session(name 不匹配 worker id)与坏文件跳过", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		fixture(dir, "regular.jsonl", [HEADER, INFO("regular-session"), MSG]);
		writeFileSync(join(dir, "broken.jsonl"), "{not json\n");
		const { sessions, skipped } = await scanLeftoverSessions(cwd);
		assert.deepEqual(sessions, []);
		assert.equal(skipped.length, 2);
	});

	test("无 session_info 身份的旧文件跳过(身份不可判定,不猜)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		fixture(dir, "old.jsonl", [HEADER, MSG]);
		const { sessions, skipped } = await scanLeftoverSessions(cwd);
		assert.deepEqual(sessions, []);
		assert.equal(skipped.length, 1);
	});

	test("多文件按 createdAt 排序(认领顺序确定性)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		fixture(dir, "later.jsonl", [{ ...HEADER, timestamp: "2026-08-12T12:00:00.000Z" }, INFO("pi-worker-b#bbbbbbbbbbbb"), MSG]);
		fixture(dir, "earlier.jsonl", [{ ...HEADER, timestamp: "2026-08-12T09:00:00.000Z" }, INFO("pi-worker-a#aaaaaaaaaaaa"), MSG]);
		const { sessions } = await scanLeftoverSessions(cwd);
		assert.deepEqual(sessions.map((s) => s.name), ["a", "b"]);
	});

	test("hasCollectedMarker:大文件尾部标记也能命中(64KB 尾窗)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		const lines = [HEADER, INFO("pi-worker-x#cccccccccccc")];
		for (let i = 0; i < 5000; i++) {
			lines.push({ type: "message", id: `m${i}`, parentId: null, timestamp: "t", message: { role: "user", content: "x".repeat(200) } });
		}
		lines.push(COLLECTED);
		const file = join(dir, "big.jsonl");
		fixture(dir, "big.jsonl", lines);
		assert.ok(hasCollectedMarker(file), "1MB+ 文件尾部标记应命中");
		assert.equal(hasCollectedMarker(join(dir, "missing.jsonl")), false, "文件不存在不抛错,按未标记");
	});
});
