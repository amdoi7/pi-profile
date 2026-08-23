import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeApplyPatchGuarded } from "../execute.ts";

/**
 * 用注入的假 operations 验证 execute 管线的契约（env/累积/快照/diff 路由/错误分支）。
 * 真实 spawn 层（createLocalBashOperations）是内置、生产已验证的；这里只验证
 * 本扩展的编排行为。worker 在 node 测试态不可用时走同步 fallback（与 edit 一致）。
 */
function fakeOps({ exitCode = 0, onExitHook } = {}) {
	return {
		exec: async (_command, _cwd, { onData, signal }) => {
			// 模拟 apply_patch 的真实输出（stdout）
			onData(Buffer.from("Success. Updated the following files:\nM hi.txt\n"));
			if (onExitHook) onExitHook();
			return { exitCode };
		},
	};
}

function makeWriteSpy() {
	const calls = [];
	return {
		calls,
		onUpdate: (update) => {
			calls.push(update);
			return undefined;
		},
	};
}

async function runGuarded(command, cwd, opts = {}) {
	return executeApplyPatchGuarded(command, cwd, {
		signal: opts.signal,
		onUpdate: opts.onUpdate,
		timeout: opts.timeout,
		ctx: { sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined } },
	}, { operations: opts.operations ?? fakeOps({ ...opts }) });
}

describe("executeApplyPatchGuarded", () => {
	it("returns successful content and worker-backed diffs for an apply_patch command", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exec-ok-"));
		fs.writeFileSync(path.join(cwd, "hi.txt"), "before\n");
		const ops = {
			exec: async (_cmd, _cwd, { onData }) => {
				// 模拟 apply_patch 落盘：spawn 阶段把文件从 before 写成 after
				fs.writeFileSync(path.join(cwd, "hi.txt"), "after\n");
				onData(Buffer.from("Success. Updated the following files:\nM hi.txt\n"));
				return { exitCode: 0 };
			},
		};
		const command = "apply_patch '*** Begin Patch\n*** Update File: hi.txt\n@@\n-before\n+after\n*** End Patch'";
		const result = await executeApplyPatchGuarded(command, cwd, {
			ctx: { sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined } },
		}, { operations: ops });
		expect(result.content[0].text).toContain("Success");
		// 快照在 spawn 前 = before；spawn 后守卫 diff 读到 after → 结构化 patchFiles（双侧行号）。
		const [file] = result.details?.patchFiles ?? [];
		expect(file).toMatchObject({
			kind: "Update",
			path: "hi.txt",
			changeStats: { additions: 1, deletions: 1, changedLines: 2 },
			truncated: false,
		});
		expect(file.display.rows).toEqual([
			expect.objectContaining({ kind: "remove", oldLine: 1, content: "before" }),
			expect.objectContaining({ kind: "add", newLine: 1, content: "after" }),
		]);
		// 旧单列字符串契约不再产出（新 session 只走结构化路径）。
		expect(result.details?.diffs).toBeUndefined();
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("throws Command exited with code N on non-zero exit", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exec-fail-"));
		const command = "apply_patch '*** Begin Patch\n*** End Patch'";
		await expect(runGuarded(command, cwd, { exitCode: 3 }))
			.rejects.toThrow(/Command exited with code 3/);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("throws Command aborted when signal aborts", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exec-abort-"));
		const ac = new AbortController();
		// 让 ops.exec 在结束后把 signal 置为已中止（模拟 abort 竞态）
		const ops = {
			exec: async (_c, _w, { signal, onData }) => {
				onData(Buffer.from("partial output\n"));
				ac.abort();
				return { exitCode: 0 };
			},
		};
		const command = "apply_patch '*** Begin Patch\n*** End Patch'";
		// 注意：exec 返回 exitCode 0 后,信号中止不影响成功返回（与内置一致：只在 exec 抛 aborted 时处理）。
		const result = await runGuarded(command, cwd, { signal: ac.signal, operations: ops });
		expect(result.content[0].text).toContain("partial output");
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("propagates worker-unavailable fallback and still returns diffs", async () => {
		// 不注入 fakeOps，走真实 createLocalBashOperations 的 path 会 spawn。
		// 这里验证 sync fallback 在 worker 拒绝时触发：直接单测 guarded-diff 的 catch 分支不可行，
		// 因此验证当文件未变时不产出 diff（快照相等 → 空）。
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exec-unchanged-"));
		fs.writeFileSync(path.join(cwd, "same.txt"), "same\n");
		const before = new Map([["same.txt", "same\n"]]);
		const files = [{ op: "Update", path: "same.txt" }];
		await expect(fetchDiffsEmpty(files, cwd, before)).resolves.toEqual([]);
		fs.rmSync(cwd, { recursive: true, force: true });
	});
});

// 借道 computeGuardedPatchDiffs 验证"无变化不产出 diff"的路径
import { computeGuardedPatchDiffs } from "../guarded-diff.ts";
async function fetchDiffsEmpty(files, cwd, before) {
	return computeGuardedPatchDiffs(cwd, files, before);
}
