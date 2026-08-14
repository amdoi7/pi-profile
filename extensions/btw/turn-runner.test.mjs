import { test } from "vitest";
import assert from "node:assert/strict";

import { TurnRunner, applyTurnEvent, collectThreadEntries } from "./turn-runner.ts";

function baseDeps(overrides = {}) {
	return {
		getModel: () => ({ provider: "test", id: "mock", api: "openai-responses" }),
		hasCredentials: () => true,
		ensureSideSession: async () => ({
			prompt: async () => {},
			getLastAssistantMessage: () => ({
				content: [{ type: "text", text: "answer text" }],
				stopReason: "stop",
			}),
		}),
		getThinkingLevel: () => "off",
		setStatus: () => {},
		notify: () => {},
		onTurnComplete: () => {},
		...overrides,
	};
}

test("parallel tool_execution_end events are matched by toolCallId, not toolName", () => {
	const turn = { question: "q", answer: "", toolCalls: [], state: "running" };
	applyTurnEvent(turn, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "read",
		args: { path: "a.ts" },
	});
	applyTurnEvent(turn, {
		type: "tool_execution_start",
		toolCallId: "call-2",
		toolName: "read",
		args: { path: "b.ts" },
	});

	// The second, same-name tool finishes first, with an error.
	const status = applyTurnEvent(turn, {
		type: "tool_execution_end",
		toolCallId: "call-2",
		toolName: "read",
		result: {},
		isError: true,
	});

	assert.equal(status, "Streaming side response...");
	// The error must land on the entry that finished (call-2), not the first started one.
	assert.equal(turn.toolCalls[0].status, "running");
	assert.equal(turn.toolCalls[1].status, "error");
	assert.deepEqual(turn.toolCalls[1].args, { path: "b.ts" });
});

test("second concurrent run is rejected while the first is in flight", async () => {
	let releaseCredentials;
	const credentialsGate = new Promise((resolve) => {
		releaseCredentials = resolve;
	});
	let promptCalls = 0;
	const notices = [];
	const completed = [];

	const deps = baseDeps({
		ensureSideSession: async () => {
			await credentialsGate;
			return {
				prompt: async () => {
					promptCalls += 1;
				},
				getLastAssistantMessage: () => ({
					content: [{ type: "text", text: "answer" }],
					stopReason: "stop",
				}),
			};
		},
		notify: (message, level) => notices.push({ message, level }),
		onTurnComplete: (details) => completed.push(details),
	});

	const runner = new TurnRunner();
	const first = runner.run("first question", deps);
	const second = runner.run("second question", deps);
	releaseCredentials();
	await Promise.all([first, second]);

	assert.equal(promptCalls, 1);
	assert.equal(completed.length, 1);
	assert.equal(completed[0].question, "first question");
	assert.ok(notices.some((n) => n.message.includes("still processing")));
});

test("run reports acceptance: false when busy, true otherwise", async () => {
	let promptStarted;
	const startedGate = new Promise((resolve) => {
		promptStarted = resolve;
	});
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});

	const deps = baseDeps({
		ensureSideSession: async () => ({
			prompt: async () => {
				promptStarted();
				await promptGate;
			},
			// No response: the accepted run fails, but it was still accepted.
			getLastAssistantMessage: () => null,
		}),
	});

	const runner = new TurnRunner();
	const first = runner.run("first question", deps);
	await startedGate;

	// Busy: rejected.
	assert.equal(await runner.run("second question", deps), false);

	// The first (accepted) run completes as a failure after release.
	releasePrompt();
	await first;
	assert.equal(runner.current?.state, "failed");
});

test("onAccepted fires synchronously on claim, and not for a rejected submit", async () => {
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const accepted = [];

	const deps = baseDeps({
		ensureSideSession: async () => ({
			prompt: async () => {
				await promptGate;
			},
			getLastAssistantMessage: () => ({
				content: [{ type: "text", text: "answer" }],
				stopReason: "stop",
			}),
		}),
		onAccepted: () => accepted.push("accepted"),
	});

	const runner = new TurnRunner();
	const first = runner.run("first question", deps);
	// Synchronous: the input must be clearable before the turn resolves, not after.
	assert.deepEqual(accepted, ["accepted"]);

	// The rejected second submit keeps its draft: no acceptance callback.
	assert.equal(await runner.run("second question", deps), false);
	assert.deepEqual(accepted, ["accepted"]);

	releasePrompt();
	await first;
	assert.deepEqual(accepted, ["accepted"]);
});

test("message events stream answer text into the running turn", () => {
	const turn = { question: "q", answer: "", toolCalls: [], state: "running" };
	assert.equal(
		applyTurnEvent(turn, {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "streamed " }] },
		}),
		"Streaming side response...",
	);
	applyTurnEvent(turn, {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "streamed more" }] },
	});
	assert.equal(turn.answer, "streamed more");
});

test("events outside a running turn are ignored", () => {
	const runner = new TurnRunner();
	assert.equal(
		runner.applyEvent({ type: "message_update", message: { role: "assistant", content: [] } }),
		null,
	);
	assert.equal(
		runner.applyEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: {} }),
		null,
	);
});

test("failed run keeps the error visible but releases the busy claim", async () => {
	const notices = [];
	const runner = new TurnRunner();
	await runner.run(
		"question",
		baseDeps({
			hasCredentials: () => false,
			notify: (message, level) => notices.push({ message, level }),
		}),
	);

	assert.equal(runner.busy, false);
	assert.equal(runner.current?.state, "failed");
	assert.equal(runner.current?.error, "No credentials available for test/mock.");
	assert.ok(notices.some((n) => n.level === "error"));

	// A retry is accepted after the failure.
	await runner.run(
		"retry question",
		baseDeps({
			hasCredentials: () => false,
		}),
	);
	assert.equal(runner.current?.question, "retry question");
});

test("successful run clears the turn and reports the completed details", async () => {
	const completed = [];
	const statuses = [];
	const runner = new TurnRunner();
	await runner.run(
		"question",
		baseDeps({
			setStatus: (s) => statuses.push(s),
			onTurnComplete: (d) => completed.push(d),
		}),
	);

	assert.equal(runner.busy, false);
	assert.equal(runner.current, null);
	assert.equal(completed.length, 1);
	assert.equal(completed[0].question, "question");
	assert.equal(completed[0].answer, "answer text");
	assert.equal(completed[0].provider, "test");
	assert.equal(completed[0].model, "mock");
	assert.deepEqual(statuses, ["Streaming side response...", "Ready for the next side question."]);
});

test("aborted prompt surfaces as a failed turn", async () => {
	const runner = new TurnRunner();
	await runner.run(
		"question",
		baseDeps({
			ensureSideSession: async () => ({
				prompt: async () => {
					throw new Error("This operation was aborted");
				},
				getLastAssistantMessage: () => null,
			}),
		}),
	);
	assert.equal(runner.current?.state, "failed");
	assert.equal(runner.current?.error, "This operation was aborted");
});

test("用户停止(requestStop + resolve-aborted 形态)落 stopped,不落 failed", async () => {
	const runner = new TurnRunner();
	const statuses = [];
	const notices = [];
	const completed = [];
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const done = runner.run(
		"question",
		baseDeps({
			ensureSideSession: async () => ({
				prompt: async () => {
					await promptGate;
				},
				getLastAssistantMessage: () => ({
					content: [{ type: "text", text: "" }],
					stopReason: "aborted",
				}),
			}),
			setStatus: (s) => statuses.push(s),
			notify: (message, level) => notices.push({ message, level }),
			onTurnComplete: (d) => completed.push(d),
		}),
	);
	assert.equal(runner.requestStop(), true, "busy 时 requestStop 接受");
	releasePrompt();
	await done;
	assert.equal(runner.current?.state, "stopped");
	assert.equal(runner.current?.error, undefined, "用户停止不是错误");
	assert.equal(completed.length, 0, "停止的 turn 不入持久化线程");
	assert.ok(statuses.includes("Stopped."), "status 反馈");
	assert.ok(
		notices.every((n) => n.level !== "error"),
		"用户停止不报 error 级通知",
	);
	assert.equal(runner.busy, false, "stopped 后可接新 turn");
});

test("用户停止(reject 形态 abort)同样落 stopped", async () => {
	const runner = new TurnRunner();
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const done = runner.run(
		"question",
		baseDeps({
			ensureSideSession: async () => ({
				prompt: async () => {
					await promptGate;
					throw new Error("This operation was aborted");
				},
				getLastAssistantMessage: () => null,
			}),
		}),
	);
	runner.requestStop();
	releasePrompt();
	await done;
	assert.equal(runner.current?.state, "stopped");
});

test("requestStop: idle 时不接受", () => {
	const runner = new TurnRunner();
	assert.equal(runner.requestStop(), false);
});

test("reset clears the current turn", async () => {
	const runner = new TurnRunner();
	await runner.run(
		"question",
		baseDeps({
			hasCredentials: () => false,
		}),
	);
	assert.equal(runner.current?.state, "failed");
	runner.reset();
	assert.equal(runner.current, null);
	assert.equal(runner.busy, false);
});

test("reset during a run discards the completed result", async () => {
	let promptStarted;
	const startedGate = new Promise((resolve) => {
		promptStarted = resolve;
	});
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const notices = [];
	const completed = [];

	const runner = new TurnRunner();
	const runPromise = runner.run(
		"question",
		baseDeps({
			ensureSideSession: async () => ({
				prompt: async () => {
					promptStarted();
					await promptGate;
				},
				getLastAssistantMessage: () => ({
					content: [{ type: "text", text: "answer" }],
					stopReason: "stop",
				}),
			}),
			notify: (message, level) => notices.push({ message, level }),
			onTurnComplete: (details) => completed.push(details),
		}),
	);
	await startedGate;
	runner.reset();
	releasePrompt();
	await runPromise;

	// The completed result must not be persisted or shown after the reset.
	assert.equal(completed.length, 0);
	assert.equal(notices.length, 0);
	assert.equal(runner.current, null);
});

test("reset during a failing run suppresses the failure display", async () => {
	let promptStarted;
	const startedGate = new Promise((resolve) => {
		promptStarted = resolve;
	});
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const notices = [];
	const statuses = [];

	const runner = new TurnRunner();
	const runPromise = runner.run(
		"question",
		baseDeps({
			ensureSideSession: async () => ({
				prompt: async () => {
					promptStarted();
					await promptGate;
					throw new Error("aborted by reset");
				},
				getLastAssistantMessage: () => null,
			}),
			notify: (message, level) => notices.push({ message, level }),
			setStatus: (s) => statuses.push(s),
		}),
	);
	await startedGate;
	runner.reset();
	releasePrompt();
	await runPromise;

	assert.equal(runner.current, null);
	assert.equal(notices.length, 0);
	assert.deepEqual(statuses, ["Streaming side response..."]);
});

test("collectThreadEntries keeps only entries after the last reset marker", () => {
	const branch = [
		{ type: "custom", customType: "btw-thread-entry", data: { question: "old", answer: "old answer", timestamp: 1, provider: "p", model: "m", thinkingLevel: "off" } },
		{ type: "custom", customType: "btw-thread-reset", data: { timestamp: 2 } },
		{ type: "custom", customType: "btw-thread-entry", data: { question: "new", answer: "new answer", timestamp: 3, provider: "p", model: "m", thinkingLevel: "off" } },
		{ type: "message", message: { role: "user", content: [] } },
		{ type: "custom", customType: "btw-thread-reset", data: { timestamp: 4 } },
		{ type: "custom", customType: "btw-thread-entry", data: { question: "latest", answer: "latest answer", timestamp: 5, provider: "p", model: "m", thinkingLevel: "off" } },
	];
	const thread = collectThreadEntries(branch);
	assert.equal(thread.length, 1);
	assert.equal(thread[0].question, "latest");
});

test("collectThreadEntries skips entries with missing or empty data", () => {
	const branch = [
		{ type: "custom", customType: "btw-thread-entry", data: undefined },
		{ type: "custom", customType: "btw-thread-entry", data: { question: "q", answer: "", timestamp: 1, provider: "p", model: "m", thinkingLevel: "off" } },
		{ type: "custom", customType: "btw-thread-entry", data: { question: "ok", answer: "ok answer", timestamp: 2, provider: "p", model: "m", thinkingLevel: "off" } },
		{ type: "custom", customType: "other-type", data: {} },
	];
	assert.deepEqual(
		collectThreadEntries(branch).map((d) => d.question),
		["ok"],
	);
});
