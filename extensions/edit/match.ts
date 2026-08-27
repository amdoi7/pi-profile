/**
 * match.ts —— 纯匹配核心：内容字符串 + 精确文本锚 → 替换 spans + 新内容。
 *
 * 零 FS、零 IO：同一份纯函数同时服务事务的解析面（transaction.ts）和全部
 * 匹配语义测试。匹配语义的唯一来源在这里；事务层只消费它的结果。
 */

import { explainMissingAnchor, repairAnchor } from "./anchor-alignment.ts";

export type FileEditOperation = {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
};

export type MatchedEditSpan = {
	matchIndex: number;
	matchLength: number;
	newText: string;
};

export type AppliedEditsResult = {
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

export const EDIT_TOOL_ERROR_KINDS = ["NOT_FOUND", "DUPLICATE_MATCH", "NO_CHANGE"] as const;
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

type MatchedEdit = MatchedEditSpan & {
	editIndex: number;
};

type ResolvedMatch = {
	matchIndex: number;
	actualOldText: string;
	/** 仅存在于修复路径：把 newText 里的同类标记翻回文件的写法。 */
	marks?: ReadonlyMap<string, string>;
};

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
 * 定位用的字符等价类。
 *
 * 守的不变式：排印形式的差异（弯引号、全角/半角）不应让一次改写失败——
 * 它们是转写噪声，不是意图。模型无需知道这一层存在。
 * 何时装的：弯引号 2026-08 既有；全角族 2026-08-27。
 * 立项证据：92 个可修复失败锚里 17 个是 1-2 字符漂移，其中 `,`↔`，` 占 4 例；
 * 本对话两例 `,`↔`、`。成本侧：零 token、零模型注意力，所以不适用「省多少轮」那套门槛。
 * 失效条件：折叠开始产生真实歧义（语料里 DUPLICATE_MATCH 里出现因折叠而多命中的
 * 案例），或出现因折叠而改错位置的事故。
 *
 * 不入等价类（证据上就不是同一回事，折了就是改错地方）：
 * - 汉字形近误写（骨→骰、绕→绍）——语料里它们是失败锚的一大类，必须继续失败；
 * - 漏字（`**` 丢掉）——同上；
 * - 破折号 `—`/`–` 与 `-`：`---` 在 Markdown 里是 frontmatter/分割线，折叠有真碰撞面，
 *   且无证据；
 * - 缩进类空白：Python 里缩进就是语义。全角空格 U+3000 例外（它是 ASCII 空格的
 *   全角形式，不作缩进）。
 *
 * 硬约束：映射必须是 **1 字符 → 1 字符**。下游靠「折叠后与原文等长」来对齐
 * 下标；破坏这个不变式会写错位置。
 */
function normalizeForFuzzyMatch(text: string): string {
	// Fast path: most source files contain no curly quotes at all.
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

function replacementPrefix(editIndex: number): string {
	return editIndex === 0 ? "" : `replacement ${editIndex + 1}: `;
}

function lineNumberAt(content: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index && cursor < content.length; cursor += 1) {
		if (content[cursor] === "\n") line += 1;
	}
	return line;
}

function lineNumbersAt(content: string, indices: number[]): number[] {
	// 同一行多次匹配去重：L1, L1 → L1。
	return [...new Set(indices.map((index) => lineNumberAt(content, index)))];
}

/** 只在失败路径计算：错误必须带回文件原文，否则模型只能重读或重试。 */
function getNotFoundError(editIndex: number, content: string, oldText: string): EditToolError {
	return editError(
		`${replacementPrefix(editIndex)}oldText was not found; ${explainMissingAnchor(content, oldText)}`,
		"NOT_FOUND",
	);
}

function getDuplicateError(editIndex: number, occurrences: number, lineNumbers: number[]): EditToolError {
	const locations = lineNumbers.length > 0 ? ` (L${lineNumbers.join(", L")})` : "";
	return editError(
		`${replacementPrefix(editIndex)}oldText matched ${occurrences} locations${locations}`,
		"DUPLICATE_MATCH",
	);
}

function getEmptyOldTextError(editIndex: number): Error {
	return new Error(`${replacementPrefix(editIndex)}oldText must not be empty.`);
}

function resolveEditMatches(
	content: string,
	oldText: string,
	replaceAll: boolean,
	editIndex: number,
	// Pre-normalized content passed in to avoid re-normalizing per edit.
	normalizedContentForFuzzy?: { content: string },
): ResolvedMatch[] {
	const exactMatches = findAllMatchIndices(content, oldText);
	if (exactMatches.length > 0) {
		if (!replaceAll && exactMatches.length > 1) {
			throw getDuplicateError(editIndex, exactMatches.length, lineNumbersAt(content, exactMatches));
		}
		// replaceAll explicitly applies the replacement to every exact match.
		return exactMatches.map((matchIndex) => ({
			matchIndex,
			actualOldText: oldText,
		}));
	}

	const fuzzyContent = normalizedContentForFuzzy?.content ?? normalizeForFuzzyMatch(content);
	const normalizedOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyMatches = findAllMatchIndices(fuzzyContent, normalizedOldText);
	if (fuzzyMatches.length === 0) {
		// 正常路径都没命中 → 看失败原因：若只是同标记的排印变体，拿文件真字节
		// 修好锚，再跑一次普通的精确匹配。它不拓宽全局匹配语义，只作用于这一次失败。
		// replaceAll 不进修复：“每一处”里各处的字节形式可能不同，修成一种会漏掉其余。
		const repair = replaceAll ? undefined : repairAnchor(content, oldText);
		const repairedMatches = repair === undefined ? [] : findAllMatchIndices(content, repair.text);
		if (repair !== undefined && repairedMatches.length === 1) {
			return [{ matchIndex: repairedMatches[0]!, actualOldText: repair.text, marks: repair.marks }];
		}
		throw getNotFoundError(editIndex, content, oldText);
	}
	if (!replaceAll && fuzzyMatches.length > 1) {
		throw getDuplicateError(editIndex, fuzzyMatches.length, lineNumbersAt(content, fuzzyMatches));
	}
	// replaceAll explicitly applies the replacement to every fuzzy match.

	return fuzzyMatches.map((matchIndex) => ({
		matchIndex,
		actualOldText: content.substring(matchIndex, matchIndex + oldText.length),
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

function preserveQuoteStyle(oldText: string, actualOldText: string, newText: string): string {
	if (oldText === actualOldText) {
		return newText;
	}
	const hasDoubleQuotes = actualOldText.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_DOUBLE_CURLY_QUOTE);
	const hasSingleQuotes = actualOldText.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_SINGLE_CURLY_QUOTE);
	if (!hasDoubleQuotes && !hasSingleQuotes) {
		return newText;
	}
	let result = newText;
	if (hasDoubleQuotes) {
		result = applyCurlyDoubleQuotes(result);
	}
	if (hasSingleQuotes) {
		result = applyCurlySingleQuotes(result);
	}
	return result;
}

/** 修复路径交回的方言表：把 newText 里的同类标记翻回文件的写法。 */
function applyRepairedMarks(newText: string, marks: ReadonlyMap<string, string> | undefined): string {
	if (marks === undefined || marks.size === 0) return newText;
	let result = "";
	for (const character of newText) result += marks.get(character) ?? character;
	return result;
}

export function applyEditsToNormalizedContent(normalizedContent: string, edits: FileEditOperation[]): AppliedEditsResult {
	// Lazily normalize content for fuzzy matching — computed at most once
	// regardless of how many edits fall through to the fuzzy path.
	let fuzzyContentCache: { content: string } | undefined;
	function getFuzzyContent(): { content: string } {
		if (fuzzyContentCache === undefined) {
			fuzzyContentCache = { content: normalizeForFuzzyMatch(normalizedContent) };
		}
		return fuzzyContentCache;
	}

	// Normalize edits and resolve matches in a single pass — avoids allocating
	// a separate normalizedEdits array. 全部校验后再应用：任一失败时聚合报告
	// 所有失败点（agent 一次修正全部，而非逐个失败逐个重读）。
	const matchedEdits: MatchedEdit[] = [];
	const failures: EditToolError[] = [];
	for (let index = 0; index < edits.length; index += 1) {
		const edit = edits[index]!;
		const oldText = normalizeToLF(edit.oldText);
		const newText = normalizeToLF(edit.newText);
		// empty anchor 与其他失败同一通道收集：一次性报全，不让模型逐个失败逐个重试。
		if (oldText.length === 0) {
			failures.push(editError(`${replacementPrefix(index)}oldText must not be empty.`, "NO_CHANGE"));
			continue;
		}
		let resolvedMatches: ResolvedMatch[];
		try {
			resolvedMatches = resolveEditMatches(
				normalizedContent,
				oldText,
				edit.replaceAll === true,
				index,
				getFuzzyContent(),
			);
		} catch (error) {
			if (isEditToolError(error)) {
				failures.push(error);
				continue;
			}
			throw error;
		}
		for (const resolvedMatch of resolvedMatches) {
			matchedEdits.push({
				editIndex: index,
				matchIndex: resolvedMatch.matchIndex,
				matchLength: resolvedMatch.actualOldText.length,
				newText: applyRepairedMarks(
					preserveQuoteStyle(oldText, resolvedMatch.actualOldText, newText),
					resolvedMatch.marks,
				),
			});
		}
	}
	// Sort only when there are multiple edits — single-edit is already sorted.
	if (matchedEdits.length > 1) {
		matchedEdits.sort((left, right) => left.matchIndex - right.matchIndex);
	}
	// 重叠检查与解析失败同一通道：全部失败一次性报全（聚合 throw 会掩盖重叠，
	// 重叠 throw 会掩盖解析失败——都是让模型多付一次往返）。
	for (let index = 1; index < matchedEdits.length; index += 1) {
		const previous = matchedEdits[index - 1]!;
		const current = matchedEdits[index]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			// 两个 span 的位置引擎手里就有，不报等于让模型再去找一遍。
			const span = (edit: MatchedEdit): string =>
				`L${lineNumberAt(normalizedContent, edit.matchIndex)}`
				+ `-L${lineNumberAt(normalizedContent, edit.matchIndex + edit.matchLength - 1)}`;
			failures.push(editError(
				`replacement ${current.editIndex + 1} (${span(current)}) overlaps`
				+ ` replacement ${previous.editIndex + 1} (${span(previous)}); merge them into one edit`,
				"NO_CHANGE",
			));
			break;
		}
	}
	if (failures.length === 1) {
		throw failures[0]!;
	}
	if (failures.length > 1) {
		throw editError(
			`edit failed (${failures.length} of ${edits.length}):\n${failures.map((failure) => `  ${failure.message}`).join("\n")}`,
			failures[0]!.kind,
		);
	}

	// Apply edits forward, collecting segments, then join once.
	// Avoids O(k²) intermediate string allocations from repeated concatenation.
	const segments: string[] = [];
	let cursor = 0;
	for (let index = 0; index < matchedEdits.length; index += 1) {
		const edit = matchedEdits[index]!;
		segments.push(normalizedContent.substring(cursor, edit.matchIndex));
		segments.push(edit.newText);
		cursor = edit.matchIndex + edit.matchLength;
	}
	segments.push(normalizedContent.substring(cursor));
	const newContent = segments.join("");
	if (newContent === normalizedContent) {
		throw editError("No change: newText normalizes to oldText", "NO_CHANGE");
	}
	// matchedEdits already has matchIndex/matchLength/newText — reuse as MatchedEditSpan[].
	return { newContent, matchedSpans: matchedEdits };
}
