/**
 * guarded-diff.ts —— apply_patch 命令的展示 diff 守卫与结构化结果。
 *
 * 问题：内置 bash 工具在 apply_patch 成功后同步调用 jsdiff `Diff.diffLines`
 * 计算全量行 diff（无超时、无降级、主线程）。jsdiff Myers 是 O(ND)，大 buffer
 * （例如 patch 重写了 2 万行文件的中段）下实测 60s+，期间 TUI 主线程冻结，
 * tool call 看起来卡死。
 *
 * 方案：apply_patch 的展示 diff 全部改走 _shared/diff-service（worker 线程 +
 * 5s batch watchdog + final-diff 引擎：无共享行 O(N) fast path、公共前后缀剥离、
 * 250ms Myers tripwire、超时降级 unlocated rows），与 edit 工具同一套受保护管线。
 * 结果以结构化 DisplayDiff（双侧行号 + 词级 highlights）携带在
 * details.patchFiles 上，由 index.ts 的 renderResult 用与 edit 同源的
 * fileResultItem/DiffPreviewComponent 双列渲染；不再降格序列化成内置
 * renderDiff 的单列文本。本文件只负责：识别 patch 涉及的文件、快照
 * before/after、请求 worker、产出/校验结构化结果。
 */
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
	generateFinalDiff,
	isChangeStats,
	isDisplayDiff,
	type ChangeStats,
	type DisplayDiff,
} from "../_shared/final-diff.ts";
import { requestDiffBatch, warmUpDiffWorker } from "../_shared/diff-service.ts";

/** 与内置 generateDiffString 默认（及 edit preview）一致的 context 行数。 */
const CONTEXT_LINES = 4;

/** 内置 bash 工具识别 apply_patch 的同一正则（决定是否走守卫路径）。 */
export const APPLY_PATCH_RE = /\bapply_patch\b/;

export type PatchFileRef = { op: "Add" | "Update" | "Delete"; path: string };

/** 与内置 bash.js 相同：解析命令中 `*** Add|Update|Delete File:` 头。 */
export function extractPatchFiles(command: string): PatchFileRef[] {
	const pattern = /^\s*\*\*\*\s+(Add|Update|Delete)\s+File:\s+(\S.*)$/gm;
	const files: PatchFileRef[] = [];
	let m: RegExpExecArray | null;
	while ((m = pattern.exec(command)) !== null) {
		files.push({ op: m[1] as PatchFileRef["op"], path: m[2].trim() });
	}
	return files;
}

export async function snapshotFiles(cwd: string, files: readonly PatchFileRef[]): Promise<Map<string, string | undefined>> {
	const snap = new Map<string, string | undefined>();
	for (const { path } of files) {
		const abs = resolvePath(cwd, path);
		try {
			snap.set(path, (await readFile(abs)).toString("utf-8"));
		}
		catch {
			snap.set(path, undefined); // 尚未存在（Add）或已删除（Delete）
		}
	}
	return snap;
}

export type GuardedPatchDiff = {
	kind: PatchFileRef["op"];
	path: string;
	cwd: string;
	changeStats: ChangeStats;
	display: DisplayDiff;
	truncated: boolean;
};

/** details.patchFiles 的渲染侧解析：缺席 / 结构契约破坏 / 可渲染。 */
export type GuardedPatchFilesParse =
	| { kind: "absent" }
	| { kind: "invalid" }
	| { kind: "ok"; files: GuardedPatchDiff[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isGuardedPatchDiff(value: unknown): value is GuardedPatchDiff {
	return isRecord(value) &&
		(value.kind === "Add" || value.kind === "Update" || value.kind === "Delete") &&
		typeof value.path === "string" &&
		typeof value.cwd === "string" &&
		typeof value.truncated === "boolean" &&
		isChangeStats(value.changeStats) &&
		isDisplayDiff(value.display);
}

/** 结果 details → patchFiles（契约破坏不静默吞：返回 invalid 由调用方响亮报告）。 */
export function parseGuardedPatchFiles(details: unknown): GuardedPatchFilesParse {
	if (!isRecord(details) || details.patchFiles === undefined) return { kind: "absent" };
	const raw = details.patchFiles;
	if (!Array.isArray(raw) || !raw.every(isGuardedPatchDiff)) return { kind: "invalid" };
	return { kind: "ok", files: raw };
}

/**
 * apply_patch 成功后的守卫 diff。逐文件：
 * - Add（old 为空）/ Delete（new 为空）：exact 策略的无共享行 fast path 已经
 *   O(N) 覆盖，且保留行号（比 rewrite 的 numberless 更接近内置展示）。
 * - Update：exact → 前后缀剥离 + Myers 250ms tripwire，超时降级 unlocated。
 * worker 不可用（崩溃 / dispose / batch 超时）→ 回退主线程 generateFinalDiff
 * （同样 250ms tripwire，有界），与 edit 的 fallback 一致。
 */
export async function computeGuardedPatchDiffs(
	cwd: string,
	files: readonly PatchFileRef[],
	before: ReadonlyMap<string, string | undefined>,
): Promise<GuardedPatchDiff[]> {
	if (files.length === 0) {
		return [];
	}
	// 快照 after；只对 before 存在且内容变化（或 Add/Delete 明确变化）的文件出 diff，
	// 与内置 computePatchDiffs 的判定一致。
	const inputs: { file: PatchFileRef; oldContent: string; newContent: string }[] = [];
	for (const file of files) {
		const abs = resolvePath(cwd, file.path);
		let after: string | undefined;
		try {
			after = (await readFile(abs)).toString("utf-8");
		}
		catch {
			after = undefined;
		}
		const old = before.get(file.path);
		if (file.op === "Delete") {
			if (old !== undefined) inputs.push({ file, oldContent: old, newContent: "" });
		}
		else if (file.op === "Add") {
			if (after !== undefined) inputs.push({ file, oldContent: "", newContent: after });
		}
		else if (old !== undefined && after !== undefined && old !== after) {
			inputs.push({ file, oldContent: old, newContent: after });
		}
	}
	if (inputs.length === 0) {
		return [];
	}

	const toResult = (
		input: { file: PatchFileRef },
		diff: { display: DisplayDiff; stats: ChangeStats; truncated: boolean },
	): GuardedPatchDiff => ({
		kind: input.file.op,
		path: input.file.path,
		cwd,
		changeStats: diff.stats,
		display: diff.display,
		truncated: diff.truncated,
	});

	warmUpDiffWorker();
	try {
		const response = await requestDiffBatch(
			inputs.map(({ oldContent, newContent }, index) => ({
				fileId: String(index),
				oldContent,
				newContent,
				strategy: { kind: "exact" },
				contextLines: CONTEXT_LINES,
			})),
			"bash-apply-patch",
		);
		return response.files.map((output, index) => toResult(inputs[index]!, output));
	}
	catch (error) {
		console.error(
			`bash apply_patch diff worker failed ` +
			`error=${error instanceof Error ? error.message : String(error)} ` +
			`action="falling back to synchronous bounded diff engine"`,
		);
		return inputs.map((input) => toResult(input, generateFinalDiff(input.oldContent, input.newContent, CONTEXT_LINES)));
	}
}
