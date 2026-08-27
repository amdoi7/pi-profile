/**
 * bash 结果的输出预算:超预算时保留头尾、中段挪进溢出文件。
 *
 * 只做转换,不做拦截——它不拒绝任何命令,也不改变结果语义(isError 原样),
 * 只是把「已经拿到的一大块字节」换成「头尾 + 中段在哪」。
 *
 * 形状不认识就原样放行:多 block、非文本、非 bash 一律不碰。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyOutputBudget } from "./budget.ts";

type ResultContent = Array<{ type: string; text?: string }>;

export default function bashOutputBudgetExtension(pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return undefined;
		const content = event.content as ResultContent | undefined;
		if (!Array.isArray(content) || content.length !== 1) return undefined;
		const block = content[0];
		if (block?.type !== "text" || typeof block.text !== "string") return undefined;

		const budgeted = applyOutputBudget(block.text);
		if (budgeted === undefined) return undefined;
		return { content: [{ type: "text" as const, text: budgeted.text }] };
	});
}
