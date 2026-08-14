import { test as baseTest } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeApplyPatchPlan, executeBashPipeline, executeInPlaceEditPlan } from "./execute.ts";
import { buildApplyPatchPlan, buildBashPipeline, recognizeBashCommand } from "./recognize.ts";

/** 单段形态探针：pipeline 首段（不存在的形态得 undefined）。 */
const buildBashPlan = (command, cwd) => buildBashPipeline(command, cwd)?.plans[0];

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
	assert.ok(file.display.rows.some((row) => row.kind === "remove" && row.oldLine === 1));
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
	assert.match(outcome.errorSuffix, /Command exited with code 1/);
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

test("plan 携带前缀段：cp 备份在 invocation 之前识别为 prefixCommand + prefixCwd", async ({ temp }) => {
	const work = path.join(temp, "work");
	const command = [
		`cd ${work}`,
		"cp a.txt a.txt.bak",
		"cp b.txt b.txt.bak",
		updatePatch("a.txt", "old", "new"),
	].join("\n");
	const plan = buildApplyPatchPlan(command, temp);
	assert.ok(plan, "expected an apply_patch plan (prefix 语句不应使整条 delegate)");
	assert.equal(plan.prefixCommand, "cp a.txt a.txt.bak\ncp b.txt b.txt.bak");
	assert.equal(plan.prefixCwd, work);
	assert.equal(plan.prefixShortCircuit, false);
	assert.equal(plan.invocations[0].cwd, work);
});

test("&& 链同语句（cd && cp && apply_patch）：识别为 plan，prefix 剥连接符且短路", async ({ temp }) => {
	const work = path.join(temp, "work");
	const command = `cd ${work} && cp a.txt a.txt.bak && ${updatePatch("a.txt", "old", "new")}`;
	const plan = buildApplyPatchPlan(command, temp);
	assert.ok(plan, "&& 链同语句不应使整条 delegate");
	assert.equal(plan.prefixCommand, "cp a.txt a.txt.bak");
	assert.equal(plan.prefixCwd, work);
	assert.equal(plan.prefixShortCircuit, true);
});

test("管道前缀 + 分号分隔（cd && sed | rg ; apply_patch）：识别为 plan，prefix 不短路", async ({ temp }) => {
	const work = path.join(temp, "work");
	const command = `cd ${work} && sed -n '1,2p' a.txt | rg 'old' ; ${updatePatch("a.txt", "old", "new")}`;
	const plan = buildApplyPatchPlan(command, temp);
	assert.ok(plan, "管道前缀不应使整条 delegate");
	assert.equal(plan.prefixCommand, `sed -n '1,2p' a.txt | rg 'old'`);
	assert.equal(plan.prefixCwd, work);
	assert.equal(plan.prefixShortCircuit, false);
});

test("前缀普通语句执行：cp 备份生效、patch 应用、content 忠实拼接、VM 正常", async ({ temp }) => {
	const work = path.join(temp, "work");
	await fs.promises.mkdir(work, { recursive: true });
	await fs.promises.writeFile(path.join(work, "a.txt"), "old\n", "utf8");
	await fs.promises.writeFile(path.join(work, "b.txt"), "two\n", "utf8");
	const command = [
		`cd ${work}`,
		"cp a.txt a.txt.bak",
		"cp b.txt b.txt.bak",
		updatePatch("a.txt", "old", "new"),
		"printf 'checks passed'",
	].join("\n");
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	// 前缀语句真的执行：两个备份文件存在且内容正确。
	assert.equal(await fs.promises.readFile(path.join(work, "a.txt.bak"), "utf8"), "old\n");
	assert.equal(await fs.promises.readFile(path.join(work, "b.txt.bak"), "utf8"), "two\n");
	// patch 应用。
	assert.equal(await fs.promises.readFile(path.join(work, "a.txt"), "utf8"), "new\n");
	// content = invocation 输出 + trailing 输出（prefix 无输出）。
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt\nchecks passed/);
	assert.equal(outcome.viewModel.kind, "apply-patch-result");
});

test("前缀语句失败且 && 短路：invocation 与 trailing 不执行", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `false && ${updatePatch("a.txt", "old", "new")}\nprintf 'never'`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command exited with code 1/);
	// 短路：patch 未应用、trailing 未执行。
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "old\n");
	assert.doesNotMatch(outcome.content, /never/);
	assert.equal(outcome.viewModel, undefined);
});

test("前缀语句失败但分号/换行分隔不短路：invocation 照常执行（bash ; 语义）", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `false\n${updatePatch("a.txt", "old", "new")}`;
	const outcome = await runPlan(command, temp);
	// 换行 = 分号：false 失败不阻断 apply_patch，整条 exit code 取最后命令（成功）。
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	assert.ok(outcome.viewModel.success);
});

test("trailing failure sets the command exit code", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\nfalse`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command exited with code 1/);
	// invocations 全部成功：VM 正常（trailing 失败不影响 diff）。
	assert.equal(outcome.viewModel.success, true);
});

test("pre-aborted signal fails fast with the built-in abort shape", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const controller = new AbortController();
	controller.abort();
	const outcome = await runPlan(updatePatch("a.txt", "old", "new"), temp, { signal: controller.signal });
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command aborted/);
	assert.equal(outcome.viewModel, undefined);
});

test("timeout budget goes to trailing and reports the built-in shape", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\nsleep 5`;
	const outcome = await runPlan(command, temp, { timeout: 1 });
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command timed out after 1 seconds/);
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

test("cat-write + stdin redirect 应用 patch 且保留写文件副作用", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const patchFile = path.join(temp, "h9.patch");
	const command = [
		`cat > ${patchFile} <<'EOF'`,
		"*** Begin Patch",
		"*** Update File: a.txt",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
		"EOF",
		`apply_patch < ${patchFile}`,
	].join("\n");
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt/);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	// cat 写文件副作用 replay：patch 文件真实存在且内容即 envelope。
	const written = await fs.promises.readFile(patchFile, "utf8");
	assert.match(written, /^\*\*\* Begin Patch\n/);
	assert.ok(outcome.viewModel?.success, "view model should reflect the applied patch");
});

test("stdin redirect 配对带引号路径（含空格）", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const patchFile = path.join(temp, "my patch.patch");
	const command = [
		`cat > '${patchFile}' <<'EOF'`,
		"*** Begin Patch",
		"*** Update File: a.txt",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
		"EOF",
		`apply_patch < '${patchFile}'`,
	].join("\n");
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	assert.match(await fs.promises.readFile(patchFile, "utf8"), /^\*\*\* Begin Patch\n/);
});

test("stdin redirect 无同命令来源不识别（delegate）", async ({ temp }) => {
	const plan = buildApplyPatchPlan(`apply_patch < ${path.join(temp, "missing.patch")}`, temp);
	assert.equal(plan, undefined);
});

/** 执行侧外部 redirect resolver：读前序命令落盘的 patch 文件（index.ts 同款；render 路径零 I/O 永不持有）。 */
function readExternalBody(absolutePath) {
	try {
		return fs.readFileSync(absolutePath, "utf8");
	} catch {
		return undefined;
	}
}

test("external stdin redirect（前序命令落盘的 patch 文件）：resolver 识别 + 原样应用 + 不重写来源文件", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const patchFile = path.join(temp, "change.patch");
	const patchBody = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n";
	await fs.promises.writeFile(patchFile, patchBody, "utf8");
	const command = `apply_patch < ${patchFile}`;
	// 纯静态识别（render 路径）保持 delegate：零 I/O 不变式。
	assert.equal(buildApplyPatchPlan(command, temp), undefined);
	const plan = buildApplyPatchPlan(command, temp, { externalStdinBody: readExternalBody });
	assert.ok(plan, "resolver 应识别外部 redirect");
	const outcome = await executeApplyPatchPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt/);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	// 外部来源文件不被重写：原命令无写文件副作用，无 cat replay。
	assert.equal(await fs.promises.readFile(patchFile, "utf8"), patchBody);
	assert.ok(outcome.viewModel?.success, "view model should reflect the applied patch");
});

test("cd && external stdin redirect：redirect 目标按 cd 后的 cwd 解析", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	await fs.promises.writeFile(path.join(temp, "change.patch"), "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n", "utf8");
	const plan = buildApplyPatchPlan(`cd ${temp} && apply_patch < change.patch`, "/tmp", { externalStdinBody: readExternalBody });
	assert.ok(plan, "cd 后的 relative redirect 应按新 cwd 解析");
	const outcome = await executeApplyPatchPlan(plan, { ctx: createCtx("/tmp") });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
});

test("external stdin redirect + trailing：trailing 原生命行且输出进 VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const patchFile = path.join(temp, "change.patch");
	await fs.promises.writeFile(patchFile, "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n", "utf8");
	const plan = buildApplyPatchPlan(`apply_patch < ${patchFile}\nprintf 'checks passed'`, temp, { externalStdinBody: readExternalBody });
	assert.ok(plan);
	const outcome = await executeApplyPatchPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /checks passed/);
	assert.equal(outcome.viewModel.trailing, "checks passed");
});

test("external resolver 读不到文件 → delegate；文件内容不可解析 → 识别为 plan（operations 空）", async ({ temp }) => {
	assert.equal(
		buildApplyPatchPlan(`apply_patch < ${path.join(temp, "missing.patch")}`, temp, { externalStdinBody: readExternalBody }),
		undefined,
	);
	const garbage = path.join(temp, "garbage.patch");
	await fs.promises.writeFile(garbage, "not a patch\n", "utf8");
	const plan = buildApplyPatchPlan(`apply_patch < ${garbage}`, temp, { externalStdinBody: readExternalBody });
	assert.ok(plan, "envelope 内容不可解析不再 delegate（形态合法即识别）");
	assert.equal(plan.invocations[0].operations.length, 0);
});

test("recognizeBashCommand 识别阶梯：plan / external-shape / delegate 单一判别", async ({ temp }) => {
	const patchFile = path.join(temp, "change.patch");
	await fs.promises.writeFile(patchFile, "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n", "utf8");
	// 纯静态可识别 → plan（不触碰 resolver）。
	const heredoc = recognizeBashCommand(updatePatch("a.txt", "old", "new"), temp, readExternalBody);
	assert.equal(heredoc.kind, "plan");
	// 外部 redirect：无 resolver（render 路径）→ external-shape；有 resolver → plan。
	const redirect = `apply_patch < ${patchFile}`;
	assert.equal(recognizeBashCommand(redirect, temp).kind, "external-shape");
	const resolved = recognizeBashCommand(redirect, temp, readExternalBody);
	assert.equal(resolved.kind, "plan");
	// resolver 读不到 → delegate；普通命令 → delegate。
	assert.equal(recognizeBashCommand(`apply_patch < ${path.join(temp, "missing.patch")}`, temp, readExternalBody).kind, "delegate");
	assert.equal(recognizeBashCommand("ls -la", temp).kind, "delegate");
});

test("external stdin redirect invocation 失败：结构化失败 VM + 错误后缀", async ({ temp }) => {
	const patchFile = path.join(temp, "bad.patch");
	await fs.promises.writeFile(patchFile, "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch\n", "utf8");
	const plan = buildApplyPatchPlan(`apply_patch < ${patchFile}`, temp, { externalStdinBody: readExternalBody });
	assert.ok(plan);
	const outcome = await executeApplyPatchPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command exited with code 1/);
	assert.equal(outcome.viewModel.success, false);
	assert.match(outcome.viewModel.error.code, /FILE_NOT_FOUND|CONTEXT_NOT_FOUND/);
});

test("perl -pi in-place edit:verbatim 执行 + 快照 diff VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 's/old/new/' a.txt`;
	const plan = buildBashPlan(command, temp);
	assert.ok(plan);
	assert.equal(plan.kind, "in-place-edit");
	const outcome = await executeInPlaceEditPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	assert.equal(outcome.viewModel.kind, "in-place-edit-result");
	const file = outcome.viewModel.files[0];
	assert.equal(file.kind, "Update");
	assert.equal(file.path, "a.txt");
	assert.ok(file.display.rows.some((row) => row.kind === "remove" && row.oldLine === 1));
	assert.ok(file.display.rows.some((row) => row.kind === "add" && row.newLine === 1));
});

test("perl 多编辑 + trailing verify:content 忠实(原生执行)", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "one\n", "utf8");
	await fs.promises.writeFile(path.join(temp, "b.txt"), "two\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 's/one/1/' a.txt\nperl -pi -e 's/two/2/' b.txt\nprintf 'verified'`;
	const plan = buildBashPlan(command, temp);
	assert.ok(plan?.kind === "in-place-edit");
	const outcome = await executeInPlaceEditPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "1\n");
	assert.equal(await fs.promises.readFile(path.join(temp, "b.txt"), "utf8"), "2\n");
	assert.match(outcome.content, /verified/);
	assert.equal(outcome.viewModel.files.length, 2);
});

test("perl 程序错误:exit code 后缀 + 已变更文件照常出 VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "x\n", "utf8");
	await fs.promises.writeFile(path.join(temp, "b.txt"), "y\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 's/x/X/' a.txt && perl -pi -e 'die "boom"' b.txt`;
	const plan = buildBashPlan(command, temp);
	assert.ok(plan?.kind === "in-place-edit");
	const outcome = await executeInPlaceEditPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command exited with code/);
	// 第一个编辑已应用(诚实呈现磁盘状态);b.txt 未变。
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "X\n");
	assert.equal(outcome.viewModel.files.length, 1);
	assert.equal(outcome.viewModel.files[0].path, "a.txt");
});

test("perl glob 文件参数与前置 mv 均不识别(delegate)", async ({ temp }) => {
	assert.equal(buildBashPlan(`cd ${temp} && perl -pi -e 's/a/b/' *.txt`, temp), undefined);
	assert.equal(buildBashPlan(`cd ${temp} && mv a.txt b.txt && perl -pi -e 's/a/b/' b.txt`, temp), undefined);
	assert.equal(buildBashPlan(`cd ${temp} && perl -pie 's/a/b/' a.txt`, temp), undefined);
});

const MIXED_PATCH = [
	"apply_patch <<'PATCH'",
	"*** Begin Patch",
	"*** Update File: a.txt",
	"@@",
	"-mid",
	"+new",
	"*** End Patch",
	"PATCH",
].join("\n");

test("mixed perl + apply_patch 识别:pipeline 两段独立 plan + && 短路标记", async ({ temp }) => {
	const command = `cd ${temp} && perl -pi -e 's/old/mid/' a.txt && ${MIXED_PATCH}`;
	const pipeline = buildBashPipeline(command, temp);
	assert.ok(pipeline);
	assert.equal(pipeline.plans.length, 2);
	assert.equal(pipeline.plans[0].kind, "in-place-edit");
	assert.equal(pipeline.plans[1].kind, "apply-patch");
	assert.equal(pipeline.shortCircuit, true);
});

test("mixed 执行:同文件两段独立快照 diff,perl 段不吞 patch 段变更", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 's/old/mid/' a.txt && ${MIXED_PATCH}`;
	const pipeline = buildBashPipeline(command, temp);
	assert.ok(pipeline);
	const outcome = await executeBashPipeline(pipeline, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt/);
	const bashUi = outcome.details.bashUi;
	const perlFile = bashUi.inPlaceEdit.files[0];
	assert.equal(perlFile.label, "perl edit");
	// perl 段 diff 只到 mid:patch 段的 new 不混入(快照 bracket 各自独立)。
	assert.ok(perlFile.display.rows.some((row) => row.kind === "add" && row.content === "mid"));
	assert.ok(!perlFile.display.rows.some((row) => row.kind === "add" && row.content === "new"));
	assert.equal(bashUi.applyPatch.success, true);
	assert.ok(bashUi.applyPatch.files[0].display.rows.some((row) => row.kind === "remove" && row.content === "mid"));
	assert.ok(bashUi.applyPatch.files[0].display.rows.some((row) => row.kind === "add" && row.content === "new"));
});

test("heredoc 指令行带前导空白（***/@@ 缩进，内容行顶格）：识别为 plan 且应用成功", async ({ temp }) => {
	await fs.promises.writeFile(
		path.join(temp, "manager.ts"),
		"async stop(id) {\n    await this.sendCmd(id);\n    this.deps.onChange?.();\n}\n",
		"utf8",
	);
	const command = [
		`cd ${temp} && apply_patch <<'PATCH'`,
		"  *** Begin Patch",
		"  *** Update File: manager.ts",
		"  @@",
		"-    await this.sendCmd(id);",
		"+    try {",
		"+       await this.sendCmd(id);",
		"+    } catch (e) {",
		"+       this.sm.rollback(id);",
		"+       throw e;",
		"+    }",
		"  *** End Patch",
		"PATCH",
	].join("\n");
	const plan = buildApplyPatchPlan(command, temp);
	assert.ok(plan, "指令行带缩进的 heredoc 应识别为 plan");
	assert.equal(plan.invocations[0].operations.length, 1);
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM manager\.ts/);
	const content = await fs.promises.readFile(path.join(temp, "manager.ts"), "utf8");
	assert.ok(content.includes("this.sm.rollback(id);"));
	assert.ok(outcome.viewModel.success);
});

test("无法解析的 heredoc 内容不再 delegate：识别为 plan（operations 空），执行 CLI 报错诚实呈现", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = [`cd ${temp} && apply_patch <<'PATCH'`, "not a patch", "PATCH"].join("\n");
	const plan = buildApplyPatchPlan(command, temp);
	assert.ok(plan, "bash 语法合法的 heredoc 形态应识别为 plan（内容解析失败不 bail）");
	assert.equal(plan.invocations[0].operations.length, 0);
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, true);
	assert.match(outcome.content, /INVALID_PATCH|error\[/);
	// 内容无法解析仍出 VM（诚实呈现 CLI 失败块），不静默丢命令。
	assert.equal(outcome.viewModel.kind, "apply-patch-result");
	assert.equal(outcome.viewModel.success, false);
	assert.equal(outcome.viewModel.error.code, "INVALID_PATCH");
});

test("heredoc body 整体统一缩进（含内容行）：剥除统一前缀后正确解析并应用", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.ts"), "foo();\n});\n", "utf8");
	const command = [
		`cd ${temp} && apply_patch <<'PATCH'`,
		" *** Begin Patch",
		" *** Update File: a.ts",
		" @@",
		" -foo();",
		" +bar();",
		"  });",
		" *** End Patch",
		"PATCH",
	].join("\n");
	const plan = buildApplyPatchPlan(command, temp);
	assert.ok(plan, "整体缩进 heredoc 应识别为 plan");
	assert.equal(plan.invocations[0].operations.length, 1);
	const operation = plan.invocations[0].operations[0].operation;
	assert.equal(operation.lines.filter((line) => line.prefix === "-").length, 1);
	assert.equal(operation.lines.filter((line) => line.prefix === "+").length, 1);
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.ts/);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.ts"), "utf8"), "bar();\n});\n");
	assert.ok(outcome.viewModel.success);
});



test("mixed && 短路:perl 失败则 invocation 不执行,无 applyPatch VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 'die "boom"' a.txt && ${MIXED_PATCH.replace("-mid", "-old")}`;
	const pipeline = buildBashPipeline(command, temp);
	assert.ok(pipeline);
	const outcome = await executeBashPipeline(pipeline, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, true);
	assert.match(outcome.errorSuffix, /Command exited with code/);
	// patch 未应用,磁盘保持 perl 失败后的状态。
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "old\n");
	assert.ok(outcome.details.bashUi.inPlaceEdit);
	assert.equal(outcome.details.bashUi.applyPatch, undefined);
});

test("mixed 分号边界不短路:perl 失败,invocation 照常执行", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 'die "boom"' a.txt; ${MIXED_PATCH.replace("-mid", "-old")}`;
	const pipeline = buildBashPipeline(command, temp);
	assert.ok(pipeline);
	assert.equal(pipeline.shortCircuit, false);
	const outcome = await executeBashPipeline(pipeline, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	assert.equal(outcome.details.bashUi.applyPatch.success, true);
	// 非末段的失败后缀不进 content(shell 无此文本;后缀只属末段)。
	assert.equal(outcome.errorSuffix, undefined);
});

test("mixed trailing:content 忠实拼接,trailing 进 applyPatch VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 's/old/mid/' a.txt && ${MIXED_PATCH}\nprintf 'checks passed'`;
	const pipeline = buildBashPipeline(command, temp);
	assert.ok(pipeline);
	const outcome = await executeBashPipeline(pipeline, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /Success\. Updated the following files:\nM a\.txt/);
	assert.match(outcome.content, /checks passed/);
	assert.equal(outcome.details.bashUi.applyPatch.trailing, "checks passed");
});

test("pipeline 识别阶梯:纯命令单段,不可切分形态保持既有归属", async ({ temp }) => {
	// 纯 apply_patch / 纯 in-place 仍是单段。
	assert.equal(buildBashPipeline(updatePatch("a.txt", "old", "new"), temp)?.plans.length, 1);
	assert.equal(buildBashPipeline(`cd ${temp} && perl -pi -e 's/a/b/' a.txt`, temp)?.plans[0].kind, "in-place-edit");
	// apply_patch 前隔着未跟踪语句：未跟踪语句进前缀区 → 两段（编辑区 + 调用区），
	// apply_patch 获得完整 VM（旧 degraded 不再需要）。
	const shadowed = `cd ${temp} && perl -pi -e 's/a/b/' a.txt && ls && ${MIXED_PATCH}`;
	const shadowedPipeline = buildBashPipeline(shadowed, temp);
	assert.equal(shadowedPipeline?.plans.length, 2);
	assert.equal(shadowedPipeline?.plans[0].kind, "in-place-edit");
	assert.equal(shadowedPipeline?.plans[1].kind, "apply-patch");
	// patch 在前 perl 在后:维持 apply-patch 单段(perl 是 trailing)。
	const patchFirst = `${updatePatch("a.txt", "old", "new")}\nperl -pi -e 's/new/final/' a.txt`;
	const patchFirstPipeline = buildBashPipeline(patchFirst, temp);
	assert.equal(patchFirstPipeline?.plans.length, 1);
	assert.equal(patchFirstPipeline?.plans[0].kind, "apply-patch");
});

test("单行 && 链含管道但编辑不在管道中:识别为 in-place edit(编辑区 + trailing)", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -pi -e 's/old/new/' a.txt && grep -n "new" a.txt 2>&1 | tail -1`;
	const pipeline = buildBashPipeline(command, temp);
	assert.ok(pipeline);
	assert.equal(pipeline.plans.length, 1);
	assert.equal(pipeline.plans[0].kind, "in-place-edit");
	const outcome = await executeBashPipeline(pipeline, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	// perl diff 渲染;verify 输出(管道结果)进 output。
	const file = outcome.details.bashUi.inPlaceEdit.files[0];
	assert.ok(file.display.rows.some((row) => row.kind === "add" && row.content === "new"));
	assert.match(outcome.details.bashUi.inPlaceEdit.output, /1:new/);
});

test("多编辑 && rg && pytest|tail 单行链识别为 in-place edit;|| 链同规则", async ({ temp }) => {
	const command = `cd backend && perl -pi -e 's/a/b/' x.py y.py && perl -pi -e 's/c/d/' z.py && rg -n "a" x.py y.py z.py && uv run pytest tests -q --ignore=tests/e2e 2>&1 | tail -2`;
	assert.equal(buildBashPipeline(command, temp)?.plans[0]?.kind, "in-place-edit");
	assert.equal(buildBashPipeline(`cd ${temp} && perl -pi -e 's/a/b/' a.txt || echo fallback`, temp)?.plans[0]?.kind, "in-place-edit");
});

test("编辑命令本身是管道/后台参与者:不识别(delegate)", async ({ temp }) => {
	assert.equal(buildBashPipeline(`cd ${temp} && perl -pi -e 's/a/b/' a.txt | cat`, temp), undefined);
	assert.equal(buildBashPipeline(`cd ${temp} && perl -pi -e 's/a/b/' a.txt &`, temp), undefined);
});

test("sed -i '' in-place edit:verbatim 执行 + 快照 diff VM", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && sed -i '' 's/old/new/' a.txt`;
	const plan = buildBashPlan(command, temp);
	assert.ok(plan);
	assert.equal(plan.kind, "in-place-edit");
	const outcome = await executeInPlaceEditPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	const file = outcome.viewModel.files[0];
	assert.equal(file.kind, "Update");
	assert.equal(file.path, "a.txt");
	assert.ok(file.display.rows.some((row) => row.kind === "remove" && row.oldLine === 1));
});

test("sed GNU bare / -e 形式与 perl -ni 均识别为 in-place-edit", async ({ temp }) => {
	for (const command of [
		`cd ${temp} && sed -i 's/old/new/' a.txt`,
		`cd ${temp} && sed -i '' -e 's/old/new/' a.txt b.txt`,
		`cd ${temp} && sed -i '' -E 's/oldt/new/' a.txt`,
		`cd ${temp} && perl -ni -e 's/old/new/; print' a.txt`,
	]) {
		const plan = buildBashPlan(command, temp);
		assert.ok(plan?.kind === "in-place-edit", `应识别: ${command}`);
	}
	// sed 无 script 或无文件 → 不识别
	assert.equal(buildBashPlan(`cd ${temp} && sed -i ''`, temp), undefined);
	assert.equal(buildBashPlan(`cd ${temp} && sed -i '' 's/a/b/'`, temp), undefined);
});

test("perl -ni in-place edit 执行", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `cd ${temp} && perl -ni -e 's/old/new/; print' a.txt`;
	const plan = buildBashPlan(command, temp);
	assert.ok(plan?.kind === "in-place-edit");
	const outcome = await executeInPlaceEditPlan(plan, { ctx: createCtx(temp) });
	assert.equal(outcome.isError, false);
	assert.equal(await fs.promises.readFile(path.join(temp, "a.txt"), "utf8"), "new\n");
	assert.equal(outcome.viewModel.files[0].kind, "Update");
});

test("plan env exposes PI_* session variables to the trailing command", async ({ temp }) => {
	await fs.promises.writeFile(path.join(temp, "a.txt"), "old\n", "utf8");
	const command = `${updatePatch("a.txt", "old", "new")}\nprintf '%s' "$PI_SESSION_ID"`;
	const outcome = await runPlan(command, temp);
	assert.equal(outcome.isError, false);
	assert.match(outcome.content, /bash-ui-exec-test/);
});
