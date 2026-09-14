import { test } from "vitest";
import assert from "node:assert/strict";
import { executeThenRun } from "/Users/amdoi7/.pi/agent/extensions/edit/then-run.ts";

const outcome = { status: "applied", note: "n", path: "a.txt", cwd: "/tmp", entries: [] };

test("signal 已中止 → aborted,不跑命令", async () => {
	let ran = false;
	const text = await executeThenRun(outcome, { command: "t" }, "/tmp/nonexistent-edit-then-run", async () => { ran = true; return { exitCode: 0, output: "" }; }, AbortSignal.abort());
	assert.equal(ran, false);
	assert.match(text, /\[then_run:aborted\]/);
});

test("runner 抛错且 signal 中止 → aborted 而非 blocked", async () => {
	const text = await executeThenRun(outcome, { command: "t" }, "/tmp/nonexistent-edit-then-run", async () => { throw new Error("killed"); }, AbortSignal.abort());
	assert.match(text, /\[then_run:aborted\]/);
});
