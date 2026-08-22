import { test } from "node:test";
import assert from "node:assert/strict";

import { comparePrefix, describeContext } from "./prefix.ts";

const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "apicursor",
	model: "claude-opus-5",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
});

test("segments are wire-ordered: tools, system, then messages", () => {
	const segments = describeContext({
		systemPrompt: "sys",
		tools: [{ name: "bash" }],
		messages: [user("q"), assistant("a")],
	});
	assert.deepEqual(
		segments.map((s) => s.label),
		["tools", "system", "user#0", "assistant#1"],
	);
});

test("first request of a session is cold, nothing is reused", () => {
	const report = comparePrefix(undefined, describeContext({ systemPrompt: "sys", messages: [user("q")] }));
	assert.equal(report.cold, true);
	assert.equal(report.ratio, 0);
	assert.equal(report.firstDiverged, "system");
});

test("appending a turn keeps every earlier segment stable", () => {
	const before = describeContext({ systemPrompt: "sys", messages: [user("q1")] });
	const after = describeContext({ systemPrompt: "sys", messages: [user("q1"), assistant("a1"), user("q2")] });
	const report = comparePrefix(before, after);
	assert.equal(report.stableSegments, 2);
	assert.equal(report.stableChars, "sys".length + "q1".length);
	assert.equal(report.firstDiverged, "assistant#1");
	assert.equal(report.rewrite, false, "an append must not be reported as a rewrite");
});

test("rewriting an earlier message names it and collapses the ratio", () => {
	const before = describeContext({ systemPrompt: "sys", messages: [user("q1"), assistant("a1"), user("q2")] });
	const after = describeContext({ systemPrompt: "sys", messages: [user("q1"), assistant("a1 EDITED"), user("q2")] });
	const report = comparePrefix(before, after);
	assert.equal(report.firstDiverged, "assistant#1");
	assert.equal(report.stableSegments, 2);
	// "a1" survives as a partial prefix of "a1 EDITED".
	assert.equal(report.stableChars, "sys".length + "q1".length + "a1".length);
	assert.ok(report.ratio < 1);
	assert.equal(report.rewrite, true);
});

test("a changed tool schema poisons everything after it", () => {
	const messages = [user("q1"), assistant("a1"), user("q2")];
	const before = describeContext({ tools: [{ name: "bash" }], systemPrompt: "sys", messages });
	const after = describeContext({ tools: [{ name: "bash", extra: 1 }], systemPrompt: "sys", messages });
	const report = comparePrefix(before, after);
	assert.equal(report.firstDiverged, "tools");
	assert.equal(report.stableSegments, 0);
	assert.ok(report.ratio < 0.6);
	assert.equal(report.rewrite, true);
});

test("compaction that drops history counts as a rewrite", () => {
	const before = describeContext({ systemPrompt: "sys", messages: [user("q1"), assistant("a1"), user("q2")] });
	const after = describeContext({ systemPrompt: "sys", messages: [user("summary of q1/a1"), user("q2")] });
	const report = comparePrefix(before, after);
	assert.equal(report.rewrite, true);
});

test("an identical request reuses the whole payload", () => {
	const context = { systemPrompt: "sys", messages: [user("q1"), assistant("a1")] };
	const report = comparePrefix(describeContext(context), describeContext(context));
	assert.equal(report.ratio, 1);
	assert.equal(report.firstDiverged, undefined);
});
