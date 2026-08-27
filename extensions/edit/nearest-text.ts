/**
 * NOT_FOUND 的载荷：文件里最接近锚的那几行，原样带回。
 *
 * 为什么归引擎：字节的权威副本在引擎手上，模型手上只有一份可能失真的转写。
 * 语料(2026-08-27,560 session/14396 次 edit)里 913 次 NOT_FOUND 有 70% 的下一步
 * 就是重读同一个文件(bash 59% + read 11%)——那次往返取回的正是引擎已经持有的
 * 数据。所以失败响应带回原文,而不是把「not found」说得更好听。
 *
 * 算法一律暴力：按行扫全文,逐个对齐位打分。n 小(8MB 硬闸门,锚中位 195 字符),
 * 索引与近似搜索只会换来常数、bug 和读不懂的代码。
 */

/** 带回的行数上限：锚中位 3 行,超过这个数模型该重读而不是抄。 */
const MAX_WINDOW_LINES = 8;
const MAX_LINE_CHARS = 100;
/**
 * 低于此对齐分就不指位置：分数 = 两端对得上的字符占比,
 * 指一个不相干的地方比不指更坏。
 */
const MIN_ALIGNMENT_SCORE = 0.35;
/** 分歧段两侧都短于此才逐字指认——报不出的不硬报。 */
const MAX_QUOTED_DIVERGENCE = 32;

/** 一行的匹配结果：分数、被比较的那段在行内的起始列、那段原文。 */
type LineMatch = { score: number; offset: number; text: string };

type Alignment = { start: number; score: number };

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

function commonSuffixLength(left: string, right: string, limit: number): number {
	let index = 0;
	while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1;
	return index;
}

/** 两端对得上的字符占比——一处改动的行仍然得高分,不相干的行得 0。 */
function similarity(left: string, right: string): number {
	if (left === right) return 1;
	const longest = Math.max(left.length, right.length);
	if (longest === 0) return 1;
	const prefix = commonPrefixLength(left, right);
	const suffix = commonSuffixLength(left, right, Math.min(left.length, right.length) - prefix);
	return (prefix + suffix) / longest;
}

/**
 * 锚的首行可能从行中间开始、末行可能到行中间为止（模型截取片段作锚）。
 * 只有这两端允许这样比,中间各行必须整行对整行。
 */
function matchLine(fileLine: string, anchorLine: string, atStart: boolean, atEnd: boolean): LineMatch {
	let best: LineMatch = { score: similarity(fileLine, anchorLine), offset: 0, text: fileLine };
	if (anchorLine.length < fileLine.length) {
		if (atStart) {
			const offset = fileLine.length - anchorLine.length;
			const score = similarity(fileLine.slice(offset), anchorLine);
			if (score > best.score) best = { score, offset, text: fileLine.slice(offset) };
		}
		if (atEnd) {
			const head = fileLine.slice(0, anchorLine.length);
			const score = similarity(head, anchorLine);
			if (score > best.score) best = { score, offset: 0, text: head };
		}
	}
	return best;
}

function alignmentScore(lines: string[], anchorLines: string[], start: number): number {
	let total = 0;
	for (let index = 0; index < anchorLines.length; index += 1) {
		const fileLine = lines[start + index];
		// 越过文件尾的行按 0 计：窗口不完整就是更差的对齐。
		if (fileLine === undefined) break;
		total += matchLine(
			fileLine,
			anchorLines[index]!,
			index === 0,
			index === anchorLines.length - 1,
		).score;
	}
	return total / anchorLines.length;
}

function bestAlignment(lines: string[], anchorLines: string[]): Alignment | undefined {
	let best: Alignment = { start: 0, score: 0 };
	for (let start = 0; start < lines.length; start += 1) {
		const score = alignmentScore(lines, anchorLines, start);
		if (score > best.score) best = { start, score };
	}
	return best.score >= MIN_ALIGNMENT_SCORE ? best : undefined;
}

function describeText(text: string): string {
	if (text === "") return "nothing";
	if (text.trim() === "") {
		const unit = text.includes("\t") ? "tab" : "space";
		return text.length === 1 ? unit : `${text.length} ${unit}s`;
	}
	if ([...text].length === 1) {
		return `"${text}" U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return text.length > MAX_QUOTED_DIVERGENCE ? `"${text.slice(0, MAX_QUOTED_DIVERGENCE)}…"` : `"${text}"`;
}

/**
 * 第一处对不上的地方，逐字指认。差异宽到引不出来时返回 undefined——
 * 那种情况下原文本身就是答案，指一个宽泛的范围只是噪声。
 */
function divergenceOf(lines: string[], anchorLines: string[], start: number): string | undefined {
	for (let index = 0; index < anchorLines.length; index += 1) {
		const fileLine = lines[start + index];
		const anchorLine = anchorLines[index]!;
		if (fileLine === undefined) return undefined;
		const match = matchLine(fileLine, anchorLine, index === 0, index === anchorLines.length - 1);
		if (match.text === anchorLine) continue;
		const prefix = commonPrefixLength(match.text, anchorLine);
		const suffix = commonSuffixLength(
			match.text,
			anchorLine,
			Math.min(match.text.length, anchorLine.length) - prefix,
		);
		const fileText = match.text.slice(prefix, match.text.length - suffix);
		const anchorText = anchorLine.slice(prefix, anchorLine.length - suffix);
		if (fileText.length > MAX_QUOTED_DIVERGENCE || anchorText.length > MAX_QUOTED_DIVERGENCE) {
			return undefined;
		}
		return `L${start + index + 1} col ${match.offset + prefix + 1}: file ${describeText(fileText)}`
			+ ` ≠ oldText ${describeText(anchorText)}`;
	}
	return undefined;
}

function renderWindow(lines: string[], start: number, count: number): string {
	const rendered: string[] = [];
	for (let index = start; index < Math.min(lines.length, start + count); index += 1) {
		const text = lines[index]!;
		const shown = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
		rendered.push(`${index + 1}|${shown}`);
	}
	return rendered.join("\n");
}

/**
 * 返回接在 `oldText was not found; ` 之后的诊断：定位 + 文件原文。
 * 找不到相近文本时明说找不到——不编造行号。
 */
export function nearestText(content: string, anchor: string): string {
	const lines = content.split("\n");
	const anchorLines = anchor.split("\n");
	const alignment = bestAlignment(lines, anchorLines);
	if (alignment === undefined) {
		return "no similar text in the file — re-read the file or check the path.";
	}
	const count = Math.min(anchorLines.length, MAX_WINDOW_LINES);
	const divergence = divergenceOf(lines, anchorLines, alignment.start);
	const location = divergence ?? `nearest text at L${alignment.start + 1}`;
	return `${location}; copy from the file:\n${renderWindow(lines, alignment.start, count)}`;
}
