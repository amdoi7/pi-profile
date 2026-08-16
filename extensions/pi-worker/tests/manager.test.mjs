import { describe, test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerManager, applyHandshakeState } from "../src/manager.ts";
import { workerSessionDir } from "../src/contract.ts";
import { COLLECTED_MARKER } from "../src/recovery.ts";

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
				if (cmd.type === "get_messages")
					return {
						messages: [{ role: "assistant", content: [{ type: "text", text: "报告全文" }], stopReason: "stop" }],
					};
				if (cmd.type === "get_session_stats") {
					if (statsDelay > 0) await new Promise((r) => setTimeout(r, statsDelay));
					return { tokens: { total: 15 }, cost: 0.001 };
				}
				return { ok: true };
			},
			writeRaw: (o) => rpc.raw.push(o),
		};
		manager.handles.set(id, { rpc, proc: { exitCode: 0, signalCode: null, kill() {} }, sessionDir: "/tmp", watcher: { dispose: () => {} } });
		manager.transcripts.set(id, { entries: [], hydrated: false, hydrating: false, queue: [] }); // 与 run() 同接线
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
		await assert.rejects(() => manager.message("pi-worker-hank#aaaaaa", "x"), /is starting/);
	});

	test("exited 无 sessionFile → WorkerError(不可续接,指明清账重派);有 sessionFile 走冷恢复(live 覆盖)", async () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "idle");
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", { type: "exited", code: 1, signal: null, stderrTail: "" });
		await assert.rejects(() => manager.message("pi-worker-hank#aaaaaa", "继续"), /no session file, cannot cold-resume/);
	});
});

describe("send mode=followUp(running → 排队,settled 后 flush 新轮)", () => {
	const ID = "pi-worker-hank#aaaaaa";

	test("running + followUp → 返回 queued,不发 RPC(排队不打断当前轮)", async () => {
		const { manager, add } = setup();
		const rpc = add(ID, "hank", "running");
		const via = await manager.message(ID, "改需求:用 B 方案", "followUp");
		assert.equal(via, "queued");
		assert.deepEqual(rpc.sent, [], "排队不产生 RPC");
		assert.equal(manager.sm.records.get(ID).state, "running", "状态不动");
	});

	test("settled 后 flush:报告先送达,随后 prompt 新轮(排队文本合并为一条)", async () => {
		const { manager, delivered, add } = setup();
		const rpc = add(ID, "hank", "running");
		await manager.message(ID, "改需求:用 B 方案", "followUp");
		await manager.message(ID, "再加证据 C", "followUp");
		const cmds = [];
		const orig = rpc.send.bind(rpc);
		rpc.send = async (cmd) => {
			cmds.push(cmd);
			return orig(cmd);
		};
		manager.onWorkerEvent(ID, { type: "settled" });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(delivered[0].details.type, "settled", "报告先送达");
		assert.equal(manager.sm.records.get(ID).state, "running", "flush 开新轮");
		const promptCmd = cmds.find((c) => c.type === "prompt");
		assert.ok(promptCmd, cmds.map((c) => c.type).join(","));
		assert.ok(
			promptCmd.message.includes("改需求:用 B 方案") && promptCmd.message.includes("再加证据 C"),
			"排队文本合并入新轮",
		);
	});

	test("stop 清队列:settle 后不 flush(停止语义 = 不追加新轮)", async () => {
		const { manager, add } = setup();
		const rpc = add(ID, "hank", "running");
		await manager.message(ID, "改需求", "followUp");
		await manager.stop(ID); // → stopping,队列清除
		const cmds = [];
		const orig = rpc.send.bind(rpc);
		rpc.send = async (cmd) => {
			cmds.push(cmd);
			return orig(cmd);
		};
		manager.onWorkerEvent(ID, { type: "settled" }); // stopping → idle
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(manager.sm.records.get(ID).state, "idle");
		assert.ok(!cmds.some((c) => c.type === "prompt"), "stop 后不 flush");
	});

	test("代次隔离:旧代次排队不泄入新代次(exit 清队列)", async () => {
		const { manager, add } = setup();
		const rpc1 = add(ID, "hank", "running");
		await manager.message(ID, "旧代次的需求", "followUp");
		// gen1 崩溃:running → failed,句柄回收(dropHandle 清队列)
		manager.onWorkerEvent(ID, { type: "exited", code: 1, signal: null, stderrTail: "boom" });
		// gen2:同 id 重跑(终端记录被替换)
		const rpc2 = add(ID, "hank", "running");
		const cmds = [];
		const orig = rpc2.send.bind(rpc2);
		rpc2.send = async (cmd) => {
			cmds.push(cmd);
			return orig(cmd);
		};
		manager.onWorkerEvent(ID, { type: "settled" });
		await new Promise((r) => setTimeout(r, 20));
		assert.ok(!cmds.some((c) => c.type === "prompt"), "旧代次队列不泄入新代次");
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
	test("stop 落 stopStartedAt(面板倒计时数据源)", async () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		const p = manager.stop("pi-worker-hank#aaaaaa"); // sm.stop 同步生效,无需 fake timers
		const rec = manager.sm.records.get("pi-worker-hank#aaaaaa");
		assert.equal(rec.state, "stopping");
		assert.ok(typeof rec.stopStartedAt === "number", "倒计时起点落记录");
		await p;
	});

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
		assert.deepEqual(rpc.sent, ["get_session_stats", "get_messages"]); // turn_end 先拉快照,settled 复用
		assert.equal(delivered[0].details.type, "settled");
		assert.equal(delivered[0].details.report, "报告全文");
		assert.equal(delivered[0].details.turns, 1);
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").report, "报告全文");
	});

	test("settled 时句柄已回收(exit 先到):回调仍送达(占位呈报),不静默丢", async () => {
		// 真实时序:oneshot worker agent_settled 与进程 exit 顺序不定;exit 先处理
		// 则 handle 已回收。此时 settled 必须仍投递回调(占位呈报),不能 return——
		// 否则状态 idle 但父看不到任何回调(用户报告场景)。
		const { manager, delivered, add } = setup();
		const id = "pi-worker-hank#aaaaaa";
		add(id, "hank", "running");
		// 模拟 exit 先到且句柄被回收,但状态仍可 settled(进程退出码 0、settled 事件后到)
		manager.handles.delete(id);
		manager.onWorkerEvent(id, { type: "settled" });
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(manager.sm.records.get(id).state, "idle", "settled 应迁移 idle");
		assert.ok(delivered.length >= 1, "settled 后必须有回调,不能静默丢");
		const last = delivered[delivered.length - 1];
		assert.equal(last.details.type, "settled");
		assert.equal(typeof last.details.reportError, "string", "回调应带诊断占位(reportError 存在)");
	});

	test("get_messages 路径:末条 assistant 取 text,排除 thinking/toolCall,stopReason 透传", async () => {
		const { manager, delivered, add } = setup();
		const id = "pi-worker-hank#aaaaaa";
		const rpc = add(id, "hank", "running");
		rpc.send = async (cmd) => {
			rpc.sent.push(cmd.type);
			if (cmd.type === "get_messages")
				return {
					messages: [
						{ role: "user", content: "do it" },
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "想" },
								{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
								{ type: "text", text: "最终报告正文" },
							],
							stopReason: "stop",
						},
					],
				};
			if (cmd.type === "get_session_stats") return { tokens: { total: 9 } };
			return { ok: true };
		};
		manager.onWorkerEvent(id, { type: "settled" });
		await new Promise((r) => setTimeout(r, 10));
		const last = delivered[delivered.length - 1];
		assert.equal(last.details.report, "最终报告正文", "应取末条 assistant 的 text 块");
		assert.equal(last.details.stopReason, "stop", "stopReason 应透传");
		assert.equal(manager.sm.records.get(id).stopReason, "stop");
	});

	test("get_messages 路径:末条 assistant 仅 toolCall 无 text(报告经 send_message)→ report 空占位,stopReason=aborted 透传", async () => {
		const { manager, delivered, add } = setup();
		const id = "pi-worker-hank#aaaaaa";
		const rpc = add(id, "hank", "running");
		rpc.send = async (cmd) => {
			rpc.sent.push(cmd.type);
			if (cmd.type === "get_messages")
				return {
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "旧文本(不该被取)" }] },
						{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "send_message", arguments: {} }], stopReason: "aborted" },
					],
				};
			if (cmd.type === "get_session_stats") return { tokens: { total: 9 } };
			return { ok: true };
		};
		manager.onWorkerEvent(id, { type: "settled" });
		await new Promise((r) => setTimeout(r, 10));
		const last = delivered[delivered.length - 1];
		assert.equal(last.details.report, "", "末条无 text 不回退残留,留空走占位");
		assert.equal(last.details.stopReason, "aborted", "aborted 应透传(父需知中断)");
		assert.ok(last.content.includes("<report>"), "内容应有占位(report 块存在)");
		assert.ok(last.content.includes("<stop_reason>aborted</stop_reason>"), "非正常收尾应进模板");
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
			delivered.some((m) => m.details.type === "failed"),
			"诊断回调送达而非 throw",
		);
	});

	test("bus resolve:仅 running/idle 可寻址;failed 终态出局(不可收消息)", async () => {
		const { manager, add } = setup();
		add("pi-worker-seal#bbbbbb", "seal", "idle");
		manager.sm.onExit("pi-worker-seal#bbbbbb", { code: 1, signal: null, stderrTail: "" });
		const result = await manager.bus.post("parent", "seal", "hi");
		assert.equal(result.ok, false);
		assert.ok(String(result.reason ?? "").length > 0, "不可寻址显式失败(reason 存在)");
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
		assert.throws(() => manager.collect("pi-worker-hank#aaaaaa", "通过"), /kill first or wait for settled/);
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").verdict, undefined);
	});
});

describe("collect 落收起标记(审计留痕)", () => {
	test("collect:session 文件尾追加 pi-worker-collected 条目(verdict 入标记,终审留痕)", async () => {
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

	test("kill 落收起标记:终态决策持久化,重启不复活(kill 与 collect 同款)", async () => {
		const { manager, add } = setup();
		const dir = mkdtempSync(join(tmpdir(), "piw-killmark-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/r" }) + "\n");
		const id = "pi-worker-hank#aaaaaa";
		add(id, "hank", "running");
		manager.sm.records.get(id).sessionFile = file;
		await manager.kill(id); // → killing
		manager.onWorkerEvent(id, { type: "exited", code: 0, signal: null, stderrTail: "" }); // killing → done
		assert.equal(manager.sm.records.get(id).state, "done");
		const tail = readFileSync(file, "utf8");
		assert.ok(tail.includes('"pi-worker-collected"'), "kill 后落收起标记(重启不复活)");
	});

	test("killAll 不落收起标记(shutdown 非决策):G1 重启认领保留", async () => {
		const { manager, add } = setup();
		const cwd = mkdtempSync(join(tmpdir(), "piw-killall-"));
		const dir = workerSessionDir(cwd);
		mkdirSync(dir, { recursive: true });
		const id = "pi-worker-hank#0123456789ab";
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", version: 3, id: "uuid-1", timestamp: "2026-08-12T10:00:00.000Z", cwd }),
				JSON.stringify({ type: "session_info", id: "k1", parentId: null, timestamp: "2026-08-12T10:00:01.000Z", name: id }),
			].join("\n") + "\n",
		);
		add(id, "hank", "running");
		manager.sm.records.get(id).sessionFile = file;
		manager.killAll(); // session_shutdown:连带 kill,不是对 deliverable 的决策
		manager.onWorkerEvent(id, { type: "exited", code: 0, signal: null, stderrTail: "" }); // killing → done
		assert.equal(manager.sm.records.get(id).state, "done");
		assert.ok(!readFileSync(file, "utf8").includes(COLLECTED_MARKER), "shutdown 连带 kill 不落标(重启认领存活)");
		const manager2 = new WorkerManager({ deliver: () => {}, onChange: () => {} });
		assert.equal(await manager2.claimLeftovers(cwd), 1, "新实例重启认领遗留 worker");
	});

	test("killAll 不落标记:shutdown 不是终态决策,重启认领(G1)保留", async () => {
		const { manager, add } = setup();
		const dir = mkdtempSync(join(tmpdir(), "piw-killallmark-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/r" }) + "\n");
		const id = "pi-worker-hank#aaaaaa";
		add(id, "hank", "running");
		manager.sm.records.get(id).sessionFile = file;
		manager.killAll(); // session_shutdown 连带终止(直调 sm.kill,不经 kill())
		manager.onWorkerEvent(id, { type: "exited", code: 0, signal: null, stderrTail: "" }); // killing → done
		assert.equal(manager.sm.records.get(id).state, "done");
		const tail = readFileSync(file, "utf8");
		assert.ok(!tail.includes('"pi-worker-collected"'), "killAll 不落标(重启可认领冷恢复)");
	});
});

describe("O4 握手授权链(handshake:new_session parentSession → 重取 get_state)", () => {
	const mkHandle = () => {
		const sent = [];
		const rpc = {
			sent,
			send: async (cmd) => {
				sent.push(cmd);
				if (cmd.type === "get_state") return { sessionFile: `/sess/${sent.filter((c) => c.type === "get_state").length}.jsonl` };
				if (cmd.type === "new_session") return { cancelled: false };
				return { ok: true };
			},
		};
		return { rpc, proc: { exitCode: null, signalCode: null, kill() {} }, sessionDir: "/tmp", watcher: { dispose: () => {} } };
	};

	test("有 parentSessionFile:get_state → new_session(parentSession) → 重取 get_state → prompt;sessionFile 以重取为准", async () => {
		const { manager } = setup();
		const id = "pi-worker-hank#aaaaaa";
		manager.sm.run({ id, name: "hank" }); // starting
		const handle = mkHandle();
		await manager.handshake(handle, id, "任务", "/sess/parent.jsonl");
		assert.deepEqual(handle.rpc.sent.map((c) => c.type), ["get_state", "new_session", "get_state", "prompt"]);
		assert.equal(handle.rpc.sent[1].parentSession, "/sess/parent.jsonl", "授权链参数透传");
		assert.equal(manager.sm.records.get(id).sessionFile, "/sess/2.jsonl", "new_session 后的新文件才是带链 header");
		assert.equal(manager.sm.records.get(id).state, "running", "prompt 接受后 onStarted");
	});

	test("无 parentSessionFile(ephemeral 父):跳过 new_session,legacy 序列不回归", async () => {
		const { manager } = setup();
		const id = "pi-worker-hank#aaaaaa";
		manager.sm.run({ id, name: "hank" });
		const handle = mkHandle();
		await manager.handshake(handle, id, "任务");
		assert.deepEqual(handle.rpc.sent.map((c) => c.type), ["get_state", "prompt"]);
		assert.equal(manager.sm.records.get(id).sessionFile, "/sess/1.jsonl");
	});

	test("new_session cancelled → 不重取,无链启动(prompt 照发,legacy 恢复接管)", async () => {
		const { manager } = setup();
		const id = "pi-worker-hank#aaaaaa";
		manager.sm.run({ id, name: "hank" });
		const handle = mkHandle();
		handle.rpc.send = async (cmd) => {
			handle.rpc.sent.push(cmd);
			if (cmd.type === "get_state") return { sessionFile: "/sess/orig.jsonl" };
			if (cmd.type === "new_session") return { cancelled: true };
			return { ok: true };
		};
		await manager.handshake(handle, id, "任务", "/sess/parent.jsonl");
		assert.deepEqual(handle.rpc.sent.map((c) => c.type), ["get_state", "new_session", "prompt"]);
		assert.equal(manager.sm.records.get(id).sessionFile, "/sess/orig.jsonl");
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
		await assert.rejects(() => manager.message(ID, "打回:测试没写"), /follow_up send failed/);
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
		await assert.rejects(() => manager.stop(ID), /stop send failed/);
		assert.equal(manager.sm.records.get(ID).state, "running");
		assert.equal(manager.sm.records.get(ID).stopStartedAt, undefined, "回滚后倒计时起点清除");
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
		await assert.rejects(() => manager.stop(ID), /stop send failed/);
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
			await assert.rejects(() => manager.stop(ID), /stop send failed/);
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

describe("transcriptView(live 事件流+回填 / dead 文件解析;视图零 IO)", () => {
	const entry = (role, text) => ({ type: "entry", entry: { type: "message", message: { role, content: text } } });

	test("live:entry 事件入 buffer;view 触发 get_messages 回填,历史+增量合并且边界去重", async () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "running");
		// 事件先到(回填前):buffer 只有增量
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", entry("user", "任务"));
		assert.equal(manager.transcriptView("pi-worker-hank#aaaaaa").length, 1);
		// 回填完成(假 rpc get_messages 返回「报告全文」assistant):历史替换头部
		await new Promise((r) => setTimeout(r, 20));
		const entries = manager.transcriptView("pi-worker-hank#aaaaaa");
		const roles = entries.map((e) => e.message.role);
		assert.deepEqual(roles, ["assistant", "user"], "回填历史在前 + 事件增量在后(不覆盖不丢)");
	});

	test("回填与飞行事件重叠 → 按内容去重(不双行)", async () => {
		const { manager, add } = setup();
		const rpc = add("pi-worker-hank#aaaaaa", "hank", "running");
		// 让 get_messages 挂起,飞行期塞入与快照同文的消息
		let release;
		const gate = new Promise((r) => (release = r));
		const origSend = rpc.send.bind(rpc);
		rpc.send = async (cmd) => {
			if (cmd.type === "get_messages") {
				await gate;
				return { messages: [{ role: "assistant", content: [{ type: "text", text: "快照含它" }] }] };
			}
			return origSend(cmd);
		};
		manager.transcriptView("pi-worker-hank#aaaaaa"); // 触发回填(挂起)
		await new Promise((r) => setTimeout(r, 5));
		manager.onWorkerEvent("pi-worker-hank#aaaaaa", {
			type: "entry",
			entry: { type: "message", message: { role: "assistant", content: [{ type: "text", text: "快照含它" }] } },
		});
		release();
		await new Promise((r) => setTimeout(r, 20));
		const entries = manager.transcriptView("pi-worker-hank#aaaaaa");
		assert.equal(entries.filter((e) => JSON.stringify(e.message).includes("快照含它")).length, 1, "重叠去重,不双行");
	});

	test("dead(无句柄):session 文件一次性解析缓存;无文件 → 空(视图缺失提示)", async () => {
		const { manager } = setup();
		manager.sm.run({ id: "pi-worker-ghost#bbbbbb", name: "ghost" });
		manager.sm.onStarted("pi-worker-ghost#bbbbbb");
		manager.sm.onSettled("pi-worker-ghost#bbbbbb");
		const rec = manager.sm.records.get("pi-worker-ghost#bbbbbb");
		const dir = mkdtempSync(join(tmpdir(), "pi-worker-dead-"));
		rec.sessionFile = join(dir, "s.jsonl");
		writeFileSync(
			rec.sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "s" }),
				JSON.stringify({ type: "message", id: "e0", parentId: null, message: { role: "user", content: "遗留任务" } }),
			].join("\n") + "\n",
		);
		// 无句柄(dead)→ 文件解析
		const v1 = manager.transcriptView("pi-worker-ghost#bbbbbb");
		assert.equal(v1.length, 1);
		assert.equal(v1[0].message.content, "遗留任务");
		// 缓存:删文件后再读仍是缓存(静态真相,不重读)
		const v2 = manager.transcriptView("pi-worker-ghost#bbbbbb");
		assert.equal(v2, v1, "同一缓存数组(原位语义供投影缓存检出)");
		// 无文件无产物
		manager.sm.run({ id: "pi-worker-none#cccccc", name: "none" });
		manager.sm.onStarted("pi-worker-none#cccccc");
		assert.deepEqual(manager.transcriptView("pi-worker-none#cccccc"), [], "无源 → 空(视图给缺失提示)");
	});

	test("collect 清账 → buffer 删除", async () => {
		const { manager, add } = setup();
		add("pi-worker-hank#aaaaaa", "hank", "idle");
		manager.transcriptView("pi-worker-hank#aaaaaa");
		manager.collect("pi-worker-hank#aaaaaa", "通过");
		assert.equal(manager.transcripts.has("pi-worker-hank#aaaaaa"), false);
	});
});

describe("claimLeftovers(父重启认领:磁盘遗留 → exited 记录,send/collect 恢复出路)", () => {
	function leftoverFixture(cwd, name, { collected = false, timestamp = "2026-08-12T10:00:00.000Z" } = {}) {
		const dir = workerSessionDir(cwd);
		mkdirSync(dir, { recursive: true });
		const lines = [
			{ type: "session", version: 3, id: "uuid-1", timestamp, cwd },
			{ type: "session_info", id: "k1", parentId: null, timestamp: "2026-08-12T10:00:01.000Z", name },
		];
		if (collected) {
			lines.push({ type: "custom", customType: COLLECTED_MARKER, id: "wc", parentId: null, timestamp: "2026-08-12T10:00:03.000Z", data: {} });
		}
		const file = join(dir, `${name}.jsonl`);
		writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		return file;
	}

	test("认领:exited 记录带 sessionFile/cwd/createdAt,name 取显示名", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-clm-"));
		const file = leftoverFixture(cwd, "pi-worker-hank#0123456789ab");
		const { manager } = setup();
		assert.equal(await manager.claimLeftovers(cwd), 1);
		const rec = manager.status("pi-worker-hank#0123456789ab");
		assert.equal(rec.state, "exited");
		assert.equal(rec.processExited, true);
		assert.equal(rec.sessionFile, file);
		assert.equal(rec.cwd, cwd);
		assert.equal(rec.name, "hank");
		assert.equal(rec.createdAt, Date.parse("2026-08-12T10:00:00.000Z"));
	});

	test("幂等:重复认领不重复建记录(session_start 重复触发安全)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-clm-"));
		leftoverFixture(cwd, "pi-worker-hank#0123456789ab");
		const { manager } = setup();
		assert.equal(await manager.claimLeftovers(cwd), 1);
		assert.equal(await manager.claimLeftovers(cwd), 0);
		assert.equal(manager.status().length, 1);
	});

	test("已 collect 的文件不认领(不复活);collect 认领记录后落 marker,新实例扫描排除", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-clm-"));
		leftoverFixture(cwd, "pi-worker-done#0123456789ab", { collected: true });
		const { manager } = setup();
		assert.equal(await manager.claimLeftovers(cwd), 0, "已收起不认领");

		// collect 认领过的记录 → 文件落 marker → 下一次启动(新实例)扫描排除
		const file = leftoverFixture(cwd, "pi-worker-hank#0123456789ab");
		const { manager: m2 } = setup();
		assert.equal(await m2.claimLeftovers(cwd), 1);
		m2.collect("pi-worker-hank#0123456789ab");
		assert.ok(readFileSync(file, "utf8").includes(COLLECTED_MARKER), "collect 落收起标记");
		const { manager: m3 } = setup();
		assert.equal(await m3.claimLeftovers(cwd), 0, "marker 后新实例不再认领");
	});

	test("认领记录可冷恢复寻址:message 走 exited → resume 分支(不抛 'not found')", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piw-clm-"));
		const file = leftoverFixture(cwd, "pi-worker-hank#0123456789ab");
		const { manager } = setup();
		await manager.claimLeftovers(cwd);
		// 认领记录 resume 需要 sessionFile + cwd(spawn 用);resume 本身 spawn 真实进程,
		// 单测只验证寻址与前置条件成立(状态机 exited 分支由 substrate 端到端覆盖)
		const rec = manager.status("pi-worker-hank#0123456789ab");
		assert.ok(rec.sessionFile && rec.cwd, "resume 前置:sessionFile 与 cwd 齐备");
		assert.equal(rec.sessionFile, file);
	});
});
