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
 *
 * 失效条件(满足即退役):NOT_FOUND 之后「重读同一文件」的比例没有从 70% 降下来。
 * 那就是说交回原文并未改变行为,这块代码只是在多花 token —— 同 runtime-hints 的判法。
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

/**
 * 同一标记的排印变体（全角/半角、CJK 专用形式）——只用作判断一处已诊断差异
 * 能不能自动修复的**谓词**，不拿去预先改写内容。
 *
 * 不入此类（语料上就不是同一回事，自动修了就是改错地方）：汉字形近误写（骨/骰）、
 * 漏字（`**`）、破折号与 `-`（`---` 在 Markdown 里有真碰撞面）、缩进类空白（Python 语义）。
 */
const SAME_MARK_VARIANTS: ReadonlyArray<ReadonlySet<string>> = [
	// 全角空格参与匹配，但被 marks 排除在回写之外（见下）。
	new Set([" ", "\u3000"]),
	new Set([",", "\uff0c", "\u3001"]),
	new Set([".", "\uff0e", "\u3002"]),
	new Set([":", "\uff1a"]),
	new Set([";", "\uff1b"]),
	new Set(["!", "\uff01"]),
	new Set(["?", "\uff1f"]),
	new Set(["(", "\uff08"]),
	new Set([")", "\uff09"]),
	new Set(["[", "\uff3b", "\u3010"]),
	new Set(["]", "\uff3d", "\u3011"]),
	new Set(["'", "\u2018", "\u2019"]),
	new Set(['"', "\u201c", "\u201d", "\u300c", "\u300d"]),
];

/** 引号由 preserveQuoteStyle 按上下文处理，不进 marks。 */
const QUOTE_CHARACTERS = new Set([
	"'", '"', "\u2018", "\u2019", "\u201c", "\u201d", "\u300c", "\u300d",
]);

function isSameMarkVariant(left: string, right: string): boolean {
	if (left === right) return true;
	if (left.length !== 1 || right.length !== 1) return false;
	return SAME_MARK_VARIANTS.some((group) => group.has(left) && group.has(right));
}

/**
 * 修复面：诊断出的最近区域与锚只差在同标记变体时，返回文件那段**真字节**，
 * 让调用方拿它去跑一次普通的精确匹配——定位、唯一性、重叠检查全回到精确字节上。
 *
 * 拒绝修复的情形：没有对齐、有并列的同分对齐（模棱两可）、或任何一处差异不属于同标记变体。
 */
/**
 * 一次修复就是一个数据：文件那段真字节，加上「模型的写法 → 文件的写法」。
 * text 拿去跑普通的精确匹配（定位/唯一性/重叠检查全回到精确字节）；
 * marks 用于把 newText 里的同类标记翻回文件的方言（不含引号与空白）。
 */
export type AnchorRepair = { text: string; marks: ReadonlyMap<string, string> };

/**
 * 修复面：诊断出的最近区域与锚只差在同标记变体时，交出文件那段真字节。
 *
 * 拒绝修复：没有对齐、有并列的同分对齐（模棱两可）、行长不等（不是纯标记差异）、
 * 或任何一处差异不属于同标记变体。引号与空白不进 marks：引号由
 * preserveQuoteStyle 按开闭上下文处理；空白到处都是，从一处全角空格学到的映射
 * 会把 newText 里每个空格都改掉（对抗性复审现场抓到）。
 */
/**
 * 一段文件文本能不能修好这行锚：等长，且每一处差异都是同标记变体。
 * marks 只收非引号、非空白的对：引号由 preserveQuoteStyle 按上下文处理；空白到处都是，
 * 从一处全角空格学到的映射会把 newText 里每个空格都改掉（对抗性复审现场抓到）。
 */
function repairSegment(onDisk: string, authored: string, marks: Map<string, string>): boolean {
	if (onDisk.length !== authored.length) return false;
	for (let position = 0; position < authored.length; position += 1) {
		const fileCharacter = onDisk[position]!;
		const authoredCharacter = authored[position]!;
		if (!isSameMarkVariant(fileCharacter, authoredCharacter)) return false;
		if (fileCharacter === authoredCharacter) continue;
		if (QUOTE_CHARACTERS.has(authoredCharacter) || QUOTE_CHARACTERS.has(fileCharacter)) continue;
		if (authoredCharacter.trim() === "" || fileCharacter.trim() === "") continue;
		const known = marks.get(authoredCharacter);
		// 同一写法在文件里对应两种形式 → 不猜，整张表作废。
		if (known !== undefined && known !== fileCharacter) marks.clear();
		else marks.set(authoredCharacter, fileCharacter);
	}
	return true;
}

/** 单行锚：可能落在行内任意位置，逐位试。 */
function repairWithinLine(fileLine: string, anchor: string): AnchorRepair | undefined {
	let found: AnchorRepair | undefined;
	for (let offset = 0; offset + anchor.length <= fileLine.length; offset += 1) {
		const marks = new Map<string, string>();
		const segment = fileLine.slice(offset, offset + anchor.length);
		if (!repairSegment(segment, anchor, marks)) continue;
		if (found !== undefined) return undefined;
		found = { text: segment, marks };
	}
	return found;
}

/** 多行锚：首行可以是某行的后缀、末行可以是某行的前缀，中间各行必須整行。 */
function repairAcrossLines(lines: string[], anchorLines: string[], start: number): AnchorRepair | undefined {
	const marks = new Map<string, string>();
	const segments: string[] = [];
	const last = anchorLines.length - 1;
	for (let index = 0; index <= last; index += 1) {
		const fileLine = lines[start + index];
		const anchorLine = anchorLines[index]!;
		if (fileLine === undefined) return undefined;
		const segment = index === 0
			? fileLine.slice(fileLine.length - anchorLine.length)
			: index === last ? fileLine.slice(0, anchorLine.length) : fileLine;
		if (!repairSegment(segment, anchorLine, marks)) return undefined;
		segments.push(segment);
	}
	return { text: segments.join("\n"), marks };
}

/**
 * 修复面：结构性暂力搜索，**不用**诊断面的相似度评分。
 * 前后缀相似度低估多处差异（五个全角标点散布一行时只有 0.15），拿它当门槛会把
 * 本可修的锚拦在外。判据只有两条：等长，且每处差异都是同标记变体。
 * 两处以上都能修 → 模棱两可，不猜。
 */
export function repairAnchor(content: string, anchor: string): AnchorRepair | undefined {
	const anchorLines = anchor.split("\n");
	const lines = content.split("\n");
	let found: AnchorRepair | undefined;
	for (let start = 0; start + anchorLines.length <= lines.length; start += 1) {
		const candidate = anchorLines.length === 1
			? repairWithinLine(lines[start]!, anchorLines[0]!)
			: repairAcrossLines(lines, anchorLines, start);
		if (candidate === undefined) continue;
		if (found !== undefined) return undefined;
		found = candidate;
	}
	return found;
}

/** 入参是行内片段（不含换行）。数量词只用于均质空白：报错宁可笨，不可说谎。 */
function describeText(text: string): string {
	if (text === "") return "nothing";
	if (/^ +$/.test(text)) return text.length === 1 ? "space" : `${text.length} spaces`;
	if (/^\t+$/.test(text)) return text.length === 1 ? "tab" : `${text.length} tabs`;
	const characters = [...text];
	if (characters.length === 1) {
		return `"${text}" U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
	}
	// 混合空白原样示出（转义后可见）；截断按码位，不劈开代理对。
	const shown = characters.length > MAX_QUOTED_DIVERGENCE
		? `${characters.slice(0, MAX_QUOTED_DIVERGENCE).join("")}…`
		: text;
	return `"${shown.replace(/\t/g, "\\t")}"`;
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
		// 列号按码位数（CJK/emoji 各算一列），不是 UTF-16 单元。
		const column = [...fileLine.slice(0, match.offset + prefix)].length + 1;
		return `L${start + index + 1} col ${column}: file ${describeText(fileText)}`
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
export function explainMissingAnchor(content: string, anchor: string): string {
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
