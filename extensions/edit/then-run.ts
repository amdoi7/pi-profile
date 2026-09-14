/**
 * then-run.ts —— edit 的可选验证尾随：编辑脚本应用后,在同一工具调用内
 * 运行模型给出的命令,合并为一条 observation,省掉「编辑 → 再决定跑验证」
 * 的独立轮次。
 *
 * 语义三分(与 transaction.ts 的「单条 writeFile 原子、无回滚」一致):
 * - rejected(零写入) → skipped,命令绝不运行;
 * - applied/partial → 运行;partial 明确标注——验证的是不完整变更;
 * - 命令非零退出 → failed,但编辑保留(不回滚);
 * - 命令被策略拒绝/runner 抛错 → blocked,与命令失败区分。
 *
 * 命令运行器是注入端口:生产实现走 SDK 的 createBashToolDefinition(pi 的
 * 真实 bash 语义与超时),测试用内存替身。evaluateCommand(command-policy)
 * 在 runner 之前调用,block/rewrite 与 bash 走同一条策略通道。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScriptOutcome } from "./transaction.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";
export const THEN_RUN_BLOCKED = "[then_run:blocked]";
export const THEN_RUN_ABORTED = "[then_run:aborted]";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export type ThenRunRunner = (
	command: string,
	options: { timeout?: number; cwd: string },
) => Promise<{ exitCode: number | null; output: string }>;

/** 生产 runner:pi 内置 bash 工具(语义、截断、超时与交互式 bash 一致)。 */
export function createBashThenRunRunner(ctx: ExtensionContext): ThenRunRunner {
	const bash = createBashToolDefinition(ctx.cwd);
	return async (command, options) => {
		const result = await bash.execute("edit:then_run", { command, timeout: options.timeout }, undefined, undefined, ctx);
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => ("text" in block ? block.text : ""))
			.join("\n");
		const exitCode = (result.details as { exitCode?: number } | undefined)?.exitCode ?? (text.includes("error") ? 1 : 0);
		return { exitCode, output: text };
	};
}

/** 编辑与命令之间的目标文件一致性闸:内容变了就不跑(另一会话/进程介入)。 */
async function fileSha256(path: string): Promise<string | null> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch {
		return null;
	}
}

export async function assertUnchangedBeforeCommand(absolutePath: string): Promise<void> {
	const before = await fileSha256(absolutePath);
	await new Promise((resolve) => setImmediate(resolve));
	const after = await fileSha256(absolutePath);
	if (before !== after) {
		throw new Error("target file changed after the edit completed");
	}
}

/**
 * 编辑结局 + then_run → 追加给 agent 的文本。命令只在文件真正被写入
 * (applied/partial) 后运行;rejected 不消耗任何命令。
 */
export async function executeThenRun(
	outcome: ScriptOutcome,
	thenRun: ThenRunInput,
	absolutePath: string,
	run: ThenRunRunner,
	signal?: AbortSignal,
): Promise<string> {
	if (outcome.status === "rejected") {
		return `${THEN_RUN_SKIPPED} edit script was rejected (zero writes); the command was not run.`;
	}

	try {
		await assertUnchangedBeforeCommand(absolutePath);
	} catch (error) {
		return `${THEN_RUN_SKIPPED} ${error instanceof Error ? error.message : String(error)}; the command was not run.`;
	}

	const scopeNote = outcome.status === "partial"
		? "note: edit script is partial — verification covers an incomplete change.\n"
		: "";

	if (signal?.aborted) {
		return scopeNote + `${THEN_RUN_ABORTED} the session was cancelled before the command ran; the edit is kept.`;
	}

	let result: { exitCode: number | null; output: string };
	try {
		result = await run(thenRun.command, { timeout: thenRun.timeout, cwd: outcome.cwd });
	} catch (error) {
		if (signal?.aborted) {
			return scopeNote + `${THEN_RUN_ABORTED} the command was cancelled; the edit is kept.`;
		}
		return scopeNote + `${THEN_RUN_BLOCKED} ${error instanceof Error ? error.message : String(error)}`;
	}

	if (result.exitCode === 0) {
		return scopeNote + (result.output
			? `${THEN_RUN_SUCCEEDED}\n${result.output}`
			: THEN_RUN_SUCCEEDED);
	}
	return scopeNote
		+ `${THEN_RUN_FAILED} exit ${result.exitCode} — the edit is kept; fix and re-run.\n`
		+ result.output;
}
