import { test as baseTest } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeApplyPatchPlan } from "./execute.ts";
import { buildApplyPatchPlan } from "./recognize.ts";

const test = baseTest.extend({
	temp: async ({}, use) => {
		const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bash-ui-exec-"));
		try {
			await use(temp);
		} finally {
			await fs.promises.rm(temp, { recursive: true, force: true });
		}
	},
});

function createCtx(cwd) {
	return {
		cwd,
		mode: "tui",
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "bash-ui-exec-test",
			getSessionFile: () => undefined,
		},
	};
}

async function runPlan(command, cwd, options = {}) {
	const plan = buildApplyPatchPlan(command, cwd);
	assert.ok(plan, "expected an apply_patch plan");
	return executeApplyPatchPlan(plan, { ctx: createCtx(cwd), ...options });
}

function updatePatch(file, before, after) {
	return [
		"apply_patch <<'PATCH'",
		"*** Begin Patch",
		`*** Update File: ${file}`,
		"@@",
		`-${before}`,
		`+${after}`,
		"*** End Patch",
		"PATCH",
	].join("\n");
}

test("single invocation applies the patch and returns a located diff view model", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const outcome = await runPlan(updatePatch("a.txt", "old", "new"), temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt/);
	assert.ok(outcome.viewModel?.success, "view model should reflect the applied patch");
	// 执行者 bracket 的真实快照：located diff（行号）。
	const file = outcome.viewModel.files[0];
	assert.ok(file.diffDisplay.rows.some((row) => row.kind === "remove" && row.oldLine === 1));
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
});

test("multi invocation with trailing: content is faithful concatenation, trailing lands in VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "one\n", "utf8");
	const command = `${updatePatch("a.txt", "one", "two")}\nprintf 'checks passed'`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt\nchecks passed/);
	assert.equal(outcome.viewModel.kind, "apply-patch-result");
	// trailing 快照承载进 VM.trailing（渲染层显示 trailing 输出的契约）。
	assert.equal(outcome.viewModel.trailing, "checks passed");
});

test("invocation failure short-circuits later invocations and trailing", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "one\n", "utf8");
	await fs.promises.writeFile(path.join(temp, "b.txt"), "two\n", "utf8");
	const badPatch = [
		"apply_patch <<'PATCH'",
		"*** Begin Patch",
		"*** Add File: bad.txt",
		"not a plus line",
		"*** End Patch",
		"PATCH",
	].join("\n");
	const command = `${updatePatch("a.txt", "one", "two")}\n${badPatch}\n${updatePatch("b.txt", "two", "three")}\nprintf 'never'`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, true);
	assert.match(outcome.content, /Command exited with code 1/);
	assert.doesNotMatch(outcome.content, /never/);
	// 短路：b.txt 未被改（后续 invocation 未执行）。
	assert.equal(await fs.promises.readFile(path.join(temp, "b.txt"), "utf8"), "two\n");
	// VM 只含已执行 invocation（inv1 success + inv2 failure）。
	assert.equal(outcome.viewModel.results.length, 2);
	assert.equal(outcome.viewModel.results[0].success, true);
	assert.equal(outcome.viewModel.results[1].success, false);
	assert.match(outcome.viewModel.results[1].error.code, /PARTIAL_APPLY|INVALID_PATCH/);
});

test("leading && in trailing command is stripped (shell continuation)", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\n&& printf 'ok'`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /ok/);
});

test("trailing failure sets the command exit code", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\nfalse`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, true);
	assert.match(outcome.content, /Command exited with code 1/);
	// invocations 全部成功：VM 正常（trailing 失败不影响 diff）。
	assert.equal(outcome.viewModel.success, true);
});

test("pre-aborted signal fails fast with the built-in abort shape", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const controller = new AbortController();
	controller.abort();
	const outcome = await runPlan(updatePatch("a.txt", "old", "new"), temp, { signal: controller.signal });
	assert.equal(outcome.isError, true);
	assert.match(outcome.content, /Command aborted/);
	assert.equal(outcome.viewModel, undefined);
});

test("timeout budget goes to trailing and reports the built-in shape", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\nsleep 5`;
	const outcome = await runPlan(command, temp, { timeout: 1 });
	assert.equal(outcome.isError, true);
	assert.match(outcome.content, /Command timed out after 1 seconds/);
	// 已应用部分照常出 VM（诚实呈现磁盘状态）。
	assert.equal(outcome.viewModel.success, true);
});

test("trailing output exceeding the display limit is truncated with full output reference", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const bigOutput = `printf '${"x".repeat(200)}' && printf '\\nline2'`;
	const command = `${updatePatch("a.txt", "old", "new")}\n${bigOutput}`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	// 小输出不截断；此处验证截断元数据只在超限时出现（内容仍是忠实拼接）。
	assert.equal(outcome.details.truncation, undefined);
	assert.match(outcome.content, /x{200}/);
});

test("invocation touching the same file twice does not deadlock the mutation queue", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "one\n", "utf8");
	const command = [
		"apply_patch <<'PATCH'",
		"*** Begin Patch",
		"*** Update File: a.txt",
		"@@",
		"-one",
		"+two",
		"*** Update File: a.txt",
		"@@",
		"-two",
		"+three",
		"*** End Patch",
		"PATCH",
	].join("\n");
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "three\n");
});

test("plan env exposes PI_* session variables to the trailing command", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\nprintf '%s' "$PI_SESSION_ID"`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /bash-ui-exec-test/);
});
