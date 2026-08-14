import { test } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { attachWatcher } from "../src/watcher.ts";

/** watcher 是纯翻译器:字节流 → WorkerEvent。测试只断言事件序列,无状态机。 */

class FakeRpc extends EventEmitter {
	on(event, cb) {
		if (event !== "event" && event !== "exit") return () => {};
		super.on(event, cb);
		return () => this.off(event, cb);
	}
	emitEvent(ev) {
		this.emit("event", ev);
	}
	emitExit(code, signal) {
		this.emit("exit", code, signal);
	}
}

function setup() {
	const events = new FakeRpc();
	const stderr = new EventEmitter();
	const emitted = [];
	const watcher = attachWatcher({ events, stderr }, (ev) => emitted.push(ev));
	return { events, stderr, emitted, watcher };
}

const sendMessageCall = (events, args, { id = "tc1", isError = false } = {}) => {
	events.emitEvent({ type: "tool_execution_start", toolCallId: id, toolName: "send_message", args });
	events.emitEvent({ type: "tool_execution_end", toolCallId: id, toolName: "send_message", result: {}, isError });
};

test("send_message 成功执行 → message 事件(to 缺省归 parent;quiet 缺省 false)", () => {
	const { events, emitted } = setup();
	sendMessageCall(events, { text: "进展同步" });
	sendMessageCall(events, { to: "seal", text: "证据已齐" }, { id: "tc2" });
	sendMessageCall(events, { to: "parent", text: "安静留痕", quiet: true }, { id: "tc3" });
	const messages = emitted.filter((e) => e.type === "message");
	assert.deepEqual(messages, [
		{ type: "message", to: "parent", text: "进展同步", quiet: false },
		{ type: "message", to: "seal", text: "证据已齐", quiet: false },
		{ type: "message", to: "parent", text: "安静留痕", quiet: true },
	]);
});

test("send_message 执行失败(isError)→ 无 message 事件(失败即未发送)", () => {
	const { events, emitted } = setup();
	sendMessageCall(events, { text: "?" }, { isError: true });
	assert.equal(emitted.filter((e) => e.type === "message").length, 0);
});

test("agent_settled / turn_end → settled / turnEnd", () => {
	const { events, emitted } = setup();
	events.emitEvent({ type: "agent_settled" });
	events.emitEvent({ type: "turn_end" });
	assert.deepEqual(emitted, [{ type: "settled" }, { type: "turnEnd" }]);
});

test("exit:携带 code/signal 与 stderr 尾(上限 4096)", () => {
	const { events, stderr, emitted } = setup();
	stderr.emit("data", "x".repeat(5000));
	stderr.emit("data", "boom");
	events.emitExit(1, null);
	assert.equal(emitted.length, 1);
	const ev = emitted[0];
	assert.equal(ev.type, "exited");
	assert.equal(ev.code, 1);
	assert.equal(ev.signal, null);
	assert.equal(ev.stderrTail.length, 4096);
	assert.ok(ev.stderrTail.endsWith("boom"));
});

test("tool_start/end → toolStart/toolEnd,args 提取可读键摘要(40 字符)", () => {
	const { events, emitted } = setup();
	events.emitEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "x".repeat(100) } });
	events.emitEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
	assert.equal(emitted[0].type, "toolStart");
	assert.equal(emitted[0].toolName, "bash");
	assert.equal(emitted[0].args, `${"x".repeat(39)}…`); // 首个标量主语,总长含省略号 40
	assert.deepEqual(emitted[1], { type: "toolEnd", toolName: "bash" });
});

test("tool_start 多标量 → 主语 + key=value(无键白名单,首个标量主语)", () => {
	const { events, emitted } = setup();
	events.emitEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "write", args: { oldText: "a", newText: "b" } });
	assert.ok(emitted[0].args.length <= 40);
	assert.equal(emitted[0].args, "a · newText=b");
});

test("message_end 不产生事件(turn 话语投影已移除);增量(text_delta)亦不产生", () => {
	const { events, emitted } = setup();
	events.emitEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "正在核对" }, { type: "text", text: "测试结果" }] },
	});
	events.emitEvent({ type: "message_end", message: { role: "user", content: "任务" } });
	events.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } });
	assert.equal(emitted.length, 0);
});

test("子 extension dialog → dialog 事件;notify 不产生事件", () => {
	const { events, emitted } = setup();
	events.emitEvent({ type: "extension_ui_request", method: "input", id: "u1" });
	events.emitEvent({ type: "extension_ui_request", method: "select", id: "u2" });
	events.emitEvent({ type: "extension_ui_request", method: "confirm", id: "u3" });
	events.emitEvent({ type: "extension_ui_request", method: "editor", id: "u4" });
	events.emitEvent({ type: "extension_ui_request", method: "notify", message: "随便一句" });
	assert.deepEqual(emitted, [
		{ type: "dialog", id: "u1" },
		{ type: "dialog", id: "u2" },
		{ type: "dialog", id: "u3" },
		{ type: "dialog", id: "u4" },
	]);
});

test("dispose 后事件不再翻译", () => {
	const { events, emitted, watcher } = setup();
	watcher.dispose();
	events.emitEvent({ type: "agent_settled" });
	events.emitExit(1, null);
	assert.deepEqual(emitted, []);
});

test("auto_retry_start → activity 事件(retrying (n/m),grok 词汇);auto_retry_end → 清除", () => {
	const { events, emitted } = setup();
	events.emitEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2000 });
	events.emitEvent({ type: "auto_retry_end", success: true, attempt: 2 });
	assert.deepEqual(emitted, [
		{ type: "activity", phase: "retrying", label: "retrying (2/3)" },
		{ type: "activity", phase: "retrying", label: undefined },
	]);
});

test("compaction_start/end → activity 事件(compacting);字段缺失回退安全", () => {
	const { events, emitted } = setup();
	events.emitEvent({ type: "compaction_start", reason: "threshold" });
	events.emitEvent({ type: "compaction_end", reason: "threshold" });
	events.emitEvent({ type: "auto_retry_start" }); // 缺 attempt/maxAttempts
	assert.deepEqual(emitted, [
		{ type: "activity", phase: "compacting", label: "compacting" },
		{ type: "activity", phase: "compacting", label: undefined },
		{ type: "activity", phase: "retrying", label: "retrying" },
	]);
});
