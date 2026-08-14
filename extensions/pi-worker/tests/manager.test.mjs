import { describe, test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerManager, applyHandshakeState } from "../src/manager.ts";
import { workerSessionDir } from "../src/contract.ts";

/** 反应器单测:句柄用假 rpc 注入(不起进程);terminate 对 exitCode 非 null 无操作。 */
describe("workerSessionDir", () => {
	test("子 session 审计目录(内置约定):<cwd>/.pi/worker-sessions", () => {
		assert.equal(workerSessionDir("/repo"), "/repo/.pi/worker-sessions");
	});
});

describe("applyHandshakeState(握手 get_state → 记录映射,纯函数)", () => {
	const rec = () => ({
		id: "pi-worker-x#aaaaaaaaaaaa",
		name: "x",
		state: "running",
		processExited: false,
		createdAt: 1,
		updatedAt: 1,
		recent: [],
		turns: 0,
	});

	test("model/thinkingLevel/sessionFile 全部落记录", () => {
		const r = rec();
		applyHandshakeState(r, { model: { provider: "opencode-go", id: "deepseek-v4-flash" }, thinkingLevel: "low", sessionFile: "/repo/.pi/worker-sessions/s.jsonl" });
		assert.deepEqual(r.modelInfo, { provider: "opencode-go", id: "deepseek-v4-flash", thinkingLevel: "low" });
		assert.equal(r.sessionFile, "/repo/.pi/worker-sessions/s.jsonl");
	});

	test("model 缺失 → modelInfo 不写;sessionFile 缺失 → 不动", () => {
		const r = rec();
		applyHandshakeState(r, {});
		assert.equal(r.modelInfo, undefined);
		assert.equal(r.sessionFile, undefined);
	});

	test("sessionFile 单独到达(补查路径)→ 只补审计指针", () => {
		const r = rec();
		r.modelInfo = { provider: "p", id: "m", thinkingLevel: "low" };
		applyHandshakeState(r, { sessionFile: "/repo/.pi/worker-sessions/s.jsonl" });
		assert.equal(r.sessionFile, "/repo/.pi/worker-sessions/s.jsonl");
	});
});

function setup() {
	const delivered = [];
	const changes = [];
	const manager = new WorkerManager({
		deliver: (m) => delivered.push(m),
		onChange: () => changes.push(1),
	});
	const add = (id, name, state = "idle", { statsDelay = 0 } = {}) => {
		manager.sm.run({ id, name });
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

describe("bus resolve(name 或完整 id)", () => {
	test("完整 id 定向(name 可重名)→ 解析到唯一活记录并投递", async () => {
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaaaaaaaa", "hank", "idle");
		const result = await manager.bus.post("parent", "pi-worker-hank#aaaaaaaaaaaa", "追加证据");
		assert.deepEqual(result, { ok: true, via: "prompt" });
		assert.ok(rpc.sent.includes("prompt"));
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
	test("activity 事件:retrying/compacting 词汇落 currentActivity;结束按 phase 清除,不误清 tool 活动", () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		const id = "pi-worker-hank#aaaaaa";
		manager.onWorkerEvent(id, { type: "activity", phase: "retrying", label: "retrying (1/3)" });
		assert.equal(manager.status(id).currentActivity, "retrying (1/3)");
		// 阶段结束:只清同 phase
		manager.onWorkerEvent(id, { type: "activity", phase: "compacting", label: undefined });
		assert.equal(manager.status(id).currentActivity, "retrying (1/3)", "异 phase 结束不清除");
		manager.onWorkerEvent(id, { type: "activity", phase: "retrying", label: undefined });
		assert.equal(manager.status(id).currentActivity, undefined);
		// tool 活动不被 phase 结束误清
		manager.onWorkerEvent(id, { type: "toolStart", toolName: "bash", args: "ls" });
		manager.onWorkerEvent(id, { type: "activity", phase: "compacting", label: undefined });
		assert.equal(manager.status(id).currentActivity, "tool: bash ls", "tool 活动保留");
	});

	test("message 事件 → RoomBus 路由:目标不存在时 failure receipt 回发送方(自我修正)", async () => {
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

	test("settled 后留 idle 等父验收;显式 collect → done", async () => {
		const { manager, delivered, add, settle } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		await settle("pi-worker-hank#aaaaaa");
		assert.equal(delivered[0].details.type, "settled");
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").state, "idle");
		manager.collect("pi-worker-hank#aaaaaa");
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

	test("dialog → 句柄缺失不 crash 父进程,deliver 诊断(invariant 破坏须可见)", () => {
		const { manager, delivered } = setup();
		manager.sm.run({ id: "pi-worker-ghost#aaaaaa", name: "ghost" });
		manager.sm.onStarted("pi-worker-ghost#aaaaaa");
		// 无 handles 条目:事件流上 throw 无捕获者,会成为父进程 uncaughtException
		manager.onWorkerEvent("pi-worker-ghost#aaaaaa", { type: "dialog", id: "u1" });
		assert.ok(
			delivered.some((m) => m.details.type === "failed" && /句柄/.test(m.content)),
			"诊断回调送达而非 throw",
		);
	});

	test("bus resolve:仅 running/idle 可寻址;failed 终态出局(不可收消息)", async () => {
		const { manager, add } = setup();
		add("pi-worker-seal#bbbbbb", "seal", "idle");
		manager.sm.onExit("pi-worker-seal#bbbbbb", { code: 1, signal: null, stderrTail: "" });
		const result = await manager.bus.post("parent", "seal", "hi");
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /不存在或歧义/);
	});
});

describe("recoverFromDisk(启动恢复:worker-sessions 目录即 registry)", () => {
	const mkSessionsDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "piw-mgr-"));
		const sessionsDir = join(dir, ".pi", "worker-sessions");
		mkdirSync(sessionsDir, { recursive: true });
		return { dir, sessionsDir };
	};
	const WORKER_JSONL = (name) =>
		[
			JSON.stringify({ type: "session", version: 3, id: "u1", timestamp: "2026-08-12T10:00:00.000Z", cwd: "/repo" }),
			JSON.stringify({ type: "session_info", id: "k1", parentId: null, timestamp: "2026-08-12T10:00:01.000Z", name }),
		].join("\n") + "\n";

	test("jsonl 重建 → exited/recovered 记录进 status;quiet 审计留痕;幂等", async () => {
		const { dir, sessionsDir } = mkSessionsDir();
		writeFileSync(join(sessionsDir, "a.jsonl"), WORKER_JSONL("pi-worker-hank#0123456789ab"));
		writeFileSync(join(sessionsDir, "broken.jsonl"), "not json\n");
		const { manager, delivered, changes } = setup();

		const res = await manager.recoverFromDisk(dir);
		assert.equal(res.recovered, 1);
		assert.deepEqual(res.skippedFiles, ["broken.jsonl"], "不可解析文件显式列出(丢弃范围声明)");

		const rec = manager.sm.records.get("pi-worker-hank#0123456789ab");
		assert.equal(rec.state, "exited");
		assert.equal(rec.recovered, true);
		assert.equal(rec.sessionFile, join(sessionsDir, "a.jsonl"));
		assert.ok(changes.length > 0, "footer 投影重算");

		const audit = delivered.find((m) => m.details?.type === "recovery");
		assert.ok(audit, "恢复审计 quiet 留痕");
		assert.ok(audit.content.includes("pi-worker-hank#0123456789ab"), "审计载重建 id");
		assert.ok(audit.content.includes("broken.jsonl"), "审计载丢弃范围");

		// 幂等:再次恢复不重复、不再留痕
		const again = await manager.recoverFromDisk(dir);
		assert.equal(again.recovered, 0);
		assert.equal(manager.sm.records.size, 1);
	});

	test("无 worker-sessions 目录 → recovered=0,不留痕(无遗留是合法态)", async () => {
		const { manager, delivered } = setup();
		const res = await manager.recoverFromDisk(join(tmpdir(), `piw-mgr-nonexistent-${Date.now()}`));
		assert.equal(res.recovered, 0);
		assert.equal(delivered.length, 0);
	});
});

describe("collect verdict(终审结论成工具参数,不再是散文)", () => {
	test("collect 带 verdict → 落记录,status 可审计", () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank"); // idle
		manager.collect("pi-worker-hank#aaaaaa", "通过");
		const rec = manager.sm.records.get("pi-worker-hank#aaaaaa");
		assert.equal(rec.state, "done");
		assert.equal(rec.verdict, "通过");
	});

	test("collect 不带 verdict → 不落(清理非判决)", () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank");
		manager.collect("pi-worker-hank#aaaaaa");
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").verdict, undefined);
	});

	test("非法状态 collect 带 verdict → 抛错且不落 verdict(fail fast 不留痕迹)", () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		assert.throws(() => manager.collect("pi-worker-hank#aaaaaa", "通过"), /先 kill 或等 settled/);
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").verdict, undefined);
	});
});

describe("collect 落收起标记 + 恢复归属声明", () => {
	test("collect:session 文件尾追加 pi-worker-collected 条目(恢复去重,审计保留)", async () => {
		const { manager, add } = setup();
		const dir = mkdtempSync(join(tmpdir(), "piw-collect-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/r" }) + "\n");
		add("pi-worker-hank#aaaaaa", "hank", "idle");
		manager.sm.records.get("pi-worker-hank#aaaaaa").sessionFile = file;
		manager.collect("pi-worker-hank#aaaaaa", "通过");
		const tail = readFileSync(file, "utf8");
		assert.ok(tail.includes('"pi-worker-collected"'), "标记落盘");
		assert.ok(tail.includes('"通过"'), "verdict 入标记(终审留痕)");
	});

	test("recoverFromDisk:活他窗口持有的 worker 不恢复且在恢复消息中声明;已收起不恢复", async () => {
		const { manager } = setup();
		const dir = mkdtempSync(join(tmpdir(), "piw-rec-own-"));
		const base = join(dir, ".pi", "worker-sessions");
		mkdirSync(join(base, `p${process.pid}`), { recursive: true });
		const HEADER = { type: "session", version: 3, id: "u", timestamp: "2026-08-12T10:00:00.000Z", cwd: "/r" };
		const put = (sub, file, name, extra = []) => {
			const d = sub ? join(base, sub) : base;
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, file), [HEADER, { type: "session_info", id: "i", parentId: null, timestamp: "t", name }, ...extra].map((l) => JSON.stringify(l)).join("\n") + "\n");
		};
		put(`p${process.pid}`, "mine.jsonl", "pi-worker-mine#aaaaaaaaaaaa");
		put("p1", "held.jsonl", "pi-worker-held#bbbbbbbbbbbb"); // pid 1 恒活(launchd/init)
		put(null, "collected.jsonl", "pi-worker-gone#cccccccccccc", [{ type: "custom", customType: "pi-worker-collected", id: "c", parentId: null, timestamp: "t", data: {} }]);
		const res = await manager.recoverFromDisk(dir);
		assert.equal(res.recovered, 1, "只恢复本实例的");
		assert.ok(manager.sm.records.has("pi-worker-mine#aaaaaaaaaaaa"));
		assert.ok(!manager.sm.records.has("pi-worker-held#bbbbbbbbbbbb"), "活他窗口持有不认领");
		assert.ok(!manager.sm.records.has("pi-worker-gone#cccccccccccc"), "已收起不复活");
		assert.deepEqual(res.heldElsewhere, ["pi-worker-held#bbbbbbbbbbbb"]);
	});
});

describe("遗留检测与认领分离(启动不自动恢复)", () => {
	test("scanLeftovers 只读:返回扫描结果但不建记录(自动恢复废除)", async () => {
		const { manager } = setup();
		const dir = mkdtempSync(join(tmpdir(), "piw-scan-"));
		const base = join(dir, ".pi", "worker-sessions");
		mkdirSync(base, { recursive: true });
		writeFileSync(
			join(base, "a.jsonl"),
			[
				{ type: "session", version: 3, id: "u", timestamp: "2026-08-12T10:00:00.000Z", cwd: "/r" },
				{ type: "session_info", id: "i", parentId: null, timestamp: "t", name: "pi-worker-left#aaaaaaaaaaaa" },
			].map((l) => JSON.stringify(l)).join("\n") + "\n",
		);
		const scan = await manager.scanLeftovers(dir);
		assert.equal(scan.sessions.length, 1, "检测到遗留");
		assert.equal(manager.sm.records.size, 0, "不建记录:认领是显式动作(recover)");
	});
});

describe("recoverFromDisk 归属分类(claim 谓词)", () => {
	test("claim 给定:只认领谓词通过的;其余进 foreign 不建记录", async () => {
		const { manager } = setup();
		const dir = mkdtempSync(join(tmpdir(), "piw-claim-"));
		const base = join(dir, ".pi", "worker-sessions");
		mkdirSync(base, { recursive: true });
		const HEADER = { type: "session", version: 3, id: "u", timestamp: "2026-08-12T10:00:00.000Z", cwd: "/r" };
		const put = (file, name) =>
			writeFileSync(join(base, file), [HEADER, { type: "session_info", id: "i", parentId: null, timestamp: "t", name }].map((l) => JSON.stringify(l)).join("\n") + "\n");
		put("mine.jsonl", "pi-worker-mine#aaaaaaaaaaaa");
		put("other.jsonl", "pi-worker-other#bbbbbbbbbbbb");
		const res = await manager.recoverFromDisk(dir, { claim: (id) => id.includes("mine") });
		assert.equal(res.recovered, 1);
		assert.deepEqual(res.foreign.map((s) => s.id), ["pi-worker-other#bbbbbbbbbbbb"]);
		assert.ok(manager.sm.records.has("pi-worker-mine#aaaaaaaaaaaa"));
		assert.ok(!manager.sm.records.has("pi-worker-other#bbbbbbbbbbbb"), "外会话不建记录");
	});
});

describe("代次隔离(同合约原样重跑 = 同 id 新代次,终端记录被替换)", () => {
	test("旧代次 stop 兑底链不作用于新代次:fire 时句柄已换代即失效", async () => {
		vi.useFakeTimers();
		try {
			const { manager, add } = setup();
			const id = "pi-worker-hank#aaaaaa";
			add(id, "hank", "running"); // gen1
			const p1 = manager.stop(id); // gen1 stop:宽限计时器 armed
			await vi.runAllTicks();
			await manager.kill(id); // gen1 → killing
			manager.onWorkerEvent(id, { type: "exited", code: 0, signal: null, stderrTail: "" }); // → done,旧句柄回收
			// gen2:同合约原样重跑 → 同 id 终端记录被替换,新句柄/新 rpc/新进程
			manager.sm.run({ id, name: "hank" });
			manager.sm.onStarted(id); // → running
			const sent = [];
			let kills = 0;
			manager.handles.set(id, {
				rpc: { send: async (cmd) => { sent.push(cmd.type); return { ok: true }; }, writeRaw: () => {} },
				proc: { exitCode: null, signalCode: null, kill: () => { kills++; } },
				sessionDir: "/tmp",
				watcher: { dispose: () => {} },
			});
			const p2 = manager.stop(id); // gen2 自己的 stop 链
			await vi.runAllTicks();
			await vi.advanceTimersByTimeAsync(30000); // gen1/gen2 宽限计时器均到点
			await vi.runAllTicks();
			assert.equal(sent.filter((t) => t === "abort").length, 1, "abort 恰一次(gen2 自己的链);旧代次链不串扰");
			await vi.advanceTimersByTimeAsync(15000); // 两条链的 terminate 窗口均到点
			await vi.runAllTicks();
			assert.equal(kills, 1, "terminate 恰一次(gen2 自己的链);旧代次不杀新进程");
			await p1;
			await p2;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("乐观迁移失败回滚(效果未落地 ⇒ 状态不留在意图上)", () => {
	const ID = "pi-worker-hank#aaaaaa";

	test("followUp 发送失败 → 回滚 idle(不卡 running,collect 仍是正常出路)", async () => {
		const { manager, add } = setup();
		const rpc = add(ID, "hank", "idle");
		rpc.send = async () => {
			throw new Error("EPIPE");
		};
		await assert.rejects(() => manager.message(ID, "打回:测试没写"), /follow_up 发送失败/);
		assert.equal(manager.sm.records.get(ID).state, "idle");
		manager.collect(ID); // idle 合法 ⇒ 不必靠 kill 逃生
		assert.equal(manager.sm.records.get(ID).state, "done");
	});

	test("stop 发送失败 → 回滚 running(子仍在跑本轮,可重试 stop)", async () => {
		const { manager, add } = setup();
		const rpc = add(ID, "hank", "running");
		rpc.send = async () => {
			throw new Error("子进程管道已断");
		};
		await assert.rejects(() => manager.stop(ID), /stop 发送失败/);
		assert.equal(manager.sm.records.get(ID).state, "running");
	});

	test("回滚期间进程已死 → CAS 让位 failed(异步事实优先于补偿)", async () => {
		const { manager, add } = setup();
		const rpc = add(ID, "hank", "idle");
		rpc.send = async () => {
			manager.sm.onExit(ID, { code: 1, signal: null, stderrTail: "boom" });
			throw new Error("EPIPE");
		};
		await assert.rejects(() => manager.message(ID, "x"));
		assert.equal(manager.sm.records.get(ID).state, "failed");
	});

	test("回滚期间子已自行 settled → CAS 让位 idle,不倒回 running", async () => {
		const { manager, add } = setup();
		const rpc = add(ID, "hank", "running");
		rpc.send = async () => {
			manager.sm.onSettled(ID); // stopping → idle
			throw new Error("管道已断");
		};
		await assert.rejects(() => manager.stop(ID), /stop 发送失败/);
		assert.equal(manager.sm.records.get(ID).state, "idle");
	});

	test("stop 发送失败 → 兑底计时器未 armed(回滚后不再 abort/terminate)", async () => {
		vi.useFakeTimers();
		try {
			const { manager, add } = setup();
			const rpc = add(ID, "hank", "running");
			let killed = false;
			manager.handles.get(ID).proc = { exitCode: null, signalCode: null, kill: () => (killed = true) };
			rpc.send = async () => {
				throw new Error("管道已断");
			};
			await assert.rejects(() => manager.stop(ID), /stop 发送失败/);
			await vi.advanceTimersByTimeAsync(60000);
			await vi.runAllTicks();
			assert.equal(rpc.sent.includes("abort"), false, rpc.sent.join(","));
			assert.equal(killed, false, "回滚后不应 terminate");
			assert.equal(manager.sm.records.get(ID).state, "running");
		} finally {
			vi.useRealTimers();
		}
	});
});
