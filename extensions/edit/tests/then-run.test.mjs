import { test } from "vitest";
import assert from "node:assert/strict";

import { parseEditRequest } from "../index.ts";
import { executeThenRun } from "../then-run.ts";

/** 收集式 commandRunner：记录调用,按脚本回复。 */
function scriptedRunner(replies) {
	const calls = [];
	return {
		calls,
		run: async (command, options) => {
			calls.push({ command, options });
			const reply = replies[calls.length - 1];
			if (reply instanceof Error) throw reply;
			return reply ?? { exitCode: 0, output: "ok" };
		},
	};
}

const baseOutcome = (status) => ({
	status,
	note: "n",
	path: "a.txt",
	cwd: "/tmp",
	entries: [],
});

// ---------- 校验层 ----------

test("then_run 是顶层可选对象;合法形状原样通过", () => {
	const req = parseEditRequest({
		note: "n",
		path: "a.txt",
		edits: [{ match: "x", new_str: "y" }],
		then_run: { command: "npm test", timeout: 30 },
	});
	assert.deepEqual(req.then_run, { command: "npm test", timeout: 30 });
});

test("then_run 缺 command / command 空 / timeout 非正数 都拒绝", () => {
	assert.throws(() => parseEditRequest({
		note: "n", path: "a", edits: [{ match: "x" }], then_run: {},
	}), /then_run\.command must be a non-empty string/);
	assert.throws(() => parseEditRequest({
		note: "n", path: "a", edits: [{ match: "x" }], then_run: { command: "  " },
	}), /then_run\.command must be a non-empty string/);
	assert.throws(() => parseEditRequest({
		note: "n", path: "a", edits: [{ match: "x" }], then_run: { command: "t", timeout: -1 },
	}), /then_run\.timeout must be a positive number/);
});

test("then_run 多余字段被拒绝(严格模式)", () => {
	assert.throws(() => parseEditRequest({
		note: "n", path: "a", edits: [{ match: "x" }], then_run: { command: "t", extra: 1 },
	}), /then_run\.extra must be removed/);
});

// ---------- 执行层语义 ----------

test("rejected 结果不跑命令", async () => {
	const runner = scriptedRunner([]);
	const text = await executeThenRun(baseOutcome("rejected"), { command: "npm test" }, "/tmp", runner.run);
	assert.equal(runner.calls.length, 0);
	assert.match(text, /\[then_run:skipped\]/);
	assert.match(text, /edit script was rejected/);
});

test("applied 跑命令,exit 0 → succeeded + 输出", async () => {
	const runner = scriptedRunner([{ exitCode: 0, output: "5 passed" }]);
	const text = await executeThenRun(baseOutcome("applied"), { command: "npm test" }, "/tmp", runner.run);
	assert.deepEqual(runner.calls.map(c => c.command), ["npm test"]);
	assert.match(text, /\[then_run:succeeded\]/);
	assert.match(text, /5 passed/);
});

test("partial 跑命令并标注 partial", async () => {
	const runner = scriptedRunner([{ exitCode: 0, output: "ok" }]);
	const text = await executeThenRun(baseOutcome("partial"), { command: "npm test" }, "/tmp", runner.run);
	assert.equal(runner.calls.length, 1);
	assert.match(text, /partial/);
	assert.match(text, /\[then_run:succeeded\]/);
});

test("命令非零退出 → failed,但编辑保留", async () => {
	const runner = scriptedRunner([{ exitCode: 2, output: "2 failed" }]);
	const text = await executeThenRun(baseOutcome("applied"), { command: "npm test" }, "/tmp", runner.run);
	assert.match(text, /\[then_run:failed\]/);
	assert.match(text, /exit 2/);
	assert.match(text, /2 failed/);
	assert.match(text, /edit is kept/);
});

test("timeout 透传给 runner", async () => {
	const runner = scriptedRunner([]);
	await executeThenRun(baseOutcome("applied"), { command: "npm test", timeout: 42 }, "/tmp", runner.run);
	assert.equal(runner.calls[0].options.timeout, 42);
});

test("runner 抛错(策略拒绝等) → blocked 语义,不伪装成命令失败", async () => {
	const runner = scriptedRunner([new Error("blocked by command policy: uv")]);
	const text = await executeThenRun(baseOutcome("applied"), { command: "uv run x" }, "/tmp", runner.run);
	assert.match(text, /\[then_run:blocked\]/);
	assert.match(text, /blocked by command policy/);
});
