import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COLLECTED_MARKER, appendLedgerEntry, dispositionsFromLedger, hasCollectedMarker, readLedger, scanLeftoverSessions } from "../src/recovery.ts";
import { workerLedgerFile } from "../src/contract.ts";

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

	test("内容含字面量 ≠ 已收起(尾窗 substring 误排除修复:逐行解析 customType 精确匹配)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-rec-"));
		const dir = dirFor(cwd);
		fixture(dir, "lit.jsonl", [
			HEADER,
			INFO("pi-worker-x#cccccccccccc"),
			{ type: "message", id: "m9", parentId: null, timestamp: "t", message: { role: "assistant", content: `讨论 ${COLLECTED_MARKER} 的实现` } },
		]);
		const file = join(dir, "lit.jsonl");
		assert.equal(hasCollectedMarker(file), false, "呈报文本含字面量不算收起(命名回归:substring 误报)");
		appendFileSync(file, JSON.stringify(COLLECTED) + "\n");
		assert.ok(hasCollectedMarker(file), "真标记命中");
	});
});

describe("worker-ledger(父侧台账:决策即落盘,重启重放;子 session 降为纯审计)", () => {
	// 命名回归:marker 写失败的降级窗口由台账终态否决补网;同 id 多代次由 bind 指针消歧
	test("appendLedgerEntry/readLedger 往返;坏行与未知类型跳过(前向兼容/截断写)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-ledger-"));
		appendLedgerEntry(cwd, { type: "bind", id: "pi-worker-a#aaaaaaaaaaaa", sessionFile: join(cwd, ".pi", "worker-sessions", "f.jsonl"), cwd, ts: 1 });
		appendFileSync(workerLedgerFile(cwd), "{bad json\n");
		appendFileSync(workerLedgerFile(cwd), JSON.stringify({ type: "future-type", id: "pi-worker-z#zzzzzzzzzzzz", ts: 9 }) + "\n");
		appendLedgerEntry(cwd, { type: "collect", id: "pi-worker-a#aaaaaaaaaaaa", verdict: "通过", ts: 2 });
		const entries = readLedger(cwd);
		assert.equal(entries.length, 2, "坏行/未知类型跳过");
		assert.equal(entries[1].type, "collect");
		assert.equal(readLedger(join(tmpdir(), `piw-none-${Date.now()}`)).length, 0, "无台账文件 → 空(legacy 扫描接管)");
	});

	test("dispositions:bind 开(新代次证据)、collect/kill 终态;同 id 多代次取最新 bind 指针", () => {
		const id = "pi-worker-a#aaaaaaaaaaaa";
		const settled = dispositionsFromLedger([
			{ type: "bind", id, sessionFile: "/old.jsonl", cwd: "/c", ts: 1 },
			{ type: "collect", id, verdict: "丢弃", ts: 2 },
		]);
		assert.equal(settled.get(id)?.settled, true, "collect 终态");
		const rerun = dispositionsFromLedger([
			{ type: "bind", id, sessionFile: "/old.jsonl", cwd: "/c", ts: 1 },
			{ type: "kill", id, ts: 2 },
			{ type: "bind", id, sessionFile: "/new.jsonl", cwd: "/c", ts: 3 },
		]);
		assert.equal(rerun.get(id)?.settled, false, "新代次 bind 重开");
		assert.equal(rerun.get(id)?.sessionFile, "/new.jsonl", "指针取最新 bind(消歧多代次)");
	});
});
