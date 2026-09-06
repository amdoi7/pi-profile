/**
 * match.ts —— edit 的词汇（脚本/条目）与纯匹配核心：内容字符串 + 单条操作
 * → spans + 新内容。
 *
 * 零 FS、零 IO。协议同构：一次调用 = 一个编辑脚本，每条目 = 一个原子修改
 * （一个 op 作用于一个 path），顺序链式执行——每 op 匹配「当前内容」
 * （上一 op 已生效的字节），失败即停、成功保留。
 */

/** 匹配条目：声明「改什么、怎么改」。match 定位，new_str 缺省 = 删除（替换为空）。 */
export type MatchSelector = {
	/** 匹配目标（精确文本；regex:true 时为正则）。 */
	match: string;
	/** 替换文本；缺省 = 删除（替换为空）。 */
	new_str?: string;
	/** 第 N 次出现（1-based）。 */
	occurrence?: number;
	/** 只取前 M 个匹配（缺省 = 全部）。 */
	limit?: number;
	/** 锚点限定：只匹配 after 之后 / before 之前的区域。 */
	after?: string;
	before?: string;
	/** match 按正则解释。 */
	regex?: boolean;
};

/**
 * 新建/整篇覆盖不做：模型用 cat heredoc 一步成型更自然；条目只管修改。
 */
type EditOp = MatchSelector;

/**
 * 一个条目 = 一个 op。扁平是唯一形状：`op` 是判别符，它的字段与它平级——
 * 模型发什么，执行层就吃什么，中间没有第二种形状。path 在 files 层（index.ts
 * 校验时投影进 EditRequest.edits）。
 */
export type EditEntry = EditOp;

/** 一次调用 = 一个编辑脚本：`note` 是批次唯一意图，`edits` 是文件作用域
 * 投影后的内部条目序列（每条目带 path，链式执行）。 */
export type EditRequest = { note: string; edits: Array<EditEntry & { path: string }> };

export type MatchedEditSpan = {
	kind: "replace";
	matchIndex: number;
	matchLength: number;
	newText: string;
};

type AppliedEditResult = {
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

const EDIT_TOOL_ERROR_KINDS = ["NOT_FOUND", "DUPLICATE_MATCH", "NO_CHANGE", "INVALID_PARAMETER"] as const;
export type RecoverableEditErrorKind = (typeof EDIT_TOOL_ERROR_KINDS)[number];

export interface EditToolError extends Error {
	kind: RecoverableEditErrorKind;
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

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

export function normalizeToLF(text: string): string {
	// Fast path: most files have no \r at all.
	if (text.indexOf("\r") === -1) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 匹配面的字符等价类：**只**折叠弯引号（代码中无语义的转写噪声）。
 *
 * CJK 标点、形近汉字、破折号、缩进空白一律不入等价类；映射必须
 * 1 字符 → 1 字符（下游靠等长对齐下标）。
 */
function normalizeForFuzzyMatch(text: string): string {
	if (
		text.indexOf(LEFT_SINGLE_CURLY_QUOTE) === -1 &&
		text.indexOf(RIGHT_SINGLE_CURLY_QUOTE) === -1 &&
		text.indexOf(LEFT_DOUBLE_CURLY_QUOTE) === -1 &&
		text.indexOf(RIGHT_DOUBLE_CURLY_QUOTE) === -1
	) {
		return text;
	}
	return text
		.replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
		.replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
		.replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
		.replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
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

function findAllRegexMatches(content: string, pattern: string): Array<{ index: number; length: number }> {
	const matches: Array<{ index: number; length: number }> = [];
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "g");
	} catch (error) {
		throw editError(`invalid regex: ${error instanceof Error ? error.message : String(error)}`, "INVALID_PARAMETER");
	}
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		matches.push({ index: match.index, length: match[0].length });
		// 零宽匹配防死循环
		if (match[0].length === 0) regex.lastIndex += 1;
	}
	return matches;
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

/** 只在失败路径计算：错误必须带回文件原文，否则模型只能重读或重试。 */
function getNotFoundError(content: string, needle: string): EditToolError {
	return editError(
		`match was not found; ${explainMissingMatch(content, needle)}`,
		"NOT_FOUND",
	);
}

const MAX_LISTED_LOCATIONS = 8;

function getDuplicateError(matches: number, lineNumbers: number[]): EditToolError {
	const listed = lineNumbers.slice(0, MAX_LISTED_LOCATIONS);
	const more = lineNumbers.length - listed.length;
	const locations = listed.length > 0
		? ` (L${listed.join(", L")}${listed.length < lineNumbers.length ? ", …" : ""})`
		: "";
	return editError(
		`match matched ${matches} locations${locations}; use a longer or more specific match`,
		"DUPLICATE_MATCH",
	);
}

type ResolvedMatch = {
	matchIndex: number;
	/** 文件里的真实字节（修复/模糊路径以它为准）。 */
	actualText: string;
	/** 仅存在于修复路径：把 new_str 里的同类标记翻回文件的写法。 */
	marks?: ReadonlyMap<string, string>;
};

function resolveMatch(
	content: string,
	needle: string,
	allowMultiple: boolean,
	// Pre-normalized content passed in to avoid re-normalizing per op.
	normalizedContentForFuzzy?: { content: string },
	selector?: MatchSelector,
): ResolvedMatch[] {
	// 选择器 → 候选区域：after/before 锚点限定搜索范围。
	let searchStart = 0;
	let searchEnd = content.length;
	if (selector?.after !== undefined) {
		const anchor = normalizeToLF(selector.after);
		const anchorIndex = content.indexOf(anchor);
		if (anchorIndex === -1) {
			throw editError(`after anchor "${selector.after}" not found`, "NOT_FOUND");
		}
		searchStart = anchorIndex + anchor.length;
	}
	if (selector?.before !== undefined) {
		const anchor = normalizeToLF(selector.before);
		const anchorIndex = content.indexOf(anchor, searchStart);
		if (anchorIndex === -1) {
			throw editError(`before anchor "${selector.before}" not found`, "NOT_FOUND");
		}
		searchEnd = anchorIndex;
	}
	if (selector?.occurrence !== undefined && selector?.limit !== undefined) {
		throw editError("occurrence and limit are mutually exclusive", "INVALID_PARAMETER");
	}
	const scopedContent = content.slice(searchStart, searchEnd);
	const exactMatches = selector?.regex
		? findAllRegexMatches(scopedContent, needle)
		: findAllMatchIndices(scopedContent, needle).map((index) => ({ index, length: needle.length }));
	if (exactMatches.length > 0) {
		let selected = exactMatches;
		if (selector?.occurrence !== undefined) {
			const nth = selector.occurrence;
			if (nth < 1 || nth > exactMatches.length) {
				throw editError(`occurrence ${nth} exceeds ${exactMatches.length} matches`, "NOT_FOUND");
			}
			selected = [exactMatches[nth - 1]!];
		} else if (selector?.limit !== undefined && selector.limit > 0 && selector.limit < exactMatches.length) {
			selected = exactMatches.slice(0, selector.limit);
		}
		return selected.map(({ index, length }) => ({
			matchIndex: index + searchStart,
			actualText: scopedContent.substring(index, index + length),
		}));
	}

	const fuzzyContent = normalizedContentForFuzzy?.content ?? normalizeForFuzzyMatch(content);
	const normalizedNeedle = normalizeForFuzzyMatch(needle);
	const fuzzyMatches = findAllMatchIndices(fuzzyContent, normalizedNeedle);
	if (fuzzyMatches.length === 0) {
		// 修复面与数量无关:总能尝试"找一个可修的唯一处"。修复是谓词(等长+同标记变体),
		// 命中唯一才交回(多处可修 = 模棱两可,不猜)。
		const repair = repairMatch(content, needle);
		const repairedMatches = repair === undefined ? [] : findAllMatchIndices(content, repair.text);
		if (repair !== undefined && repairedMatches.length === 1) {
			return [{ matchIndex: repairedMatches[0]!, actualText: repair.text, marks: repair.marks }];
		}
		throw getNotFoundError(content, needle);
	}
	// fuzzy 命中多个:replace 默认全部替换,全部返回(选择器在调用方已收窄)。
	return fuzzyMatches.map((matchIndex) => ({
		matchIndex,
		actualText: content.substring(matchIndex, matchIndex + needle.length),
	}));
}

const LETTER_RE = /\p{L}/u;

function isOpeningContext(chars: string[], index: number): boolean {
	if (index === 0) {
		return true;
	}
	const previous = chars[index - 1]!;
	return previous === " " || previous === "\t" || previous === "\n" || previous === "\r" || previous === "(" || previous === "[" || previous === "{" || previous === "\u2014" || previous === "\u2013";
}

function applyCurlyDoubleQuotes(text: string): string {
	const chars = [...text];
	let result = "";
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] === '"') {
			result += isOpeningContext(chars, index) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE;
		} else {
			result += chars[index]!;
		}
	}
	return result;
}

function applyCurlySingleQuotes(text: string): string {
	const chars = [...text];
	let result = "";
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] !== "'") {
			result += chars[index]!;
			continue;
		}
		const previous = index > 0 ? chars[index - 1] : undefined;
		const next = index < chars.length - 1 ? chars[index + 1] : undefined;
		const previousIsLetter = previous !== undefined && LETTER_RE.test(previous);
		const nextIsLetter = next !== undefined && LETTER_RE.test(next);
		if (previousIsLetter && nextIsLetter) {
			result += RIGHT_SINGLE_CURLY_QUOTE;
		} else {
			result += isOpeningContext(chars, index) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE;
		}
	}
	return result;
}

/** 引号按开闭上下文回写：模型写法 vs 文件真字节。 */
function preserveQuoteStyle(authored: string, actual: string, replacement: string): string {
	if (authored === actual) {
		return replacement;
	}
	const hasDoubleQuotes = actual.includes(LEFT_DOUBLE_CURLY_QUOTE) || actual.includes(RIGHT_DOUBLE_CURLY_QUOTE);
	const hasSingleQuotes = actual.includes(LEFT_SINGLE_CURLY_QUOTE) || actual.includes(RIGHT_SINGLE_CURLY_QUOTE);
	if (!hasDoubleQuotes && !hasSingleQuotes) {
		return replacement;
	}
	let result = replacement;
	if (hasDoubleQuotes) {
		result = applyCurlyDoubleQuotes(result);
	}
	if (hasSingleQuotes) {
		result = applyCurlySingleQuotes(result);
	}
	return result;
}

/** 修复路径交回的方言表：把 replacement 里的同类标记翻回文件的写法。 */
function applyRepairedMarks(text: string, marks: ReadonlyMap<string, string> | undefined): string {
	if (marks === undefined || marks.size === 0) return text;
	let result = "";
	for (const character of text) result += marks.get(character) ?? character;
	return result;
}

function emptyMatchError(): EditToolError {
	return editError("match must not be empty.", "INVALID_PARAMETER");
}

/**
 * 单条操作应用到当前内容（链式）：
 * - replace：match → new_str（默认全部命中，选择器收窄；进 fuzzy 面）；
 * - delete：match → 空。
 *
 * 失败（找不到/多处命中/空字段）直接抛出单条错误；调用方决定是否中断。
 */
export function applyOpToNormalizedContent(normalizedContent: string, op: MatchOp | InsertOp): AppliedEditResult {
	const fuzzyContentCache = { content: normalizeForFuzzyMatch(normalizedContent) };

	const oldStr = normalizeToLF(op.match);
	if (oldStr.length === 0) throw emptyMatchError();
	// new_str 缺省 = 删除（替换为空）；默认全部命中，选择器收窄。
	const newStr = normalizeToLF(op.new_str ?? "");

	const matches = resolveMatch(normalizedContent, oldStr, true, fuzzyContentCache, op);
	if (matches.length === 0) throw getNotFoundError(normalizedContent, oldStr);

	const spans = matches.map((match) => {
		const replacement = applyRepairedMarks(
			preserveQuoteStyle(oldStr, match.actualText, newStr),
			match.marks,
		);
		return { matchIndex: match.matchIndex, matchLength: match.actualText.length, replacement };
	});

	// 单 op 内多个命中互不重叠（顺序扫描），直接拼接。
	const segments: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		segments.push(normalizedContent.substring(cursor, span.matchIndex));
		segments.push(span.replacement);
		cursor = span.matchIndex + span.matchLength;
	}
	segments.push(normalizedContent.substring(cursor));
	const newContent = segments.join("");

	if (newContent === normalizedContent) {
		throw editError("No change: replacement normalizes to the matched text", "NO_CHANGE");
	}
	if (spans.length === 1) {
		return {
			newContent,
			matchedSpans: [{
				kind: "replace",
				matchIndex: spans[0]!.matchIndex,
				matchLength: spans[0]!.matchLength,
				newText: spans[0]!.replacement,
			}],
		};
	}
	// 多命中各自成 span：窗口按命中位置独立展开，hunk 分隔不丢失。
	return {
		newContent,
		matchedSpans: spans.map((span) => ({
			kind: "replace" as const,
			matchIndex: span.matchIndex,
			matchLength: span.matchLength,
			newText: span.replacement,
		})),
	};
}/**
 * NOT_FOUND 的载荷：文件里最接近 match 的那几行，原样带回。
 *
 * 为什么归引擎：字节的权威副本在引擎手上，模型手上只有一份可能失真的转写。
 * 语料(2026-08-27,560 session/14396 次 edit)里 913 次 NOT_FOUND 有 70% 的下一步
 * 就是重读同一个文件(bash 59% + read 11%)——那次往返取回的正是引擎已经持有的
 * 数据。所以失败响应带回原文,而不是把「not found」说得更好听。
 *
 * 算法一律暴力：按行扫全文,逐个对齐位打分。n 小(8MB 硬闸门,match 中位 195 字符),
 * 索引与近似搜索只会换来常数、bug 和读不懂的代码。
 *
 * 失效条件(满足即退役):NOT_FOUND 之后「重读同一文件」的比例没有从 70% 降下来。
 * 那就是说交回原文并未改变行为,这块代码只是在多花 token —— 同 runtime-hints 的判法。
 */

/** 带回的行数上限：match 中位 3 行,超过这个数模型该重读而不是抄。 */
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

/**
 * 修复面的同一标记变体表（全角/半角、CJK 专用形式）——只用作判断一处已诊断差异
 * 能不能自动修复的**谓词**，不拿去预先改写内容。这些字符**不在**匹配面的
 * fuzzy 等价类（match.ts）：两层刻意的窄→宽，见 normalizeForFuzzyMatch 的设计边界。
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

/** 一次修复 = 文件那段真字节 + 「模型写法 → 文件写法」方言表（不含引号与空白）。 */
type MatchRepair = { text: string; marks: ReadonlyMap<string, string> };

/**
 * 修复面：最近区域与 match 只差同标记变体时，交出文件那段真字节，调用方拿它跑
 * 普通的精确匹配——定位、唯一性、重叠检查全回到精确字节上。
 *
 * 拒绝修复：没有对齐、并列的同分对齐（模棱两可）、行长不等（不是纯标记差异）、
 * 任何一处差异不属于同标记变体。
 *
 * marks 只收非引号、非空白的对：引号由 preserveQuoteStyle 按开闭上下文处理；
 * 空白到处都是，从一处全角空格学到的映射会把 newText 里每个空格都改掉
 * （对抗性复审现场抓到）。
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

/**
 * 修复搜索是结构性的，**不用**诊断面的相似度评分：前后缀相似度低估多处差异
 * （五个全角标点散布一行时只有 0.15），拿它当门槛会把本可修的 match 拦在外。
 * 判据只有两条：等长，且每处差异都是同标记变体。两处以上都能修 → 模棱两可，不猜。
 *
 * 单行 match：可能落在行内任意位置，逐位试。
 */
function repairWithinLine(fileLine: string, needle: string): MatchRepair | undefined {
	let found: MatchRepair | undefined;
	for (let offset = 0; offset + needle.length <= fileLine.length; offset += 1) {
		const marks = new Map<string, string>();
		const segment = fileLine.slice(offset, offset + needle.length);
		if (!repairSegment(segment, needle, marks)) continue;
		if (found !== undefined) return undefined;
		found = { text: segment, marks };
	}
	return found;
}

/** 多行 match：首行可以是某行的后缀、末行可以是某行的前缀，中间各行必須整行。 */
function repairAcrossLines(lines: string[], needleLines: string[], start: number): MatchRepair | undefined {
	const marks = new Map<string, string>();
	const segments: string[] = [];
	const last = needleLines.length - 1;
	for (let index = 0; index <= last; index += 1) {
		const fileLine = lines[start + index];
		const needleLine = needleLines[index]!;
		if (fileLine === undefined) return undefined;
		const segment = index === 0
			? fileLine.slice(fileLine.length - needleLine.length)
			: index === last ? fileLine.slice(0, needleLine.length) : fileLine;
		if (!repairSegment(segment, needleLine, marks)) return undefined;
		segments.push(segment);
	}
	return { text: segments.join("\n"), marks };
}

function repairMatch(content: string, needle: string): MatchRepair | undefined {
	const needleLines = needle.split("\n");
	const lines = content.split("\n");
	let found: MatchRepair | undefined;
	for (let start = 0; start + needleLines.length <= lines.length; start += 1) {
		const candidate = needleLines.length === 1
			? repairWithinLine(lines[start]!, needleLines[0]!)
			: repairAcrossLines(lines, needleLines, start);
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
 * 返回接在 `match was not found; ` 之后的诊断：定位 + 文件原文。
 * 找不到相近文本时明说找不到——不编造行号。
 */
function explainMissingMatch(content: string, needle: string): string {
	const lines = content.split("\n");
	const needleLines = needle.split("\n");
	const alignment = bestAlignment(lines, needleLines);
	if (alignment === undefined) {
		return "no similar text in the file — re-read the file or check the path.";
	}
	const count = Math.min(needleLines.length, MAX_WINDOW_LINES);
	const divergence = divergenceOf(lines, needleLines, alignment.start);
	const location = divergence ?? `nearest text at L${alignment.start + 1}`;
	return `${location}; copy from the file:\n${renderWindow(lines, alignment.start, count)}`;
}
