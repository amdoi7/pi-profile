import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { diffWordsWithSpace, structuredPatch } from "diff";

import { isRustDiffEngineAvailable, rustGenerateDiffJson } from "./ffi-diff.ts";

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
const DIFF_TIMEOUT_MS = 250;
const UTF8_ENCODER = new TextEncoder();

/**
 * 配对的最低 Dice 相似度（基于行内词 token 多重集）。
 * 0.5 可捕获两 token 行的单 token 修改（`import asyncio` -> `import json`），
 * 同时靠配对的单调性约束（DP 不交叉）排除错误的交叉配对。
 */
const PAIR_SIMILARITY_THRESHOLD = 0.5;
/**
 * 稀疏候选的相似度比较次数 tripwire：超过则回退全矩阵 DP。
 * popular 剔除后合法输入（字节守卫 50KB 内）最坏约 250k 次比较（见 benchmark），
 * 该值仅保护未来守卫调整后的病态输入。
 */
const SPARSE_MAX_COMPARISONS = 1_000_000;

type ChangedSide = "old" | "new";

type BlockItem = {
	rowIndex: number;
	annotations: number[];
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

/**
 * 行 token 集 interning（借鉴 imara-diff 的 Token(u32) 指针压缩）：
 * token 字符串映射为唯一 u32 ID，行 token 集为排序去重的 Uint32Array，
 * 后续相似度比较与倒排索引都在整数上运行（哈希/相等开销摊销一次）。
 * intern 表由调用方持有并跨 old/new 两侧共享，保证两侧 ID 空间一致；
 * 相同行内容复用缓存。
 */
function internItems(
	rows: DisplayDiffRow[],
	items: BlockItem[],
	intern: Map<string, number>,
): Uint32Array[] {
	const cache = new Map<string, Uint32Array>();
	return items.map((item) => {
		const content = changedContent(rows[item.rowIndex]!);
		let tokens = cache.get(content);
		if (tokens === undefined) {
			const ids = new Set<number>();
			for (const token of content.match(/[A-Za-z0-9_]+/g) ?? []) {
				let id = intern.get(token);
				if (id === undefined) {
					id = intern.size;
					intern.set(token, id);
				}
				ids.add(id);
			}
			tokens = Uint32Array.from(ids).sort();
			cache.set(content, tokens);
		}
		return tokens;
	});
}

function diceSimilarity(oldTokens: Uint32Array, newTokens: Uint32Array): number {
	const oldCount = oldTokens.length;
	const newCount = newTokens.length;
	const total = oldCount + newCount;
	if (total === 0) return 0;
	// w = 2*common/total >= 阈值 要求 common >= total/4，且 common <= min(a,b)；
	// min(a,b) < total/4 时（即 max > 3*min）不可能达到阈值，O(1) 预检跳过。
	const required = Math.ceil(total / 4);
	if (required > Math.min(oldCount, newCount)) return 0;
	let common = 0;
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldCount && newIndex < newCount) {
		// 提前终止：剩余可能公共数已不足以达到阈值。
		if (common + Math.min(oldCount - oldIndex, newCount - newIndex) < required) return 0;
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

/**
 * 稀疏候选：倒排索引（token ID -> 行列表，对应 go-difflib 的 b2j）过滤出
 * 共享 token 的行对，只对它们计算相似度；达标对（w >= 阈值）按 old 行序返回。
 * block >= 200 行时剔除高频 popular token（出现 > newCount/100 + 1 次，
 * 对应 difflib autoJunk 与 imara-diff histogram 的出现频率上限），防止
 * `const`/`import` 等通用前缀导致候选爆炸。
 * 相似度比较次数超过上限时返回 undefined（回退全矩阵 DP）。
 */
function sparseCandidates(
	oldTokens: Uint32Array[],
	newTokens: Uint32Array[],
	maxComparisons: number,
): Array<{ i: number; j: number; w: number }> | undefined {
	const inverted = new Map<number, number[]>();
	for (let j = 0; j < newTokens.length; j += 1) {
		for (const token of newTokens[j]!) {
			let list = inverted.get(token);
			if (list === undefined) {
				list = [];
				inverted.set(token, list);
			}
			list.push(j);
		}
	}

	// popular 剔除：高频通用 token 不参与候选定位，
	// 相似度计算仍使用完整 token 集，因此仅共享通用 token 的阈值边缘对
	// 会退化为不配对（整行高亮），不损失其他配对。
	if (newTokens.length >= 200) {
		const popularLimit = Math.floor(newTokens.length / 100) + 1;
		for (const [token, list] of inverted) {
			if (list.length > popularLimit) inverted.delete(token);
		}
	}

	const candidates: Array<{ i: number; j: number; w: number }> = [];
	const seen = new Set<number>();
	let comparisons = 0;
	for (let i = 0; i < oldTokens.length; i += 1) {
		seen.clear();
		for (const token of oldTokens[i]!) {
			const list = inverted.get(token);
			if (list === undefined) continue;
			for (const j of list) {
				if (seen.has(j)) continue;
				seen.add(j);
				comparisons += 1;
				if (comparisons > maxComparisons) return undefined;
				const w = diceSimilarity(oldTokens[i]!, newTokens[j]!);
				if (w >= PAIR_SIMILARITY_THRESHOLD) candidates.push({ i, j, w });
			}
		}
	}
	return candidates;
}

/**
 * 加权单调链：候选按 old 行序处理，Fenwick 树按 new 列维护前缀最大权重，
 * 求权重最大、两侧索引都严格递增的配对（与全矩阵 DP 同解，O(K log n)）。
 * 同一 old 行的候选先全部查询再更新，避免同一行配多个 new 行。
 */
function weightedMonotoneChain(
	candidates: Array<{ i: number; j: number; w: number }>,
	newCount: number,
): Map<number, number> {
	const bitValue = new Float64Array(newCount + 1);
	const bitIndex = new Int32Array(newCount + 1);
	// dp 数组 1-based：索引 j 对应 0-based new 索引 j-1；索引 0 是"无配对"哨兵。
	const best = new Float64Array(newCount + 1);
	const prev = new Int32Array(newCount + 1);
	const updater = new Int32Array(newCount + 1);
	updater.fill(-1);

	// BIT 按 1-based 位置存储：0-based new 索引 j 映射为位置 j+1，
	// 避免 j=0 时 j += j & -j 永不前进的死循环。
	const prefixMax = (j0: number): { value: number; index: number } => {
		let value = 0;
		let index = -1;
		for (let j = j0; j > 0; j -= j & -j) {
			if (bitValue[j]! > value) {
				value = bitValue[j]!;
				index = bitIndex[j]!;
			}
		}
		return { value, index };
	};
	const updateBit = (j0: number, value: number, index0: number): void => {
		for (let j = j0 + 1; j <= newCount; j += j & -j) {
			if (value > bitValue[j]!) {
				bitValue[j] = value;
				bitIndex[j] = index0;
			}
		}
	};

	let pending: Array<{ j: number; score: number; prevJ: number; i: number }> = [];
	const flush = () => {
		for (const item of pending) {
			if (item.score > best[item.j + 1]!) {
				best[item.j + 1] = item.score;
				prev[item.j + 1] = item.prevJ;
				updater[item.j + 1] = item.i;
				updateBit(item.j, item.score, item.j);
			}
		}
		pending = [];
	};
	let currentI = -1;
	for (const candidate of candidates) {
		if (candidate.i !== currentI) {
			flush();
			currentI = candidate.i;
		}
		const { value, index } = prefixMax(candidate.j);
		// prev 存 1-based 前驱位置（0 = 无前驱），index=-1 表示 BIT 未命中。
		pending.push({ j: candidate.j, score: value + candidate.w, prevJ: index >= 0 ? index + 1 : 0, i: candidate.i });
	}
	flush();

	let bestJ = 0;
	for (let j = 1; j <= newCount; j += 1) {
		if (best[j]! > best[bestJ]!) bestJ = j;
	}
	const pairs = new Map<number, number>();
	while (bestJ > 0) {
		pairs.set(updater[bestJ]!, bestJ - 1);
		bestJ = prev[bestJ]!;
	}
	return pairs;
}

/** 全矩阵回退：滚动数组加权 LCS，O(m*n)，无对数因子（候选密集时更快）。 */
function densePairChangedItems(oldTokens: Uint32Array[], newTokens: Uint32Array[]): Map<number, number> {
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
 * 行配对：old 行与 new 行单调配对（不交叉），权重 = Dice 相似度，低于阈值不配对。
 * 主路径为倒排索引候选（b2j，difflib 结构）+ 加权单调链（O(K log n)，
 * K = 共享 token 的行对数）；候选密集（比较次数 > maxComparisons）时
 * 回退全矩阵 DP（O(m*n)，无对数因子，实测 4M 对约 90ms）。
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
	const intern = new Map<string, number>();
	const oldTokens = internItems(rows, oldItems, intern);
	const newTokens = internItems(rows, newItems, intern);
	const candidates = sparseCandidates(oldTokens, newTokens, SPARSE_MAX_COMPARISONS);
	if (candidates !== undefined) return weightedMonotoneChain(candidates, newCount);
	return densePairChangedItems(oldTokens, newTokens);
}

/**
 * 重排 changed block：配对行以 -/+ 相邻输出（- 在前），
 * 纯插入按 new 侧顺序排列，纯删除按 old 侧顺序插入到
 * 第一个 old 位置更靠后的配对行之前（两侧行号各自单调）。
 */
function reorderChangedItems(
	rows: DisplayDiffRow[],
	block: BlockItem[],
	oldItems: BlockItem[],
	newItems: BlockItem[],
	pairs: Map<number, number>,
): void {
	const newToOld = new Map<number, number>();
	for (const [oldIndex, newIndex] of pairs) newToOld.set(newIndex, oldIndex);

	const ordered: BlockItem[] = [];
	const orderedOldIndexes: Array<number | undefined> = [];
	const pushedOld = new Set<number>();
	for (let newIndex = 0; newIndex < newItems.length; newIndex += 1) {
		const oldIndex = newToOld.get(newIndex);
		if (oldIndex !== undefined && !pushedOld.has(oldIndex)) {
			ordered.push(oldItems[oldIndex]!);
			orderedOldIndexes.push(oldIndex);
			pushedOld.add(oldIndex);
		}
		ordered.push(newItems[newIndex]!);
		orderedOldIndexes.push(undefined);
	}
	for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex += 1) {
		if (pairs.has(oldIndex)) continue;
		const deleteItem = oldItems[oldIndex]!;
		let position = ordered.length;
		for (let k = 0; k < ordered.length; k += 1) {
			const anchor = orderedOldIndexes[k];
			if (anchor !== undefined && anchor > oldIndex) {
				position = k;
				break;
			}
		}
		ordered.splice(position, 0, deleteItem);
		orderedOldIndexes.splice(position, 0, oldIndex);
	}

	const first = block[0]!;
	const last = block.at(-1)!;
	const start = first.rowIndex;
	const end = (last.annotations.at(-1) ?? last.rowIndex) + 1;
	const rebuilt: DisplayDiffRow[] = [];
	for (const item of ordered) {
		rebuilt.push(rows[item.rowIndex]!);
		for (const annotation of item.annotations) rebuilt.push(rows[annotation]!);
	}
	if (rebuilt.length !== end - start) {
		throw new Error(
			`diff_block_reorder_mismatch expected=${end - start} actual=${rebuilt.length} action="report the changed block rows"`,
		);
	}
	rows.splice(start, end - start, ...rebuilt);
}

function highlightWholeRow(row: DisplayDiffRow): void {
	appendHighlight(row, 0, row.content.length);
}

function refinePair(oldRow: DisplayDiffRow, newRow: DisplayDiffRow): void {
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
		// 无配对：保持 unified 顺序，整行高亮。
		for (const item of block) highlightWholeRow(rows[item.rowIndex]!);
		return;
	}

	// 高亮必须在重排之前：rowIndex 此时仍指向原始行。
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

	reorderChangedItems(rows, block, oldItems, newItems, pairs);
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

function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
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

function sourceLineCount(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
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

function buildDisplayDiff(
	oldContent: string,
	newContent: string,
	contextLines: number,
	timeoutMs: number,
): { display: DisplayDiff; firstChangedLine?: number; stats: ChangeStats; degraded: boolean } {
	const patch = structuredPatch("before", "after", oldContent, newContent, undefined, undefined, {
		context: contextLines,
		timeout: timeoutMs,
	});

	if (patch === undefined) {
		const degraded = degradeToUnlocated(oldContent, newContent);
		return {
			display: { lineNumberWidth: 1, rows: degraded.rows },
			firstChangedLine: undefined,
			stats: degraded.stats,
			degraded: true,
		};
	}
	const oldLineCount = sourceLineCount(oldContent);
	const newLineCount = sourceLineCount(newContent);
	const rows: DisplayDiffRow[] = [];
	let nextOldLine = 1;
	let nextNewLine = 1;
	let firstChangedLine: number | undefined;
	let additions = 0;
	let deletions = 0;

	for (const hunk of patch.hunks) {
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
			if (prefix === "\\" && previousChange !== undefined) {
				rows.push({ kind: "annotation", side: previousChange, content: content.trimStart() });
				continue;
			}
			throw new Error(
				`diff_hunk_line_invalid prefix=${JSON.stringify(prefix)} line=${JSON.stringify(patchLine)} action="report the jsdiff structuredPatch output"`,
			);
		}
		nextOldLine = oldLine;
		nextNewLine = newLine;
	}

	if (patch.hunks.length > 0) {
		appendFold(
			rows,
			oldLineCount - nextOldLine + 1,
			newLineCount - nextNewLine + 1,
		);
	}
	refineChangedBlocks(rows);


	return {
		display: {
			lineNumberWidth: String(Math.max(1, oldLineCount, newLineCount)).length,
			rows,
		},
		firstChangedLine,
		stats: { additions, deletions, changedLines: additions + deletions },
		degraded: false,
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

function engineMode(): "auto" | "rust" | "js" {
	const mode = process.env.PI_DIFF_ENGINE;
	if (mode === "rust" || mode === "js") return mode;
	return "auto";
}

/**
 * Parse the Rust engine JSON into a FinalDiff.
 * JSON contract (v1):
 * rows: [ {k:"c",o,n,c} | {k:"r",o,c,h} | {k:"a",n,c,h} | {k:"u",op,c,h} | {k:"f",n} | {k:"x",s,c} ]
 * stats: {a,d,cl}, first?, degraded?
 */
function rustJsonToFinalDiff(json: string, oldContent: string, newContent: string): FinalDiff | undefined {
	try {
		const parsed = JSON.parse(json) as {
			v?: number;
			rows?: Array<Record<string, unknown>>;
			stats?: { a?: number; d?: number };
			first?: number;
			degraded?: boolean;
		};
		if (parsed.v !== 1 || !Array.isArray(parsed.rows)) return undefined;
		const rows: DisplayDiffRow[] = [];
		for (const raw of parsed.rows) {
			const highlights: DiffHighlightRange[] = (Array.isArray(raw.h) ? raw.h : []).map((pair) => {
				const [start, end] = pair as [number, number];
				return { start, end };
			});
			switch (raw.k) {
				case "c": {
					const row = raw as { o?: number; n?: number; c?: string };
					rows.push({ kind: "context", oldLine: row.o ?? 0, newLine: row.n ?? 0, content: row.c ?? "" });
					break;
				}
				case "r": {
					const row = raw as { o?: number; c?: string };
					rows.push({ kind: "remove", oldLine: row.o ?? 0, content: row.c ?? "", highlights });
					break;
				}
				case "a": {
					const row = raw as { n?: number; c?: string };
					rows.push({ kind: "add", newLine: row.n ?? 0, content: row.c ?? "", highlights });
					break;
				}
				case "u": {
					const row = raw as { op?: string; c?: string };
					const operation = row.op === "add" ? "add" : row.op === "remove" ? "remove" : "context";
					rows.push({ kind: "unlocated", operation, content: row.c ?? "", highlights });
					break;
				}
				case "f": {
					const row = raw as { n?: number };
					rows.push({ kind: "fold", omittedLines: row.n ?? 0 });
					break;
				}
				case "x": {
					const row = raw as { s?: string; c?: string };
					rows.push({ kind: "annotation", side: row.s === "new" ? "new" : "old", content: row.c ?? "" });
					break;
				}
				default:
					return undefined;
			}
		}
		if (!isDisplayDiff({ lineNumberWidth: 1, rows })) return undefined;
		const stats = parsed.stats;
		const changeStats: ChangeStats = {
			additions: stats?.a ?? 0,
			deletions: stats?.d ?? 0,
			changedLines: (stats?.a ?? 0) + (stats?.d ?? 0),
		};
		const oldLineCount = sourceLineCount(oldContent);
		const newLineCount = sourceLineCount(newContent);
		const display: DisplayDiff = {
			lineNumberWidth: String(Math.max(1, oldLineCount, newLineCount)).length,
			rows,
		};
		const output = truncateDisplay(display);
		return {
			display: output.display,
			firstChangedLine: parsed.first,
			truncated: output.truncated,
			stats: changeStats,
			degraded: parsed.degraded === true,
		};
	} catch {
		return undefined;
	}
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
	const mode = engineMode();
	if (mode !== "js") {
		const timeoutMs = options?.timeoutMs ?? DIFF_TIMEOUT_MS;
		const json = rustGenerateDiffJson(oldContent, newContent, contextLines, timeoutMs);
		if (json !== undefined) {
			const parsed = rustJsonToFinalDiff(json, oldContent, newContent);
			if (parsed !== undefined) return parsed;
		}
		if (mode === "rust") {
			throw new Error(`diff_engine_rust_unavailable action="build diff-engine (cargo build --release) or unset PI_DIFF_ENGINE=rust"`);
		}
	}
	const generated = buildDisplayDiff(oldContent, newContent, contextLines, options?.timeoutMs ?? DIFF_TIMEOUT_MS);
	const output = truncateDisplay(generated.display);
	return {
		display: output.display,
		firstChangedLine: generated.firstChangedLine,
		truncated: output.truncated,
		stats: generated.stats,
		degraded: generated.degraded,
	};
}
