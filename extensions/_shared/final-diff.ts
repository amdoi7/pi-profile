import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { diffWordsWithSpace, structuredPatch } from "diff";

export type DiffHighlightRange = {
	start: number;
	end: number;
};

export type ChangeStats = {
	additions: number;
	deletions: number;
	changedLines: number;
};

export type DisplayDiffRow =
	| { kind: "context"; oldLine: number; newLine: number; content: string }
	| { kind: "remove"; oldLine: number; content: string; highlights: DiffHighlightRange[] }
	| { kind: "add"; newLine: number; content: string; highlights: DiffHighlightRange[] }
	| { kind: "unlocated"; operation: "context" | "remove" | "add"; content: string; highlights: DiffHighlightRange[] }
	| { kind: "fold"; omittedLines: number }
	| { kind: "annotation"; side: "old" | "new"; content: string };

export type DisplayDiff = {
	lineNumberWidth: number;
	rows: DisplayDiffRow[];
};

export type FinalDiff = {
	display: DisplayDiff;
	firstChangedLine?: number;
	truncated: boolean;
	stats: ChangeStats;
	degraded: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPositiveLineNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isChangeStats(value: unknown): value is ChangeStats {
	if (!isRecord(value)) return false;
	const { additions, deletions, changedLines } = value;
	return typeof additions === "number" && Number.isInteger(additions) && additions >= 0 &&
		typeof deletions === "number" && Number.isInteger(deletions) && deletions >= 0 &&
		typeof changedLines === "number" && Number.isInteger(changedLines) && changedLines === additions + deletions;
}

function isHighlightRanges(value: unknown, contentLength: number): value is DiffHighlightRange[] {
	if (!Array.isArray(value)) return false;
	let previousEnd = 0;
	for (const range of value) {
		if (!isRecord(range) ||
			typeof range.start !== "number" ||
			typeof range.end !== "number" ||
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < previousEnd ||
			range.start < 0 ||
			range.end <= range.start ||
			range.end > contentLength) return false;
		previousEnd = range.end;
	}
	return true;
}

export function isDisplayDiff(value: unknown): value is DisplayDiff {
	if (!isRecord(value) || !isPositiveLineNumber(value.lineNumberWidth) || !Array.isArray(value.rows)) return false;
	return value.rows.every((row) => {
		if (!isRecord(row) || typeof row.kind !== "string") return false;
		if (row.kind === "context") {
			return isPositiveLineNumber(row.oldLine) && isPositiveLineNumber(row.newLine) && typeof row.content === "string";
		}
		if (row.kind === "remove") {
			return isPositiveLineNumber(row.oldLine) && typeof row.content === "string" && isHighlightRanges(row.highlights, row.content.length);
		}
		if (row.kind === "add") {
			return isPositiveLineNumber(row.newLine) && typeof row.content === "string" && isHighlightRanges(row.highlights, row.content.length);
		}
		if (row.kind === "unlocated") {
			return ["context", "remove", "add"].includes(String(row.operation)) &&
				typeof row.content === "string" &&
				isHighlightRanges(row.highlights, row.content.length);
		}
		if (row.kind === "fold") return isPositiveLineNumber(row.omittedLines);
		return row.kind === "annotation" && (row.side === "old" || row.side === "new") && typeof row.content === "string";
	});
}

const DEFAULT_CONTEXT_LINES = 4;
/**
 * exact 路径的 Myers 超时 tripwire（abnormal 输入守卫，不是设计目标）：
 * jsdiff structuredPatch 阻塞到 deadline 后返回 undefined，随后降级为 O(N) unlocated diff。
 * 常见场景（局部修改 / 无共享行 / rewrite）全部有 fast path，不会到达超时。
 */
const DIFF_TIMEOUT_MS = 250;
const UTF8_ENCODER = new TextEncoder();

/**
 * 词级细化 DP 细胞预算：行字符数乘积超限跳过行内细化。
 * 字符数是 diffWordsWithSpace token 数的上界（按 \S+ 计数会漏放
 * 低空格长行——minified/长字面量单行数千 word token，Myers 无超时爆炸：
 * worker 5s watchdog 杀掉后主线程同步 fallback 重跑同样计算，卡死 TUI）。
 * 正常代码行 < 200 字符（< 40k cells）；~1.4k 字符以上的行跳过细化，整行高亮。
 */
const WORD_REFINEMENT_MAX_CELLS = 2_000_000;

/**
 * 配对的最低 Dice 相似度（基于行内词 token 多重集）。
 * 0.5 可捕获两 token 行的单 token 修改（`import asyncio` -> `import json`），
 * 同时靠配对的单调性约束（DP 不交叉）排除错误的交叉配对。
 */
const PAIR_SIMILARITY_THRESHOLD = 0.5;
/**
 * 行配对密集 DP 的规模上限（old×new 行数乘积）。
 * 实测修改特征：changed block 中位 2 行、绝大部分 ≤ 数十行（session 统计）；
 * 256×256 = 65536 对 DP ≈ 64KB choice + 几 ms，覆盖 3k 行文件里的连续大段重写。
 * 超限跳过配对（整行高亮）——与 Zed should_perform_word_diff_within_hunk 同款预算语义，
 * 防御病态 block 的 O(m*n) 成本。
 */
const DENSE_PAIR_MAX_PRODUCT = 65_536;

type ChangedSide = "old" | "new";

type BlockItem = {
	rowIndex: number;
	annotations: number[];
};

type PatchHunk = {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
};

function changedSide(row: DisplayDiffRow): ChangedSide | undefined {
	if (row.kind === "remove" || row.kind === "unlocated" && row.operation === "remove") return "old";
	if (row.kind === "add" || row.kind === "unlocated" && row.operation === "add") return "new";
	return undefined;
}

function changedContent(row: DisplayDiffRow): string {
	if (row.kind === "remove" || row.kind === "add" || row.kind === "unlocated") return row.content;
	throw new Error(`diff_highlight_row_invalid kind=${row.kind} action="report the display diff row"`);
}

function appendHighlight(row: DisplayDiffRow, start: number, end: number): void {
	if (row.kind !== "remove" && row.kind !== "add" && row.kind !== "unlocated") {
		throw new Error(`diff_highlight_target_invalid kind=${row.kind} action="report the display diff row"`);
	}
	const value = row.content.slice(start, end);
	start += value.length - value.trimStart().length;
	end -= value.length - value.trimEnd().length;
	if (start >= end) return;
	const previous = row.highlights.at(-1);
	if (previous && start <= previous.end) {
		previous.end = Math.max(previous.end, end);
		return;
	}
	row.highlights.push({ start, end });
}

function highlightWholeRow(row: DisplayDiffRow): void {
	// fold/annotation 之外的 changed 行才有 content；fold 行是 gap，无高亮。
	if (!("content" in row)) return;
	appendHighlight(row, 0, row.content.length);
}

function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** 行级公共前缀长度（跳过相同行的前置部分）。 */
function commonPrefixLines(oldLines: string[], newLines: string[]): number {
	const limit = Math.min(oldLines.length, newLines.length);
	let prefix = 0;
	while (prefix < limit && oldLines[prefix] === newLines[prefix]) prefix += 1;
	return prefix;
}

/** 行级公共后缀长度（跳过相同行的尾部部分）。 */
function commonSuffixLines(oldLines: string[], newLines: string[], prefix: number): number {
	const limit = Math.min(oldLines.length, newLines.length) - prefix;
	let suffix = 0;
	while (
		suffix < limit &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	return suffix;
}

/**
 * 行集合交集判定（O(N)）：无共享行 → 全部行都变更，可直接生成 remove+add 输出。
 * 集合用 Set；仅在行文本层面判定（保守：文本相同而换行状态不同的行仍视为共享）。
 */
function sharesAnyLine(oldLines: string[], newLines: string[]): boolean {
	if (oldLines.length === 0 || newLines.length === 0) return false;
	const seen = new Set(oldLines);
	for (const line of newLines) {
		if (seen.has(line)) return true;
	}
	return false;
}

/**
 * 行 token 集（排序去重）：词 token 多重集作为相似度指纹。
 * 纯符号行（无词 token，如 `);`、`}`、`=>`）：用 trim 后整行内容作为唯一 token，
 * 内容相同（仅缩进/空白不同）的符号行因此可配对，内容不同的不配对。
 */
function lineTokens(content: string): string[] {
	const tokens = new Set<string>();
	for (const token of content.match(/[A-Za-z0-9_]+/g) ?? []) tokens.add(token);
	if (tokens.size === 0) tokens.add(`\u0000${content.trim()}`);
	return [...tokens].sort();
}

function diceSimilarity(oldTokens: string[], newTokens: string[]): number {
	const total = oldTokens.length + newTokens.length;
	if (total === 0) return 0;
	// w = 2*common/total >= 阈值 要求 common >= total/4，且 common <= min(a,b)；
	// min(a,b) < total/4 时（即 max > 3*min）不可能达到阈值，O(1) 预检跳过。
	const required = Math.ceil(total / 4);
	if (required > Math.min(oldTokens.length, newTokens.length)) return 0;
	let common = 0;
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
		// 提前终止：剩余可能公共数已不足以达到阈值。
		if (common + Math.min(oldTokens.length - oldIndex, newTokens.length - newIndex) < required) return 0;
		const left = oldTokens[oldIndex]!;
		const right = newTokens[newIndex]!;
		if (left === right) {
			common += 1;
			oldIndex += 1;
			newIndex += 1;
		} else if (left < right) {
			oldIndex += 1;
		} else {
			newIndex += 1;
		}
	}
	return common >= required ? (2 * common) / total : 0;
}

/** 全矩阵滚动数组加权 LCS，O(m*n)：单调配对（不交叉），权重 = Dice 相似度，低于阈值不配对。 */
function densePairChangedItems(oldTokens: string[][], newTokens: string[][]): Map<number, number> {
	const oldCount = oldTokens.length;
	const newCount = newTokens.length;
	const best = new Float64Array(newCount + 1);
	const choice = new Uint8Array(oldCount * newCount);
	for (let i = 1; i <= oldCount; i += 1) {
		let diagonal = best[0]!;
		for (let j = 1; j <= newCount; j += 1) {
			const skipOld = best[j]!;
			const skipNew = best[j - 1]!;
			const similarity = diceSimilarity(oldTokens[i - 1]!, newTokens[j - 1]!);
			const pairScore = similarity >= PAIR_SIMILARITY_THRESHOLD ? diagonal + similarity : Number.NEGATIVE_INFINITY;
			const slot = (i - 1) * newCount + (j - 1);
			if (pairScore >= skipOld && pairScore >= skipNew) {
				best[j] = pairScore;
				choice[slot] = 2;
			} else if (skipOld >= skipNew) {
				best[j] = skipOld;
				choice[slot] = 0;
			} else {
				best[j] = skipNew;
				choice[slot] = 1;
			}
			diagonal = skipOld;
		}
	}

	const pairs = new Map<number, number>();
	let i = oldCount;
	let j = newCount;
	while (i > 0 && j > 0) {
		const slot = (i - 1) * newCount + (j - 1);
		if (choice[slot] === 2) {
			pairs.set(i - 1, j - 1);
			i -= 1;
			j -= 1;
		} else if (choice[slot] === 0) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return pairs;
}

/**
 * 行配对：old 行与 new 行单调配对（不交叉），权重 = Dice 相似度。
 * 规模预算内（old×new ≤ 65536）跑全矩阵 DP；超限跳过配对（整行高亮），
 * 词级细化只在预算内做（Zed should_perform_word_diff_within_hunk 同款语义）。
 * 返回 old 项索引 -> new 项索引。
 */
function pairChangedItems(
	rows: DisplayDiffRow[],
	oldItems: BlockItem[],
	newItems: BlockItem[],
): Map<number, number> {
	const oldCount = oldItems.length;
	const newCount = newItems.length;
	if (oldCount === 0 || newCount === 0) return new Map();
	if (oldCount * newCount > DENSE_PAIR_MAX_PRODUCT) return new Map();
	const oldTokens = oldItems.map((item) => lineTokens(changedContent(rows[item.rowIndex]!)));
	const newTokens = newItems.map((item) => lineTokens(changedContent(rows[item.rowIndex]!)));
	return densePairChangedItems(oldTokens, newTokens);
}

function refinePair(oldRow: DisplayDiffRow, newRow: DisplayDiffRow): void {
	// 调用方保证 changed 配对；fold 行（gap）无 content，防御收窄。
	if (!("content" in oldRow) || !("content" in newRow)) return;
	if ((oldRow.content.length + 1) * (newRow.content.length + 1) > WORD_REFINEMENT_MAX_CELLS) return;
	let oldOffset = 0;
	let newOffset = 0;
	for (const part of diffWordsWithSpace(oldRow.content, newRow.content)) {
		if (part.removed) {
			appendHighlight(oldRow, oldOffset, oldOffset + part.value.length);
			oldOffset += part.value.length;
			continue;
		}
		if (part.added) {
			appendHighlight(newRow, newOffset, newOffset + part.value.length);
			newOffset += part.value.length;
			continue;
		}
		oldOffset += part.value.length;
		newOffset += part.value.length;
	}
}

/**
 * changed block 细化（Zed/VS Code 同款：unified 块形态 + 块内受限词级细化）。
 * 配对仅用于词级高亮计算，不重排展示顺序（- 全部在前 + 全部在后）；
 * 未配对行整行高亮。
 */
function refineChangedBlock(rows: DisplayDiffRow[], block: BlockItem[]): void {
	if (block.length === 0 || block.length > DEFAULT_MAX_LINES) return;
	const oldItems = block.filter((item) => changedSide(rows[item.rowIndex]!) === "old");
	const newItems = block.filter((item) => changedSide(rows[item.rowIndex]!) === "new");
	const oldText = oldItems.map((item) => changedContent(rows[item.rowIndex]!)).join("\n");
	const newText = newItems.map((item) => changedContent(rows[item.rowIndex]!)).join("\n");
	if (UTF8_ENCODER.encode(oldText).byteLength + UTF8_ENCODER.encode(newText).byteLength > DEFAULT_MAX_BYTES) return;

	if (oldItems.length === 0 || newItems.length === 0) {
		for (const item of block) highlightWholeRow(rows[item.rowIndex]!);
		return;
	}

	const pairs = pairChangedItems(rows, oldItems, newItems);
	if (pairs.size === 0) {
		// 无配对（或超预算跳过）：整行高亮。
		for (const item of block) highlightWholeRow(rows[item.rowIndex]!);
		return;
	}

	for (const [oldIndex, newIndex] of pairs) {
		refinePair(rows[oldItems[oldIndex]!.rowIndex]!, rows[newItems[newIndex]!.rowIndex]!);
	}
	const pairedOld = new Set(pairs.keys());
	for (let index = 0; index < oldItems.length; index += 1) {
		if (!pairedOld.has(index)) highlightWholeRow(rows[oldItems[index]!.rowIndex]!);
	}
	const pairedNew = new Set(pairs.values());
	for (let index = 0; index < newItems.length; index += 1) {
		if (!pairedNew.has(index)) highlightWholeRow(rows[newItems[index]!.rowIndex]!);
	}
}

function refineChangedBlocks(rows: DisplayDiffRow[]): void {
	let block: BlockItem[] = [];
	const flush = () => {
		refineChangedBlock(rows, block);
		block = [];
	};

	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		if (changedSide(row)) {
			block.push({ rowIndex: index, annotations: [] });
			continue;
		}
		if (row.kind === "annotation" && block.length > 0) {
			block.at(-1)!.annotations.push(index);
			continue;
		}
		flush();
	}
	flush();
}

/**
 * 无共享行整段替换 hunk：O(N) 直接构造与 jsdiff Myers 同构的输出
 * （context 余量 + remove 块 + add 块 + context 余量）。
 * jsdiff 语义（patch/create.js）：hunk 中不以 \n 结尾的行（只能是文件最后一行）
 * 之后紧跟一条 \ No newline annotation；空侧没有变更块，不产生 annotation。
 * 避免 3000 行全替换 / 剥离后核心段全替换走 O(ND) Myers（250ms 超时白等）。
 */
function buildReplaceHunk(
	removeLines: string[],
	addLines: string[],
	oldStart: number,
	newStart: number,
	contextHead: string[],
	contextTail: string[],
	oldEofWithoutNewline: boolean,
	newEofWithoutNewline: boolean,
	tailEofWithoutNewline: boolean,
): PatchHunk {
	const lines: string[] = [];
	for (const line of contextHead) lines.push(` ${line}`);
	for (const line of removeLines) lines.push(`-${line}`);
	if (removeLines.length > 0 && oldEofWithoutNewline) lines.push("\\ No newline at end of file");
	for (const line of addLines) lines.push(`+${line}`);
	if (addLines.length > 0 && newEofWithoutNewline) lines.push("\\ No newline at end of file");
	for (const line of contextTail) lines.push(` ${line}`);
	// 文件最后一行是尾部 context 且无结尾换行：jsdiff 在该 context 行后输出 annotation。
	if (contextTail.length > 0 && tailEofWithoutNewline) lines.push("\\ No newline at end of file");
	return {
		oldStart,
		oldLines: removeLines.length,
		newStart,
		newLines: addLines.length,
		lines,
	};
}

type LineDiffResult =
	| { kind: "hunks"; hunks: PatchHunk[]; oldLineCount: number; newLineCount: number }
	| { kind: "degraded"; oldLineCount: number; newLineCount: number };

/**
 * 行级 diff pipeline（所有 fast path 与 jsdiff Myers 输出同构，探针锁定）：
 * 1. identical → 空；
 * 2. 无共享行（整体）→ O(N) 整段替换 hunk，不跑 Myers；
 * 3. 公共前后缀剥离（保留 contextLines 余量）→ 只让 Myers 处理中间段；
 * 4. 核心段（不含余量，纯变化段）无共享行 → O(N) 整段替换 hunk（带余量 context），
 *    避免"首尾相同、中间整段替换"时 Myers 白跑至 250ms 超时；
 * 5. 否则 Myers（250ms timeout tripwire），超时返回 degraded。
 */
function computeLineDiff(
	oldContent: string,
	newContent: string,
	contextLines: number,
	timeoutMs: number,
): LineDiffResult {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);

	// 无共享行 fast path：O(N) 行集合交集，输出与 jsdiff Myers 一致（remove 块 + add 块）。
	if (!sharesAnyLine(oldLines, newLines)) {
		return {
			kind: "hunks",
			oldLineCount: oldLines.length,
			newLineCount: newLines.length,
			hunks: [buildReplaceHunk(
				oldLines,
				newLines,
				1,
				1,
				[],
				[],
				!oldContent.endsWith("\n"),
				!newContent.endsWith("\n"),
				false,
			)],
		};
	}

	// 公共前后缀剥离（保留 contextLines 余量）：只让 Myers 处理中间段。
	const prefix = commonPrefixLines(oldLines, newLines);
	const suffix = commonSuffixLines(oldLines, newLines, prefix);
	const keepPrefix = Math.max(0, prefix - contextLines);
	const keepSuffix = Math.max(0, suffix - contextLines);
	const midOld = oldLines.slice(keepPrefix, oldLines.length - keepSuffix);
	const midNew = newLines.slice(keepPrefix, newLines.length - keepSuffix);

	// 核心段（不含 context 余量，纯变化段）无共享行 fast path：剥离后 Myers 仍会白跑
	// O(ND)，直接构造带余量 context 的整段替换 hunk（输出与 jsdiff 全量 Myers 同构）。
	const coreOld = oldLines.slice(prefix, oldLines.length - suffix);
	const coreNew = newLines.slice(prefix, newLines.length - suffix);
	if (coreOld.length > 0 && coreNew.length > 0 && !sharesAnyLine(coreOld, coreNew)) {
		return {
			kind: "hunks",
			oldLineCount: oldLines.length,
			newLineCount: newLines.length,
			hunks: [buildReplaceHunk(
				coreOld,
				coreNew,
				keepPrefix + 1,
				keepPrefix + 1,
				oldLines.slice(keepPrefix, prefix),
				oldLines.slice(oldLines.length - suffix, oldLines.length - keepSuffix),
				suffix === 0 && !oldContent.endsWith("\n"),
				suffix === 0 && !newContent.endsWith("\n"),
				suffix > 0 && !oldContent.endsWith("\n"),
			)],
		};
	}

	const midOldText = midOld.length === 0 ? "" : midOld.join("\n") + (keepSuffix > 0 || oldContent.endsWith("\n") ? "\n" : "");
	const midNewText = midNew.length === 0 ? "" : midNew.join("\n") + (keepSuffix > 0 || newContent.endsWith("\n") ? "\n" : "");
	const patch = structuredPatch("before", "after", midOldText, midNewText, undefined, undefined, {
		context: contextLines,
		timeout: timeoutMs,
	});
	if (patch === undefined) {
		return { kind: "degraded", oldLineCount: oldLines.length, newLineCount: newLines.length };
	}
	// 段边界保留的 context 行与 jsdiff 全量输出一致；hunk 坐标偏移回文件坐标。
	return {
		kind: "hunks",
		oldLineCount: oldLines.length,
		newLineCount: newLines.length,
		hunks: patch.hunks.map((hunk) => ({
			oldStart: hunk.oldStart + keepPrefix,
			oldLines: hunk.oldLines,
			newStart: hunk.newStart + keepPrefix,
			newLines: hunk.newLines,
			lines: hunk.lines,
		})),
	};
}

function normalizedHunkStart(start: number): number {
	return Math.max(1, start);
}

function appendFold(rows: DisplayDiffRow[], oldGap: number, newGap: number): void {
	if (oldGap !== newGap) {
		throw new Error(
			`diff_hunk_gap_mismatch oldGap=${oldGap} newGap=${newGap} action="report the jsdiff hunk coordinates and input line counts"`,
		);
	}
	if (oldGap > 0) rows.push({ kind: "fold", omittedLines: oldGap });
}

/**
 * hunks → display rows：维护两侧行号、统计 stats/firstChangedLine、
 * EOF annotation 行、hunk 间 fold、块级词级细化。
 */
function buildDisplayRows(
	hunks: PatchHunk[],
	oldLineCount: number,
	newLineCount: number,
): { rows: DisplayDiffRow[]; firstChangedLine?: number; stats: ChangeStats } {
	const rows: DisplayDiffRow[] = [];
	let nextOldLine = 1;
	let nextNewLine = 1;
	let firstChangedLine: number | undefined;
	let additions = 0;
	let deletions = 0;

	for (const hunk of hunks) {
		const hunkOldStart = normalizedHunkStart(hunk.oldStart);
		const hunkNewStart = normalizedHunkStart(hunk.newStart);
		appendFold(rows, hunkOldStart - nextOldLine, hunkNewStart - nextNewLine);

		let oldLine = hunkOldStart;
		let newLine = hunkNewStart;
		let previousChange: "old" | "new" | undefined;
		for (const patchLine of hunk.lines) {
			const prefix = patchLine[0];
			const content = patchLine.slice(1);
			if (prefix === " ") {
				rows.push({ kind: "context", oldLine, newLine, content });
				oldLine += 1;
				newLine += 1;
				previousChange = undefined;
				continue;
			}
			if (prefix === "-") {
				firstChangedLine ??= newLine;
				rows.push({ kind: "remove", oldLine, content, highlights: [] });
				oldLine += 1;
				deletions += 1;
				previousChange = "old";
				continue;
			}
			if (prefix === "+") {
				firstChangedLine ??= newLine;
				rows.push({ kind: "add", newLine, content, highlights: [] });
				newLine += 1;
				additions += 1;
				previousChange = "new";
				continue;
			}
			if (prefix === "\\") {
				// jsdiff 语义：无 \n 的 hunk 行（文件最后一行）后紧跟 annotation；
				// 该行可能是 remove/add 块（previousChange 可判定侧别）或尾部 context 行
				// （两侧共享，取 new 侧展示）。
				rows.push({ kind: "annotation", side: previousChange ?? "new", content: content.trimStart() });
				continue;
			}
			throw new Error(
				`diff_hunk_line_invalid prefix=${JSON.stringify(prefix)} line=${JSON.stringify(patchLine)} action="report the jsdiff structuredPatch output"`,
			);
		}
		nextOldLine = oldLine;
		nextNewLine = newLine;
	}

	if (hunks.length > 0) {
		appendFold(
			rows,
			oldLineCount - nextOldLine + 1,
			newLineCount - nextNewLine + 1,
		);
	}
	refineChangedBlocks(rows);

	return {
		rows,
		firstChangedLine,
		stats: { additions, deletions, changedLines: additions + deletions },
	};
}

/**
 * Degraded path: jsdiff's Myers algorithm is O(ND) and can exceed the timeout
 * when most lines change (e.g. whole-file rewrite). Strip the common prefix and
 * suffix in O(n), mark everything between as unlocated remove/add rows, and let
 * truncation cap the output. Stats stay exact because untouched rows are only
 * stripped from both sides. Coordinate rows and word highlights are
 * intentionally absent: line numbers would require the full diff we just
 * aborted, and word refinement on a multi-thousand-line block is itself O(ND).
 */
export function degradeToUnlocated(
	oldContent: string,
	newContent: string,
): { rows: DisplayDiffRow[]; stats: ChangeStats } {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);

	let prefix = 0;
	const commonLimit = Math.min(oldLines.length, newLines.length);
	while (prefix < commonLimit && oldLines[prefix] === newLines[prefix]) prefix += 1;

	let suffix = 0;
	while (
		suffix < commonLimit - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const oldEnd = oldLines.length - suffix;
	const newEnd = newLines.length - suffix;
	const rows: DisplayDiffRow[] = [];
	for (let index = prefix; index < oldEnd; index += 1) {
		rows.push({ kind: "unlocated", operation: "remove", content: oldLines[index]!, highlights: [] });
	}
	for (let index = prefix; index < newEnd; index += 1) {
		rows.push({ kind: "unlocated", operation: "add", content: newLines[index]!, highlights: [] });
	}

	return {
		rows,
		stats: {
			additions: newEnd - prefix,
			deletions: oldEnd - prefix,
			changedLines: newEnd - prefix + (oldEnd - prefix),
		},
	};
}

function lineNumber(value: number | undefined, width: number): string {
	return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

export function serializeDisplayDiff(display: DisplayDiff): string {
	const width = display.lineNumberWidth;
	return display.rows.map((row) => {
		if (row.kind === "context") {
			return ` ${lineNumber(row.oldLine, width)} ${lineNumber(row.newLine, width)} │ ${row.content}`;
		}
		if (row.kind === "remove") {
			return `-${lineNumber(row.oldLine, width)} ${lineNumber(undefined, width)} │ ${row.content}`;
		}
		if (row.kind === "add") {
			return `+${lineNumber(undefined, width)} ${lineNumber(row.newLine, width)} │ ${row.content}`;
		}
		if (row.kind === "unlocated") {
			const prefix = row.operation === "add" ? "+" : row.operation === "remove" ? "-" : " ";
			return `${prefix}${lineNumber(undefined, width)} ${lineNumber(undefined, width)} │ ${row.content}`;
		}
		if (row.kind === "fold") {
			const unit = row.omittedLines === 1 ? "line" : "lines";
			return ` ${lineNumber(undefined, width)} ${lineNumber(undefined, width)} │ ... ${row.omittedLines} unchanged ${unit} omitted`;
		}
		return ` ${lineNumber(undefined, width)} ${lineNumber(undefined, width)} │ \\ No newline at end of ${row.side} file`;
	}).join("\n");
}

export function displayDiffFromLines(
	lines: readonly { prefix: " " | "+" | "-"; text: string }[],
): DisplayDiff {
	const rows: DisplayDiffRow[] = lines.map((line) => ({
		kind: "unlocated",
		operation: line.prefix === "+" ? "add" : line.prefix === "-" ? "remove" : "context",
		content: line.text,
		highlights: [],
	}));
	refineChangedBlocks(rows);

	return {
		lineNumberWidth: 1,
		rows,
	};
}

function truncateDisplay(display: DisplayDiff): { display: DisplayDiff; truncated: boolean } {
	const fullText = serializeDisplayDiff(display);
	const truncated = truncateHead(fullText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncated.truncated) return { display, truncated: false };
	return {
		display: {
			lineNumberWidth: display.lineNumberWidth,
			rows: display.rows.slice(0, truncated.outputLines),
		},
		truncated: true,
	};
}

export type FinalDiffOptions = {
	timeoutMs?: number;
};

/**
 * 可证明的 whole rewrite diff：精确 stats，不依赖 Myers。
 * presentation rows 边构建边应用 Pi output limit（2000 lines / 50KB，前缀保留）；
 * 不计算 line coordinates，不计算 word highlights。
 * 调用方必须能证明 old 全部被替换（delete-add pair / 全文件 matched span），
 * 不能用阈值猜测 — 无法证明时走 generateFinalDiff（exact，250ms 超时为 tripwire）。
 */
export function generateRewriteDiff(oldContent: string, newContent: string): FinalDiff {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);
	const stats: ChangeStats = {
		additions: newLines.length,
		deletions: oldLines.length,
		changedLines: oldLines.length + newLines.length,
	};
	const width = 1;
	// 边构建边截断：与 truncateDisplay 相同的估算口径（unlocated 行无行号宽度）。
	let totalBytes = 0;
	let kept = 0;
	const rows: DisplayDiffRow[] = [];
	const pushRow = (row: DisplayDiffRow, contentLen: number) => {
		const len = 2 * width + 5 + contentLen;
		if (kept >= DEFAULT_MAX_LINES || totalBytes + len > DEFAULT_MAX_BYTES) return false;
		rows.push(row);
		totalBytes += len;
		kept += 1;
		return true;
	};
	for (const line of oldLines) {
		if (!pushRow({ kind: "unlocated", operation: "remove", content: line, highlights: [] }, line.length)) break;
	}
	for (const line of newLines) {
		if (!pushRow({ kind: "unlocated", operation: "add", content: line, highlights: [] }, line.length)) break;
	}
	return {
		display: { lineNumberWidth: width, rows },
		firstChangedLine: undefined,
		truncated: kept < oldLines.length + newLines.length,
		stats,
		degraded: true,
	};
}

export function generateFinalDiff(
	oldContent: string,
	newContent: string,
	contextLines = DEFAULT_CONTEXT_LINES,
	options?: FinalDiffOptions,
): FinalDiff {
	if (!Number.isInteger(contextLines) || contextLines < 0) {
		throw new Error(`diff_context_invalid current=${contextLines} expected="non-negative integer" action="pass a valid context line count"`);
	}
	if (oldContent === newContent) {
		return {
			display: { lineNumberWidth: 1, rows: [] },
			firstChangedLine: undefined,
			truncated: false,
			stats: { additions: 0, deletions: 0, changedLines: 0 },
			degraded: false,
		};
	}

	const lineDiff = computeLineDiff(oldContent, newContent, contextLines, options?.timeoutMs ?? DIFF_TIMEOUT_MS);
	if (lineDiff.kind === "degraded") {
		const degraded = degradeToUnlocated(oldContent, newContent);
		return {
			display: { lineNumberWidth: 1, rows: degraded.rows },
			firstChangedLine: undefined,
			truncated: false,
			stats: degraded.stats,
			degraded: true,
		};
	}

	const { rows, firstChangedLine, stats } = buildDisplayRows(lineDiff.hunks, lineDiff.oldLineCount, lineDiff.newLineCount);
	const output = truncateDisplay({ lineNumberWidth: String(Math.max(1, lineDiff.oldLineCount, lineDiff.newLineCount)).length, rows });
	return {
		display: output.display,
		firstChangedLine,
		truncated: output.truncated,
		stats,
		degraded: false,
	};
}
