/**
 * bash 结果的胖尾裁剪:超预算时保留头尾,中段挪进溢出文件,并说清挪走了什么、在哪。
 *
 * 依据(语料 2026-08-27,560 session / 73,423 次 bash 结果 / 105.1M 字符):输出中位数
 * 只有 598 字符——多数时候模型是克制的,不需要管;但最胖 10% 的调用吃掉 52% 的字节。
 * 按本文件的参数模拟:只动 1,556 次调用(2.1%),省下 20.8M 字符(20%)。阈值降到 4000
 * 要多动 3 倍调用,只多省 8 个百分点,故取最小干预点。
 *
 * 铁律:中段只允许「挪走」不允许「丢掉」。溢出文件写不成就整段放弃裁剪——
 * 少省一点 token 的代价,远小于把模型需要的行悄悄抹掉。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUDGET_CHARS = 8000;
const HEAD_LINES = 40;
const TAIL_LINES = 20;
/** 单行巨物(压缩 JSON 等)按字符裁,给尾部留出这么多。 */
const TAIL_CHARS = 200;

export type BudgetOptions = {
	/** 注入点只为测试溢出失败这一条路径；默认写进系统临时目录。 */
	writeSpill?: (text: string) => string;
};

export type BudgetedOutput = { text: string };

function defaultWriteSpill(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bash-output-"));
	const file = join(dir, "full.log");
	writeFileSync(file, text, "utf-8");
	return file;
}

/**
 * 超预算返回裁剪后的文本;未超预算返回 undefined（调用方原样放行，零改动）。
 */
export function applyOutputBudget(text: string, options: BudgetOptions = {}): BudgetedOutput | undefined {
	if (text.length <= BUDGET_CHARS) return undefined;

	const write = options.writeSpill ?? defaultWriteSpill;
	let spillPath: string;
	try {
		spillPath = write(text);
	} catch {
		// 挪不走就不裁：信息不可丢。
		return undefined;
	}

	const lines = text.split("\n");
	if (lines.length > HEAD_LINES + TAIL_LINES + 1) {
		const elided = lines.length - HEAD_LINES - TAIL_LINES;
		// 路径放行尾且后面不跟任何字符：紧跟一个 `]` 就会被连带复制走。
		const marker = `[${elided} lines elided: ${HEAD_LINES + 1}-${lines.length - TAIL_LINES}`
			+ ` of ${lines.length}] full output: ${spillPath}`;
		return {
			text: [...lines.slice(0, HEAD_LINES), marker, ...lines.slice(-TAIL_LINES)].join("\n"),
		};
	}

	// 行数太少而字节太多：按字符裁，头尾各留一段。
	const headChars = BUDGET_CHARS - TAIL_CHARS;
	const elided = text.length - headChars - TAIL_CHARS;
	const marker = `\n[${elided} characters elided] full output: ${spillPath}\n`;
	return { text: text.slice(0, headChars) + marker + text.slice(-TAIL_CHARS) };
}
