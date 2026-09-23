/**
 * match.ts —— edit 的词汇（脚本/条目）与纯匹配核心：内容字符串 + 单条操作
 * → spans + 新内容。
 *
 * 零 FS、零 IO。协议同构：一次调用 = 一个编辑脚本，每条目 = 一个原子修改，
 * 顺序链式执行——每条目匹配「当前内容」（前一条目已生效的文本），
 * 失败即停、成功保留。
 */

/** 编辑条目：声明「改什么、怎么改」。match 定位，new_str 缺省 = 删除（替换为空）。
 * 条目只有一个公开形状：模型发什么，执行层就吃什么，中间没有第二种表示；
 * 文件归属在调用层：path 顶层唯一（一次调用 = 一个文件），条目不再携带。
 * 新建/整篇覆盖不做：模型用 cat heredoc 一步成型更自然；条目只管修改。
 *
 * 无选择器：match 必须在文件里唯一命中，多处命中即 DUPLICATE_MATCH——
 * 收窄的唯一办法是把 match 加长到唯一。 */
export type EditEntry = {
	/** 匹配目标（精确文本，必须在文件里唯一）。 */
	match: string;
	/** 替换文本；缺省 = 删除（替换为空）。 */
	new_str?: string;
};

/** 一次调用 = 一个文件的一个编辑脚本：note 是批次唯一意图，path 是唯一目标
 * 文件，edits 是该文件的条目链（链式执行）。 */
export type EditRequest = { note: string; path: string; edits: EditEntry[] };

export type MatchedEditSpan = {
	kind: "replace";
	matchIndex: number;
	matchLength: number;
	replacement: string;
};

type AppliedEditResult = {
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

const EDIT_TOOL_ERROR_KINDS = ["NOT_FOUND", "DUPLICATE_MATCH", "NO_CHANGE", "INVALID_PARAMETER"] as const;
export type RecoverableEditErrorKind = (typeof EDIT_TOOL_ERROR_KINDS)[number];

/** NOT_FOUND 的载荷:文件里最接近 match 的连续整行原文——照抄即 match,无需重读。 */
export type ClosestText = {
	/** 窗口首行行号(1-based)。 */
	startLine: number;
	/** startLine 起的整行原文(\n 连接),无行号前缀。 */
	text: string;
	/** 窗口盖不住 needle 全部行数:该重读而不是照抄。 */
	truncated: boolean;
};

export interface EditToolError extends Error {
	kind: RecoverableEditErrorKind;
	/** 仅 NOT_FOUND 携带。 */
	closest?: ClosestText;
}

export function isEditToolError(error: unknown): error is EditToolError {
	return error instanceof Error
		&& typeof (error as Partial<EditToolError>).kind === "string"
		&& (EDIT_TOOL_ERROR_KINDS as readonly string[]).includes((error as EditToolError).kind);
}

function editError(message: string, kind: RecoverableEditErrorKind): EditToolError {
	const error = new Error(message) as EditToolError;
	error.kind = kind;
	return error;
}

export function normalizeToLF(text: string): string {
	// Fast path: most files have no \r at all.
	if (text.indexOf("\r") === -1) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findAllMatchIndices(content: string, needle: string): number[] {
	const indices: number[] = [];
	if (needle.length === 0) {
		return indices;
	}
	let fromIndex = 0;
	while (fromIndex <= content.length - needle.length) {
		const index = content.indexOf(needle, fromIndex);
		if (index === -1) {
			break;
		}
		indices.push(index);
		fromIndex = index + 1;
	}
	return indices;
}

function lineNumberAt(content: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index && cursor < content.length; cursor += 1) {
		if (content[cursor] === "\n") line += 1;
	}
	return line;
}

function lineNumbersAt(content: string, indices: number[]): number[] {
	return [...new Set(indices.map((index) => lineNumberAt(content, index)))];
}

/** 只在失败路径计算：错误必须自带最接近的文件原文(closest)，否则模型只能重读或重试。 */
function getNotFoundError(content: string, needle: string): EditToolError {
	const nearest = findNearestText(content, needle);
	const error = editError(`match was not found; ${nearest.pointer}`, "NOT_FOUND");
	if (nearest.window !== undefined) {
		error.closest = buildClosest(nearest.window, nearest.startLine, nearest.truncated);
	}
	return error;
}

const MAX_LISTED_LOCATIONS = 8;

function getDuplicateError(matches: number, lineNumbers: number[]): EditToolError {
	const listed = lineNumbers.slice(0, MAX_LISTED_LOCATIONS);
	const locations = listed.length > 0
		? ` (L${listed.join(", L")}${listed.length < lineNumbers.length ? ", …" : ""})`
		: "";
	return editError(
		`match matched ${matches} locations${locations}; use a longer or more specific match`,
		"DUPLICATE_MATCH",
	);
}

/**
 * 唯一命中解析：match 必须在文件里恰好命中一次。
 * 多处命中即 DUPLICATE_MATCH（带行号清单）——收窄的唯一办法是把 match
 * 加长到唯一；选择器已全部退役，没有第二种收窄机制。
 */
function resolveMatch(content: string, needle: string): number {
	const indices = findAllMatchIndices(content, needle);
	if (indices.length === 0) {
		throw getNotFoundError(content, needle);
	}
	if (indices.length > 1) {
		throw getDuplicateError(indices.length, lineNumbersAt(content, indices));
	}
	return indices[0]!;
}

function emptyMatchError(): EditToolError {
	return editError("match must not be empty.", "INVALID_PARAMETER");
}

/**
 * 单条操作应用到当前内容（链式）：match → new_str（缺省 = 删除，替换为空）。
 * match 必须唯一命中；失败（找不到/多处命中/空字段）直接抛出单条错误，
 * 调用方决定是否中断。
 */
export function applyEntryToNormalizedContent(normalizedContent: string, entry: EditEntry): AppliedEditResult {
	const needle = normalizeToLF(entry.match);
	if (needle.length === 0) throw emptyMatchError();
	const replacement = normalizeToLF(entry.new_str ?? "");

	const matchIndex = resolveMatch(normalizedContent, needle);
	const newContent =
		normalizedContent.substring(0, matchIndex) + replacement + normalizedContent.substring(matchIndex + needle.length);

	if (newContent === normalizedContent) {
		throw editError("No change: replacement normalizes to the matched text", "NO_CHANGE");
	}
	return {
		newContent,
		matchedSpans: [{
			kind: "replace",
			matchIndex,
			matchLength: needle.length,
			replacement,
		}],
	};
}

/**
 * NOT_FOUND 的载荷：closest —— 文件里最接近 match 的整行原文,结构化字段携带
 * (startLine/text/truncated,照抄即 match);报错文案只留逐字指认(L 行 col 列
 * file X ≠ match Y)与照抄指令。窗口不再嵌进 message —— 语料(2026-09-09)里
 * 模型从 prose 剥 `NN|` 前缀重打,正是 "," 抄成空格这类二次失败的来源;只有
 * 19% 的失败重发用上了窗口行,而照抄重发的一次成功率最高(88–90%,
 * read/sed/grep 均在 ~70–74%,无显著差异)。
 *
 * 为什么归引擎:文件原文的权威副本在引擎手上,模型手上只有一份可能失真的转写
 * (语料 2026-08-27:913 次 NOT_FOUND 的 70% 下一步是重读同一文件,取回的正是
 * 引擎已持有的数据)。所以失败响应自带原文;指针按 closest.truncated 分叉——
 * 窗口完整时指令「照抄重发,无需重读」,截断(超行数或超字符预算,见下)时改口重读,
 * 照抄半截只会二次失败。
 *
 * 算法一律暴力：按行扫全文,逐个对齐位打分。n 小(8MB 硬闸门,match 中位 195 字符),
 * 索引与近似搜索只会换来常数、bug 和读不懂的代码。
 *
 * 失效条件(满足即退役):NOT_FOUND 之后「外取文件」比例没有从 71% 降下来,
 * 或照抄 closest 重发的一次成功率与重读无差别 —— 那说明结构化窗口没有改变
 * 行为,这块代码只是在多花 token —— 同 runtime-hints 的判法。
 */

/** 带回的行数上限：match 中位 3 行,超过这个数模型该重读而不是抄。 */
const MAX_WINDOW_LINES = 8;
/** 窗口字符预算:行数未超但单行超长(代码生产文件可 >1000 字符)时截窗,不掺假。 */
const MAX_CLOSEST_CHARS = 1200;
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
 * match 的首行可能从行中间开始、末行可能到行中间为止（模型截取片段作匹配目标）。
 * 只有这两端允许这样比,中间各行必须整行对整行。
 */
function matchLine(fileLine: string, needleLine: string, atStart: boolean, atEnd: boolean): LineMatch {
	let best: LineMatch = { score: similarity(fileLine, needleLine), offset: 0, text: fileLine };
	if (needleLine.length < fileLine.length) {
		if (atStart) {
			const offset = fileLine.length - needleLine.length;
			const score = similarity(fileLine.slice(offset), needleLine);
			if (score > best.score) best = { score, offset, text: fileLine.slice(offset) };
		}
		if (atEnd) {
			const head = fileLine.slice(0, needleLine.length);
			const score = similarity(head, needleLine);
			if (score > best.score) best = { score, offset: 0, text: head };
		}
	}
	return best;
}

function alignmentScore(lines: string[], needleLines: string[], start: number): number {
	let total = 0;
	for (let index = 0; index < needleLines.length; index += 1) {
		const fileLine = lines[start + index];
		// 越过文件尾的行按 0 计：窗口不完整就是更差的对齐。
		if (fileLine === undefined) break;
		total += matchLine(
			fileLine,
			needleLines[index]!,
			index === 0,
			index === needleLines.length - 1,
		).score;
	}
	return total / needleLines.length;
}

function bestAlignment(lines: string[], needleLines: string[]): Alignment | undefined {
	let best: Alignment = { start: 0, score: 0 };
	for (let start = 0; start < lines.length; start += 1) {
		const score = alignmentScore(lines, needleLines, start);
		if (score > best.score) best = { start, score };
	}
	return best.score >= MIN_ALIGNMENT_SCORE ? best : undefined;
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
 * 第一处对不上的地方，逐字指认（pointer 一行）。差异宽到引不出来时返回 undefined——
 * 那种情况下原文本身就是答案，指一个宽泛的范围只是噪声。
 */
function divergenceOf(lines: string[], needleLines: string[], start: number): string | undefined {
	for (let index = 0; index < needleLines.length; index += 1) {
		const fileLine = lines[start + index];
		const needleLine = needleLines[index]!;
		if (fileLine === undefined) return undefined;
		const match = matchLine(fileLine, needleLine, index === 0, index === needleLines.length - 1);
		if (match.text === needleLine) continue;
		const prefix = commonPrefixLength(match.text, needleLine);
		const suffix = commonSuffixLength(
			match.text,
			needleLine,
			Math.min(match.text.length, needleLine.length) - prefix,
		);
		const fileText = match.text.slice(prefix, match.text.length - suffix);
		const needleText = needleLine.slice(prefix, needleLine.length - suffix);
		if (fileText.length > MAX_QUOTED_DIVERGENCE || needleText.length > MAX_QUOTED_DIVERGENCE) {
			return undefined;
		}
		// 列号按码位数（CJK/emoji 各算一列），不是 UTF-16 单元。
		const column = [...fileLine.slice(0, match.offset + prefix)].length + 1;
		return `L${start + index + 1} col ${column}: file ${describeText(fileText)}`
			+ ` ≠ match ${describeText(needleText)}`;
	}
	return undefined;
}

/**
 * NOT_FOUND 诊断：pointer（一行，逐字分歧或最近处）+ 结构化窗口 closest。
 * 两者总是同给——分歧定位解释「为什么没命中」，窗口给出「重发时照抄什么」。
 * 窗口盖不住（行数超窗或超字符预算）标 truncated，模型该重读而不是照抄。
 * 找不到相近文本时明说找不到（不编造行号），不带窗口。
 */
type NearestText = {
	/** 接在 `match was not found; ` 后的那一行。 */
	pointer: string;
	/** 窗口首行起的原行数组（undefined = 无对齐，模型该重读）。 */
	window?: string[];
	/** 窗口首行的 1-based 行号。 */
	startLine: number;
	/** needle 的全部行（truncated 判定用）。 */
	needleLines: string[];
	/** 窗口是否被截断（行数超窗或整窗超字符预算）——指针据此分叉：截断该重读，未截断才照抄。 */
	truncated: boolean;
};

/** 截窗判据：needle 行数超上限，或整窗超出字符预算。标旗，不摻假。 */
function isWindowTruncated(window: string[], needleLines: string[]): boolean {
	return needleLines.length > MAX_WINDOW_LINES || visibleLength(window.join("\n")) > MAX_CLOSEST_CHARS;
}

function buildClosest(window: string[], startLine: number, truncated: boolean): ClosestText {
	return { startLine, text: window.join("\n"), truncated };
}

function visibleLength(text: string): number {
	return [...text].length;
}

function findNearestText(content: string, needle: string): NearestText {
	const lines = content.split("\n");
	const needleLines = needle.split("\n");
	const alignment = bestAlignment(lines, needleLines);
	if (alignment === undefined) {
		// 无对齐则无行号可用，startLine 只填类型、下游（window === undefined）不消费。
		return { needleLines, truncated: false, startLine: 0, pointer: "no similar text in the file — re-read the file or check the path." };
	}
	const divergence = divergenceOf(lines, needleLines, alignment.start);
	const location = divergence ?? `nearest text at L${alignment.start + 1}`;
	const window = lines.slice(alignment.start, alignment.start + Math.min(needleLines.length, MAX_WINDOW_LINES));
	const truncated = isWindowTruncated(window, needleLines);
	return {
		needleLines,
		startLine: alignment.start + 1,
		truncated,
		// 指针与载荷同向：截断时照抄只会抄到半截窗口，改口重读；未截断才劝照抄不重读。
		pointer: truncated
			? `${location}; closest window is truncated — re-read the file, then re-send`
			: `${location}; copy-verbatim the closest field and re-send — no re-read needed`,
		window,
	};
}
