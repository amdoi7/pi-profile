import { it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	copySharedFiles,
	extensionDir,
	linkPiPackages,
	linkSharedPackages,
} from "../test-helpers/runtime-paths.mjs";

/**
 * 端到端：真实 harness 加载 bash-fish-render 扩展，注册的 bash 工具 execute
 * 跑真实 apply_patch（真实 spawn bash + Go 二进制 + worker 守卫 diff）。
 * 覆盖：index.ts execute 路由、execute.ts 编排、guarded-diff.ts worker 路径。
 */
async function loadRegisteredBashTool(cwd) {
	const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bash-guard-"));
	const tempExtensionDir = path.join(tempRoot, "extension");
	const tempToolDir = path.join(tempExtensionDir, "bash-fish-render");
	await fs.promises.cp(extensionDir("bash-fish-render"), tempToolDir, {
		recursive: true,
		filter: (source) => path.basename(source) !== "node_modules",
	});
	await copySharedFiles(path.join(tempExtensionDir, "_shared"), [
		"final-diff.ts",
		"diff-service.ts",
		"diff-worker.ts",
	]);
	await linkPiPackages(tempExtensionDir, { tui: true });
	await linkSharedPackages(tempExtensionDir);

	// 扩展注册时以 process.cwd() 固定工具 cwd（与内置闭包一致）。
	// chdir 到工作目录后再 import + 调工厂；恢复必须在工厂调用之后。
	const previousCwd = process.cwd();
	process.chdir(cwd);
	const extensionModule = await import(`${pathToFileURL(path.join(tempToolDir, "index.ts")).href}?t=${Date.now()}`);
	let registeredTool;
	extensionModule.default({
		registerTool(definition) {
			registeredTool = definition;
		},
		on() {},
	});
	process.chdir(previousCwd);
	if (!registeredTool) {
		throw new Error("Failed to capture registered bash tool.");
	}
	return { tool: registeredTool, tempRoot };
}

it("bash execute runs a real apply_patch with guarded diff (no hang)", async () => {
	const cwd = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bash-guard-work-")), "workdir");
	await fs.promises.mkdir(cwd, { recursive: true });
	const { tool, tempRoot } = await loadRegisteredBashTool(cwd);
	fs.writeFileSync(path.join(cwd, "hello.txt"), "hello\nworld\n");

	const patch = [
		"*** Begin Patch",
		"*** Update File: hello.txt",
		"@@",
		"-world",
		"+pi",
		"*** End Patch",
	].join("\n");
	const command = `apply_patch '${patch}'`;
	const result = await tool.execute(
		"tc-1",
		{ command },
		new AbortController().signal,
		undefined,
		{
			cwd,
			sessionManager: { getSessionId: () => "s-1", getSessionFile: () => undefined },
			model: { provider: "test", id: "m1" },
		},
	);

	assert.equal(fs.readFileSync(path.join(cwd, "hello.txt"), "utf8"), "hello\npi\n");
	assert.match(result.content[0].text, /Success\. Updated the following files:/);
	assert.ok(Array.isArray(result.details?.patchFiles), "structured patchFiles must be present");
	const [file] = result.details.patchFiles;
	assert.equal(file.path, "hello.txt");
	assert.equal(file.kind, "Update");
	assert.deepEqual(file.changeStats, { additions: 1, deletions: 1, changedLines: 2 });
	// 双侧行号坐标（与 edit 同源的 DisplayDiff）：remove 带 oldLine，add 带 newLine。
	const rows = file.display.rows;
	assert.ok(rows.some((row) => row.kind === "remove" && row.oldLine === 2 && row.content === "world"), JSON.stringify(rows));
	assert.ok(rows.some((row) => row.kind === "add" && row.newLine === 2 && row.content === "pi"), JSON.stringify(rows));
	assert.equal(result.details.diffs, undefined, "legacy single-column string diffs are no longer emitted");
	await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

it("big-buffer rewrite through real bash path completes fast", async () => {
	const cwd = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bash-guard-work-")), "workdir");
	await fs.promises.mkdir(cwd, { recursive: true });
	const { tool, tempRoot } = await loadRegisteredBashTool(cwd);
	const size = 6000;
	const oldText = Array.from({ length: size }, (_, i) => `line-${i}-common-tail`).join("\n");
	fs.writeFileSync(path.join(cwd, "big.txt"), oldText);
	const newText = Array.from({ length: size }, (_, i) => `changed-${i}-common-tail`).join("\n");
	fs.writeFileSync(path.join(cwd, "big.txt"), newText);
	// 命令不含 patch 头→快照为 null；直接验证 guarded diff 计算（另一集成测试已覆盖真实头）。
	// 此用例通过真实文件路径验证大 buffer 的守卫 diff 引擎有界（worker 路径）。
	const { computeGuardedPatchDiffs } = await import(
		`${pathToFileURL(path.join(tempRoot, "extension", "bash-fish-render", "guarded-diff.ts")).href}?t=${Date.now()}`
	);
	const started = Date.now();
	const diffs = await computeGuardedPatchDiffs(cwd, [{ op: "Update", path: "big.txt" }], new Map([["big.txt", oldText]]));
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 5000, `guarded diff too slow: ${elapsed}ms`);
	assert.equal(diffs.length, 1);
	await fs.promises.rm(tempRoot, { recursive: true, force: true });
});
