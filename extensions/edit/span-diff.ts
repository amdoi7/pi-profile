/**
 * span-diff.ts —— 用已知的替换区间构造展示 diff，而不是去「求解」diff。
 *
 * 通用 diff（Myers, O(N·D)）解决的是「只知道前后两个文本、不知道改了哪里」；
 * edit 恰恰**确切知道**改了哪些字节（matched spans）。所以这里的规模是
 * 编辑的规模，不是文件的规模：
 *
 * - 每个 span 扩到行边界 + context 行 = 一个展示窗口，重叠窗口合并；
 * - 每个窗口内部仍交给共享 diff 引擎（行对齐 + 词级高亮 + EOF annotation），
 *   但输入只有窗口那几行 —— O(编辑) 而不是 O(文件)，也就不需要 worker、
 *   不需要超时 tripwire 猜测、不需要预算阈值；
 * - 窗口之间/首尾按精确行数补 fold 行，行号、stats、firstChangedLine 与
 *   整文件 diff 同构（未改动区域两侧文本相同，行数天然相等）。
 *
 * 唯一的全文级成本是数换行（`indexOf` 扫描，用于行号与折叠计数）。
 */

import {
	generateFinalDiff,
	generateRewriteDiff,
	truncateDisplay,
	type ChangeStats,
	type DisplayDiffRow,
	type FinalDiff,
} from "../_shared/final-diff.ts";
import type { MatchedEditSpan } from "./edit-engine.ts";

/** 窗口内的 span（偏移已换算到窗口切片坐标）。 */
type WindowSpan = { matchIndex: number; matchLength: number; newText: string };

type DiffWindow = {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
	spans: WindowSpan[];
};

/** 从 index 所在行的行首往前退 lines 行，返回该行的行首偏移。 */
function lineStartBack(content: string, index: number, lines: number): number {
	let start = content.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
	for (let step = 0; step < lines && start > 0; step += 1) {
		start = content.lastIndexOf("\n", start - 2) + 1;
	}
	return start;
}

/** 从 index 所在行的行尾往后进 lines 行，返回下一行行首（或内容末尾）。 */
function lineEndForward(content: string, index: number, lines: number): number {
	let end = content.indexOf("\n", Math.max(0, index));
	if (end === -1) return content.length;
	end += 1;
	for (let step = 0; step < lines && end < content.length; step += 1) {
		const next = content.indexOf("\n", end);
		if (next === -1) return content.length;
		end = next + 1;
	}
	return end;
}

/** 单调推进的行号计数器（offset 必须非递减）：全文只扫一遍换行。 */
function lineCounter(content: string): (offset: number) => number {
	let cursor = 0;
	let line = 1;
	return (offset: number) => {
		while (cursor < offset) {
			const next = content.indexOf("\n", cursor);
			if (next === -1 || next >= offset) break;
			cursor = next + 1;
			line += 1;
		}
		return line;
	};
}

function countLines(content: string): number {
	if (content.length === 0) return 0;
	let lines = 0;
	let cursor = 0;
	while (true) {
		const next = content.indexOf("\n", cursor);
		if (next === -1) return content.endsWith("\n") ? lines : lines + 1;
		lines += 1;
		cursor = next + 1;
		if (cursor >= content.length) return lines;
	}
}

/**
 * span（old 坐标）→ 展示窗口：old 侧扩到行边界 + context，重叠的合并；
 * new 侧的边界由 span 增量**映射**得到，而不是独立扩展 —— 窗口首尾都是未改动
 * 文本，映射保证两侧 context 行一一对应（独立扩展会在纯删除时多出一行，
 * 被内层 diff 误当成新增）。
 */
function buildWindows(
	oldContent: string,
	spans: readonly MatchedEditSpan[],
	contextLines: number,
): DiffWindow[] {
	const windows: DiffWindow[] = [];
	let delta = 0;
	for (const span of spans) {
		const oldStart = span.matchIndex;
		const oldEnd = span.matchIndex + span.matchLength;
		const deltaBefore = delta;
		delta += span.newText.length - span.matchLength;

		const windowOldStart = lineStartBack(oldContent, oldStart, contextLines);
		const windowOldEnd = lineEndForward(oldContent, Math.max(oldStart, oldEnd - 1), contextLines);

		const previous = windows.at(-1);
		if (previous !== undefined && windowOldStart <= previous.oldEnd) {
			// 窗口重叠/相接：合并，避免相邻改动被切成两块（与整文件 diff 的
			// hunk 合并行为一致）。
			previous.oldEnd = Math.max(previous.oldEnd, windowOldEnd);
			previous.newEnd = previous.oldEnd + delta;
			previous.spans.push({ matchIndex: oldStart, matchLength: span.matchLength, newText: span.newText });
			continue;
		}
		windows.push({
			oldStart: windowOldStart,
			oldEnd: windowOldEnd,
			// 窗口头部在本窗口第一个 span 之前 → 用 span 之前的增量；
			// 尾部在最后一个 span 之后 → 用包含该 span 的增量。
			newStart: windowOldStart + deltaBefore,
			newEnd: windowOldEnd + delta,
			spans: [{ matchIndex: oldStart, matchLength: span.matchLength, newText: span.newText }],
		});
	}
	return windows;
}

/** 窗口内被 span 完整覆盖（无未改动字节）→ 可证明的重写，走 O(N) path。 */
function windowIsWholeRewrite(window: DiffWindow): boolean {
	let cursor = window.oldStart;
	for (const span of window.spans) {
		if (span.matchIndex > cursor) return false;
		cursor = Math.max(cursor, span.matchIndex + span.matchLength);
	}
	return cursor >= window.oldEnd;
}

/** 把窗口内 diff 的行号平移到真实文件行号。 */
function shiftRow(row: DisplayDiffRow, oldOffset: number, newOffset: number): DisplayDiffRow {
	switch (row.kind) {
		case "context":
			return { ...row, oldLine: row.oldLine + oldOffset, newLine: row.newLine + newOffset };
		case "remove":
			return { ...row, oldLine: row.oldLine + oldOffset };
		case "add":
			return { ...row, newLine: row.newLine + newOffset };
		default:
			return row;
	}
}

/**
 * 折叠行是「相邻两条展示行之间省略了多少行」的唯一表述：连续 fold 必须合并。
 * 窗口内层 diff 也可能自己折叠（oldText/newText 共享首行时，对齐后的改动比
 * span 起点更靠后），与外层的窗口间隔相接时要并成一条。
 */
function pushRow(rows: DisplayDiffRow[], row: DisplayDiffRow): void {
	const previous = rows.at(-1);
	if (row.kind === "fold" && previous?.kind === "fold") {
		previous.omittedLines += row.omittedLines;
		return;
	}
	if (row.kind === "fold" && row.omittedLines <= 0) return;
	rows.push(row);
}

function appendFold(rows: DisplayDiffRow[], omittedLines: number): void {
	if (omittedLines > 0) pushRow(rows, { kind: "fold", omittedLines });
}

/**
 * 已知替换区间 → 展示 diff。
 *
 * @param spans 必须按 matchIndex 升序、互不重叠（engine 的落盘前提）。
 */
export function diffFromSpans(
	oldContent: string,
	newContent: string,
	spans: readonly MatchedEditSpan[],
	contextLines: number,
): FinalDiff {
	if (spans.length === 0 || oldContent === newContent) {
		return {
			display: { lineNumberWidth: 1, rows: [] },
			truncated: false,
			stats: { additions: 0, deletions: 0, changedLines: 0 },
			degraded: false,
		};
	}

	const windows = buildWindows(oldContent, spans, contextLines);
	const oldLineAt = lineCounter(oldContent);
	const newLineAt = lineCounter(newContent);

	const rows: DisplayDiffRow[] = [];
	const stats: ChangeStats = { additions: 0, deletions: 0, changedLines: 0 };
	let firstChangedLine: number | undefined;
	let degraded = false;
	let previousOldEndLine = 0;

	for (const window of windows) {
		const oldSlice = oldContent.slice(window.oldStart, window.oldEnd);
		const newSlice = newContent.slice(window.newStart, window.newEnd);
		const oldStartLine = oldLineAt(window.oldStart);
		const newStartLine = newLineAt(window.newStart);

		// 窗口之间（以及首个窗口之前）未展示的行数：两侧相同文本，行数必然相等。
		appendFold(rows, oldStartLine - previousOldEndLine - 1);

		const windowDiff = windowIsWholeRewrite(window)
			? generateRewriteDiff(oldSlice, newSlice)
			: generateFinalDiff(oldSlice, newSlice, contextLines);
		for (const row of windowDiff.display.rows) {
			pushRow(rows, shiftRow(row, oldStartLine - 1, newStartLine - 1));
		}
		if (firstChangedLine === undefined && windowDiff.firstChangedLine !== undefined) {
			firstChangedLine = windowDiff.firstChangedLine + newStartLine - 1;
		}
		stats.additions += windowDiff.stats.additions;
		stats.deletions += windowDiff.stats.deletions;
		stats.changedLines += windowDiff.stats.changedLines;
		degraded = degraded || windowDiff.degraded;
		previousOldEndLine = oldStartLine + countLines(oldSlice) - 1;
	}

	const oldLineCount = countLines(oldContent);
	const newLineCount = countLines(newContent);
	appendFold(rows, oldLineCount - previousOldEndLine);

	const output = truncateDisplay({
		lineNumberWidth: String(Math.max(1, oldLineCount, newLineCount)).length,
		rows,
	});
	return {
		display: output.display,
		...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
		truncated: output.truncated,
		stats,
		degraded,
	};
}
