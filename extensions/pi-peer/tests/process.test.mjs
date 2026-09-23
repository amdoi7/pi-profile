import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HEARTBEAT_FRESH_MS, presenceOf, readHeartbeat, removeCorpse, startHeartbeat, writeHeartbeat } from "../src/process.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pi-peer-proc-"));
const hbPath = (d, id = "s") => join(d, `${id}.heartbeat`);

describe("process(在场性:heartbeat pid+时间戳 + kill 0,零外部命令)", () => {
	test("write/readHeartbeat:往返一致;坏内容 → null", () => {
		const d = dir();
		const p = hbPath(d);
		writeHeartbeat(p, 4242, 1000);
		assert.deepEqual(readHeartbeat(p), { pid: 4242, ts: 1000 });
		writeFileSync(p, "not-a-heartbeat");
		assert.equal(readHeartbeat(p), null);
		assert.equal(readHeartbeat(join(d, "missing.heartbeat")), null);
	});

	test("presenceOf:心跳新鲜 + 进程活 → online", () => {
		const d = dir();
		const p = hbPath(d);
		writeHeartbeat(p, process.pid, Date.now());
		assert.deepEqual(presenceOf(p), { status: "online", pid: process.pid });
	});

	test("presenceOf:心跳过期 + 进程活 → suspended(挂起,事件循环冻结无法刷新)", () => {
		const d = dir();
		const p = hbPath(d);
		writeHeartbeat(p, process.pid, Date.now() - HEARTBEAT_FRESH_MS - 1000);
		assert.deepEqual(presenceOf(p), { status: "suspended", pid: process.pid });
	});

	test("startHeartbeat:启动即写 + 周期刷新推进 ts,stop 停更删文件且幂等", async () => {
		const d = dir();
		const p = hbPath(d, "srv");
		const stop = startHeartbeat(p, process.pid, 40);
		assert.ok(existsSync(p), "start 即写");
		const t1 = readHeartbeat(p).ts;
		await new Promise((r) => setTimeout(r, 70));
		const t2 = readHeartbeat(p).ts;
		assert.ok(t2 > t1, "周期刷新推进时间戳");
		stop();
		assert.ok(!existsSync(p), "stop 删文件");
		stop(); // 幂等:二次 stop 无害
		assert.ok(!existsSync(p));
	});

	test("presenceOf:进程不存在 → dead(尸体可清)", () => {
		const d = dir();
		const p = hbPath(d);
		writeHeartbeat(p, 999999999, Date.now());
		assert.equal(presenceOf(p).status, "dead");
	});

	test("presenceOf:无心跳文件 → unknown(旧版本会话,不动不猜)", () => {
		const d = dir();
		assert.deepEqual(presenceOf(join(d, "missing.heartbeat")), { status: "unknown" });
	});

	test("removeCorpse:尸体 socket + heartbeat 一并移除,缺失不抛", () => {
		const d = dir();
		const sock = join(d, "corpse.sock");
		const hb = join(d, "corpse.heartbeat");
		writeFileSync(sock, "");
		writeHeartbeat(hb, 999999999);
		removeCorpse(sock, hb);
		assert.ok(!existsSyncSafe(sock));
		assert.ok(!existsSyncSafe(hb));
		removeCorpse(join(d, "none.sock"), join(d, "none.heartbeat")); // 不抛
	});
});

function existsSyncSafe(p) {
	try {
		require("node:fs").accessSync(p);
		return true;
	} catch {
		return false;
	}
}
