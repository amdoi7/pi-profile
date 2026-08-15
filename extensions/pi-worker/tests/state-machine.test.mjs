import { test } from "vitest";
import assert from "node:assert/strict";

import { WorkerStateMachine, WorkerError } from "../src/state-machine.ts";

const ID = "pi-worker-hank#abc123";

/** run + 握手完成 → running */
function make(id = ID) {
	const sm = new WorkerStateMachine();
	sm.run({ id, name: "hank" });
	sm.onStarted(id);
	return sm;
}

function expectWorkerError(fn, ...needles) {
	let thrown = null;
	try {
		fn();
	} catch (e) {
		thrown = e;
	}
	assert.ok(thrown instanceof WorkerError, `expected WorkerError, got ${thrown}`);
	for (const needle of needles) {
		assert.ok(thrown.message.includes(needle), `message "${thrown.message}" missing "${needle}"`);
	}
	return thrown;
}

// ---------- starting ----------

test("run: ∅→starting,记录字段齐全", () => {
	const sm = new WorkerStateMachine();
	const rec = sm.run({ id: ID, name: "hank" });
	assert.equal(rec.state, "starting");
	assert.equal(rec.id, ID);
	assert.equal(rec.name, "hank");
	assert.ok(rec.createdAt > 0);
});

test("onStarted: starting→running;非 starting 忽略", () => {
	const sm = new WorkerStateMachine();
	sm.run({ id: ID, name: "hank" });
	sm.onStarted(ID);
	assert.equal(sm.records.get(ID).state, "running");
	sm.onStarted(ID); // running 时忽略
	assert.equal(sm.records.get(ID).state, "running");
});

test("run: 同 id 未终结时拒绝", () => {
	const sm = make();
	expectWorkerError(
		() => sm.run({ id: ID, name: "hank" }),
		"id exists and not terminal",
		ID,
	);
});

test("run: terminal 记录可复用(替换),旧失败诊断继承到新记录", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null, stderrTail: "boom" }); // running→failed
	const rec = sm.run({ id: ID, name: "hank" });
	assert.equal(rec.state, "starting");
	assert.equal(sm.records.size, 1);
	// 同合约重派时 status 仍可回溯上次失败诊断(回调已送达父,磁盘 jsonl 在)
	assert.equal(rec.stderrTail, "boom");
	assert.equal(rec.exitCode, 1);
});

test("run: 替换 done 记录同样继承 exit 痕迹", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.collect(ID); // → done
	const rec = sm.run({ id: ID, name: "hank" });
	assert.equal(rec.state, "starting");
	assert.equal(rec.exitCode, undefined); // done 无失败痕迹,不继承
});

test("onExit: starting 阶段进程死 → failed(握手期失败统一走此迁移)", () => {
	const sm = new WorkerStateMachine();
	sm.run({ id: ID, name: "hank" });
	sm.onExit(ID, { code: 1, signal: null, stderrTail: "启动失败: bad model" });
	const rec = sm.records.get(ID);
	assert.equal(rec.state, "failed");
	assert.equal(rec.stderrTail, "启动失败: bad model");
});

test("kill: starting 阶段可撤换 → killing → exit → done", () => {
	const sm = new WorkerStateMachine();
	sm.run({ id: ID, name: "hank" });
	sm.kill(ID);
	assert.equal(sm.records.get(ID).state, "killing");
	sm.onExit(ID, { code: null, signal: "SIGKILL" });
	assert.equal(sm.records.get(ID).state, "done");
});

// ---------- steer ----------

test("steer: running 合法,状态不变", () => {
	const sm = make();
	const before = sm.records.get(ID).updatedAt;
	sm.steer(ID);
	assert.equal(sm.records.get(ID).state, "running");
	assert.ok(sm.records.get(ID).updatedAt >= before);
});

test("steer: idle 非法,提示 send/collect", () => {
	const sm = make();
	sm.onSettled(ID);
	expectWorkerError(() => sm.steer(ID), "id is idle", "use send or collect");
});

test("steer: stopping 非法(stop 已发无意义)", () => {
	const sm = make();
	sm.stop(ID);
	expectWorkerError(() => sm.steer(ID), "id is stopping", "stop already");
});

test("steer: terminal 非法", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null });
	expectWorkerError(() => sm.steer(ID), "id is failed", "re-run");
});

test("steer: exited 非法,提示唯一出路 collect 清理", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null }); // idle→exited
	const e = expectWorkerError(() => sm.steer(ID), "id is exited", "collect to clear");
	// 提示不得指向非法动作:exited 上 run 被拒(非终态),kill 非法
	assert.ok(!e.message.includes("re-run"), `message "${e.message}" names illegal action re-run`);
});

test("steer: 未知 id,列存活", () => {
	const sm = make();
	expectWorkerError(() => sm.steer("pi-worker-nobody#000000"), "id not found", "alive: pi-worker-hank#abc123");
});

// ---------- stop ----------

test("stop: running→stopping", () => {
	const sm = make();
	sm.stop(ID);
	assert.equal(sm.records.get(ID).state, "stopping");
});

test("stop: idle 非法,提示 message/collect", () => {
	const sm = make();
	sm.onSettled(ID);
	expectWorkerError(() => sm.stop(ID), "id is idle", "no need to stop");
});

test("stop: stopping 非法(stop 已发)", () => {
	const sm = make();
	sm.stop(ID);
	expectWorkerError(() => sm.stop(ID), "id is stopping", "stop already");
});

test("stop: terminal 非法", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null });
	expectWorkerError(() => sm.stop(ID), "id is failed");
});

test("stopping → settled → idle(并入普通 idle,父仍可 collect/follow_up)", () => {
	const sm = make();
	sm.stop(ID);
	sm.onSettled(ID);
	const rec = sm.records.get(ID);
	assert.equal(rec.state, "idle");
	sm.followUp(ID); // 反悔:stop 约束子本轮,不约束父决策
	assert.equal(sm.records.get(ID).state, "running");
});

test("stopping: follow_up 非法(等 settled)", () => {
	const sm = make();
	sm.stop(ID);
	expectWorkerError(() => sm.followUp(ID), "id is stopping", "stop already");
});

test("stopping: kill 合法", () => {
	const sm = make();
	sm.stop(ID);
	sm.kill(ID);
	assert.equal(sm.records.get(ID).state, "killing");
});

test("onExit: stopping 阶段进程死 → failed", () => {
	const sm = make();
	sm.stop(ID);
	sm.onExit(ID, { code: 137, signal: null });
	assert.equal(sm.records.get(ID).state, "failed");
});

// ---------- follow_up ----------

test("follow_up: idle→running", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.followUp(ID);
	assert.equal(sm.records.get(ID).state, "running");
});

test("follow_up: running 非法,提示 steer", () => {
	const sm = make();
	expectWorkerError(() => sm.followUp(ID), "id is running", "steer");
});

test("follow_up: terminal 非法", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.collect(ID);
	expectWorkerError(() => sm.followUp(ID), "id is done", "re-run");
});

test("follow_up: exited 非法(进程已退出),提示唯一出路 collect 清理", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null }); // idle→exited
	const e = expectWorkerError(() => sm.followUp(ID), "id is exited", "collect to clear");
	assert.ok(!e.message.includes("re-run"), `message "${e.message}" names illegal action re-run`);
});

// ---------- collect ----------

test("collect: idle→done", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.collect(ID);
	assert.equal(sm.records.get(ID).state, "done");
});

test("collect: exited→done", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null }); // idle→exited
	sm.collect(ID);
	assert.equal(sm.records.get(ID).state, "done");
});

test("collect: running 非法,提示 kill 或等 settled", () => {
	const sm = make();
	expectWorkerError(() => sm.collect(ID), "id is running", "kill");
});

test("collect: failed→done(终态清理,清账后可重派)", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null });
	sm.collect(ID);
	assert.equal(sm.records.get(ID).state, "done");
});

// ---------- kill ----------

test("kill: running→killing", () => {
	const sm = make();
	sm.kill(ID);
	assert.equal(sm.records.get(ID).state, "killing");
});

test("kill: idle→killing", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.kill(ID);
	assert.equal(sm.records.get(ID).state, "killing");
});

test("kill: terminal 非法", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null });
	expectWorkerError(() => sm.kill(ID), "id is failed");
});

test("kill: exited 非法,提示唯一出路 collect 清理", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null });
	const e = expectWorkerError(() => sm.kill(ID), "id is exited", "collect to clear");
	assert.ok(!e.message.includes("re-run"), `message "${e.message}" names illegal action re-run`);
});

test("stop: exited 非法,提示唯一出路 collect 清理", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null });
	const e = expectWorkerError(() => sm.stop(ID), "id is exited", "collect to clear");
	assert.ok(!e.message.includes("re-run"), `message "${e.message}" names illegal action re-run`);
});

test("run: exited 记录拒绝,提示 collect 清理(kill 在 exited 非法,不得出现)", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null });
	const e = expectWorkerError(() => sm.run({ id: ID, name: "hank" }), "id exists and not terminal", "collect to clear");
	assert.ok(!e.message.includes("或 kill"), `message "${e.message}" names illegal action kill`);
});

// ---------- 事件 ----------

test("onSettled: running→idle", () => {
	const sm = make();
	sm.onSettled(ID);
	const rec = sm.records.get(ID);
	assert.equal(rec.state, "idle");
});

test("onSettled: 非 running/stopping 态忽略(不抛不迁移)", () => {
	const sm = make();
	sm.kill(ID); // killing
	sm.onSettled(ID);
	assert.equal(sm.records.get(ID).state, "killing");

	const sm2 = make();
	sm2.onExit(ID, { code: 1, signal: null }); // failed
	sm2.onSettled(ID);
	assert.equal(sm2.records.get(ID).state, "failed");
});

test("onExit: running→failed,带诊断", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null, stderrTail: "boom" });
	const rec = sm.records.get(ID);
	assert.equal(rec.state, "failed");
	assert.equal(rec.exitCode, 1);
	assert.equal(rec.stderrTail, "boom");
	assert.equal(rec.processExited, true);
});

test("onExit: killing→done(reap)", () => {
	const sm = make();
	sm.kill(ID);
	sm.onExit(ID, { code: null, signal: "SIGKILL" });
	assert.equal(sm.records.get(ID).state, "done");
});

test("onExit: idle→exited(进程没了,合法集合只剩 collect/status)", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.onExit(ID, { code: 0, signal: null });
	const rec = sm.records.get(ID);
	assert.equal(rec.state, "exited");
	assert.equal(rec.processExited, true);
	expectWorkerError(() => sm.followUp(ID), "id is exited");
	sm.collect(ID); // collect 仍合法
	assert.equal(sm.records.get(ID).state, "done");
});

test("onExit: done/failed/exited 时忽略(不迁移)", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.collect(ID);
	sm.onExit(ID, { code: 0, signal: null });
	assert.equal(sm.records.get(ID).state, "done");

	const sm2 = make();
	sm2.onSettled(ID);
	sm2.onExit(ID, { code: 0, signal: null }); // exited
	sm2.onExit(ID, { code: 0, signal: null }); // 忽略
	assert.equal(sm2.records.get(ID).state, "exited");
});

test("onExit: 启动失败诊断先到者优先,不被 watcher stderr 尾覆盖", () => {
	const sm = new WorkerStateMachine();
	sm.run({ id: ID, name: "hank" });
	sm.onExit(ID, { code: null, signal: null, stderrTail: "启动失败: Model not found" });
	sm.onExit(ID, { code: 1, signal: null, stderrTail: "普通 stderr" }); // watcher 路径
	assert.equal(sm.records.get(ID).stderrTail, "启动失败: Model not found");
});

// ---------- status ----------

test("status: 按 id 查询任意状态(含 terminal last known)", () => {
	const sm = make();
	sm.onExit(ID, { code: 1, signal: null, stderrTail: "x" });
	const rec = sm.status(ID);
	assert.equal(rec.state, "failed");
	assert.equal(rec.exitCode, 1);
});

test("status: 缺省列全部;未知 id 列存活", () => {
	const sm = make();
	sm.run({ id: "pi-worker-rin#000001", name: "rin" });
	sm.onStarted("pi-worker-rin#000001");
	const all = sm.status();
	assert.equal(all.length, 2);
	expectWorkerError(() => sm.status("pi-worker-nobody#000000"), "id not found", "alive: pi-worker-hank#abc123, pi-worker-rin#000001");
});

test("kill→exit→done 全链路", () => {
	const sm = make();
	sm.kill(ID);
	assert.equal(sm.records.get(ID).state, "killing");
	sm.onExit(ID, { code: null, signal: "SIGKILL" });
	assert.equal(sm.records.get(ID).state, "done");
});

// ---------- rollback(乐观迁移的补偿:CAS) ----------

test("rollback: 状态仍是本次写入值 → 回退到 from", () => {
	const sm = make();
	sm.onSettled(ID); // → idle
	sm.followUp(ID); // idle → running(乐观)
	sm.rollback(ID, "running", "idle");
	assert.equal(sm.status(ID).state, "idle", "效果未落地 → 状态回到 idle");
});

test("rollback: 期间进程已死 → 不覆盖 failed(异步事实优先于补偿)", () => {
	const sm = make();
	sm.onSettled(ID);
	sm.followUp(ID);
	sm.onExit(ID, { code: 1, signal: null }); // running → failed
	sm.rollback(ID, "running", "idle");
	assert.equal(sm.status(ID).state, "failed");
});

test("rollback: 期间已 settled → 不覆盖 idle", () => {
	const sm = make();
	sm.stop(ID); // running → stopping
	sm.onSettled(ID); // stopping → idle
	sm.rollback(ID, "stopping", "running");
	assert.equal(sm.status(ID).state, "idle");
});

test("rollback: 期间被 kill → 不覆盖 killing", () => {
	const sm = make();
	sm.stop(ID);
	sm.kill(ID); // stopping → killing
	sm.rollback(ID, "stopping", "running");
	assert.equal(sm.status(ID).state, "killing");
});

test("rollback: 不存在的 id → 静默忽略(补偿路径不抛错)", () => {
	const sm = new WorkerStateMachine();
	sm.rollback("pi-worker-ghost#000000", "running", "idle");
});

// ---------- O3 冷恢复 ----------
test("onResumed:exited→starting,processExited 复位;非 exited 不动", () => {
	const sm = new WorkerStateMachine();
	sm.run({ id: ID, name: "hank" });
	sm.onStarted(ID);
	sm.onSettled(ID); // idle
	sm.onExit(ID, { code: 1, signal: null, stderrTail: "" }); // idle 后崩 → exited
	const before = sm.status(ID);
	assert.equal(before.state, "exited");
	sm.onResumed(ID);
	const rec = sm.status(ID);
	assert.equal(rec.state, "starting", "exited→starting");
	assert.equal(rec.processExited, false);
	// 非 exited 不动
	sm.onResumed(ID);
	assert.equal(sm.status(ID).state, "starting", "starting 状态重复调用不动");
});
