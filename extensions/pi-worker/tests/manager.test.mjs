import { describe, test, vi } from "vitest";
import assert from "node:assert/strict";

import { WorkerManager, sessionDirFor } from "../src/manager.ts";

/** 反应器单测:句柄用假 rpc 注入(不起进程);terminate 对 exitCode 非 null 无操作。 */
describe("sessionDirFor", () => {
	test("子 session 审计目录:<cwd>/.pi/worker/sessions(HARNESS.md 契约)", () => {
		assert.equal(sessionDirFor("/repo"), "/repo/.pi/worker/sessions");
	});
});

function setup() {
	const delivered = [];
	const changes = [];
	const manager = new WorkerManager({
		deliver: (m) => delivered.push(m),
		onChange: () => changes.push(1),
	});
	const add = (id, name, state = "idle", { oneshot = false, statsDelay = 0 } = {}) => {
		manager.sm.run({ id, name, oneshot });
		if (state !== "starting") manager.sm.onStarted(id); // → running
		if (state === "idle") manager.sm.onSettled(id); // → idle(report)
		const rpc = {
			sent: [],
			raw: [],
			send: async (cmd) => {
				rpc.sent.push(cmd.type);
				if (cmd.type === "get_last_assistant_text") return { text: "报告全文" };
				if (cmd.type === "get_session_stats") {
					if (statsDelay > 0) await new Promise((r) => setTimeout(r, statsDelay));
					return { tokens: { total: 15 }, cost: 0.001 };
				}
				return { ok: true };
			},
			writeRaw: (o) => rpc.raw.push(o),
		};
		manager.handles.set(id, { rpc, proc: { exitCode: 0, signalCode: null, kill() {} }, sessionDir: "/tmp", watcher: { dispose: () => {} } });
		return rpc;
	};
	const settle = async (id) => {
		manager.onWorkerEvent(id, { type: "settled" });
		await new Promise((r) => setTimeout(r, 10));
	};
	return { manager, delivered, changes, add, settle };
}

describe("message(父→子统一通道:同一功能,FSM 按状态选投递语义)", () => {
	test("running → steer 注入(turn 边界生效)", async () => {
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
		const mode = await manager.message("pi-worker-hank#aaaaaa", "先修断言");
		assert.equal(mode, "steer");
		assert.ok(rpc.sent.includes("steer"), rpc.sent.join(","));
	});

	test("idle → prompt 触发新轮(打回/追加轮次同路)", async () => {
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "idle");
		const mode = await manager.message("pi-worker-hank#aaaaaa", "打回:测试没写");
		assert.equal(mode, "prompt");
		assert.ok(rpc.sent.includes("prompt"), rpc.sent.join(","));
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").state, "running");
	});

	test("starting/stopping → WorkerError(可行动提示,不静默)", async () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "starting");
		await assert.rejects(() => manager.message("pi-worker-hank#aaaaaa", "x"), /当前 starting/);
	});
});

describe("stop 硬兑底", () => {
	test("宽限期未 settled → abort 硬中止(settled 必达)", async () => {
		vi.useFakeTimers();
		try {
			const { manager, add } = setup();
			const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
			const p = manager.stop("pi-worker-hank#aaaaaa");
			await vi.runAllTicks();
			assert.ok(rpc.sent.includes("steer"), rpc.sent.join(","));
			await vi.advanceTimersByTimeAsync(30000);
			await vi.runAllTicks();
			assert.ok(rpc.sent.includes("abort"), rpc.sent.join(","));
			await p;
		} finally {
			vi.useRealTimers();
		}
	});

	test("宽限期内已 settled → 兑底 timer 不 abort", async () => {
		vi.useFakeTimers();
		try {
			const { manager, add } = setup();
			const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
			const p = manager.stop("pi-worker-hank#aaaaaa");
			await vi.runAllTicks();
			manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "settled" }); // → idle
			await vi.advanceTimersByTimeAsync(30000);
			await vi.runAllTicks();
			assert.ok(!rpc.sent.includes("abort"), rpc.sent.join(","));
			await p;
		} finally {
			vi.useRealTimers();
		}
	});

	test("宽限期未 settled 且已 kill → 兑底 timer 不 abort", async () => {
		vi.useFakeTimers();
		try {
			const { manager, add } = setup();
			const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
			const p = manager.stop("pi-worker-hank#aaaaaa");
			await vi.runAllTicks();
			manager.sm.kill("pi-worker-hank#aaaaaa"); // → killing
			await vi.advanceTimersByTimeAsync(30000);
			await vi.runAllTicks();
			assert.ok(!rpc.sent.includes("abort"), rpc.sent.join(","));
			await p;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("onWorkerEvent(唯一反应者)", () => {
	test("message 事件 → RoomBus 路由:目标不存在时回执发送方(自我修正)", async () => {
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "message", to: "ghost", text: "hi" });
		await new Promise((r) => setTimeout(r, 10)); // bus.post 异步
		assert.ok(
			rpc.sent.includes("steer"), // 发送方 running → steer 回执
			rpc.sent.join(","),
		);
	});

		test("message 事件 → RoomBus:to=parent 投消息卡到父 session(deliver 非 quiet)", async () => {
		const { manager, delivered, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "message", to: "parent", text: "验收证据已齐" });
		await new Promise((r) => setTimeout(r, 10));
		const card = delivered.find((m) => m.details.type === "message");
		assert.ok(card, delivered.map((m) => m.details.type).join(","));
		assert.equal(card.details.text, "验收证据已齐");
		assert.ok(card.content.includes("hank → parent"));
	});

		test("latestStats:每 turn 快照覆写,settled 复用在途不重复拉取", async () => {
		// statsDelay 模拟真实 RPC 延迟:第一次拉取完成后、settled 到达时第二次在途,
		// "复用"断言才有意义(即时 resolve 的 mock 下 settled 必然新拉取,断言不可达)。
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "running", { statsDelay: 25 });
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "turnEnd" });
		await new Promise((r) => setTimeout(r, 40)); // 拉取1 完成(25ms < 40ms)
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "turnEnd" });
		await new Promise((r) => setTimeout(r, 5)); // 拉取2 在途(剩余 ~20ms)
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "settled" });
		await new Promise((r) => setTimeout(r, 60)); // handleSettled 复用拉取2 后完成
		assert.deepEqual(manager.sm.records.get("pi-worker-hank#aaaaaa").latestStats, { tokens: { total: 15 }, cost: 0.001 });
		assert.equal(rpc.sent.filter((t) => t === "get_session_stats").length, 2); // 每 turn 至多一次
	});

	test("settled → 取呈报+stats,投递 settled 回调(含 turns),rec 留档", async () => {
		const { manager, delivered, add, settle } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "turnEnd" });
		await settle("pi-worker-hank#aaaaaa");
		assert.deepEqual(rpc.sent, ["get_session_stats", "get_last_assistant_text"]); // turn_end 先拉快照,settled 复用
		assert.equal(delivered[0].details.type, "settled");
		assert.equal(delivered[0].details.report, "报告全文");
		assert.equal(delivered[0].details.turns, 1);
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").report, "报告全文");
	});

	test("oneshot:report 回调送达后自动 collect → done", async () => {
		const { manager, delivered, add, settle } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running", { oneshot: true });
		await settle("pi-worker-hank#aaaaaa");
		assert.equal(delivered[0].details.type, "settled");
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").state, "done");
	});


	test("running 中 exited → failed 回调 + 句柄回收", () => {
		const { manager, delivered, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "exited", code: 1, signal: null, stderrTail: "boom" });
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").state, "failed");
		assert.equal(delivered[0].details.type, "failed");
		assert.equal(manager.handles.has("pi-worker-hank#aaaaaa"), false);
	});

	test("collect 后 exited → 无 failed 回调,仅回收句柄", () => {
		const { manager, delivered, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "idle");
		manager.collect("pi-worker-hank#aaaaaa");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "exited", code: 0, signal: null, stderrTail: "" });
		assert.equal(delivered.length, 0);
		assert.equal(manager.handles.has("pi-worker-hank#aaaaaa"), false);
	});

	test("idle 后进程崩 → exited 态,无 failed 回调", () => {
		const { manager, delivered, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "idle");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "exited", code: 1, signal: null, stderrTail: "" });
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").state, "exited");
		assert.equal(delivered.length, 0);
	});

	test("turnEnd → turns++ 并触发 onChange;tool 事件更新显示态", () => {
		const { manager, changes, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "toolStart", toolName: "bash", args: "npm test" });
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").currentActivity, "tool: bash npm test");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "toolEnd", toolName: "bash" });
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").currentActivity, undefined);
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "turnEnd" });
		const rec = manager.sm.records.get("pi-worker-hank#aaaaaa");
		assert.equal(rec.turns, 1);
		assert.equal(rec.currentActivity, undefined);
		assert.ok(changes.length >= 1);
	});

	test("dialog → 句柄 rpc 回 cancelled,不替父决策", () => {
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "dialog", id: "u1" });
		assert.deepEqual(rpc.raw, [{ type: "extension_ui_response", id: "u1", cancelled: true }]);
	});
});
