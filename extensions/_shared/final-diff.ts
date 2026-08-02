import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { structuredPatch } from "diff";

export type ChangeStats = {
	additions: number;
	deletions: number;
	changedLines: number;
};

export type DisplayDiffRow =
	| { kind: "context"; oldLine: number; newLine: number; content: string }
	| { kind: "remove"; oldLine: number; content: string }
	| { kind: "add"; newLine: number; content: string }
	| { kind: "unlocated"; operation: "context" | "remove" | "add"; content: string }
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
	return Number.isInteger(additions) && additions >= 0 &&
		Number.isInteger(deletions) && deletions >= 0 &&
		Number.isInteger(changedLines) && changedLines === additions + deletions;
}

export function isDisplayDiff(value: unknown): value is DisplayDiff {
	if (!isRecord(value) || !isPositiveLineNumber(value.lineNumberWidth) || !Array.isArray(value.rows)) return false;
	return value.rows.every((row) => {
		if (!isRecord(row) || typeof row.kind !== "string") return false;
		if (row.kind === "context") {
			return isPositiveLineNumber(row.oldLine) && isPositiveLineNumber(row.newLine) && typeof row.content === "string";
		}
		if (row.kind === "remove") return isPositiveLineNumber(row.oldLine) && typeof row.content === "string";
		if (row.kind === "add") return isPositiveLineNumber(row.newLine) && typeof row.content === "string";
		if (row.kind === "unlocated") {
			return ["context", "remove", "add"].includes(String(row.operation)) && typeof row.content === "string";
		}
		if (row.kind === "fold") return isPositiveLineNumber(row.omittedLines);
		return row.kind === "annotation" && (row.side === "old" || row.side === "new") && typeof row.content === "string";
	});
}

const DEFAULT_CONTEXT_LINES = 4;

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
): { display: DisplayDiff; firstChangedLine?: number; stats: ChangeStats } {
	const patch = structuredPatch("before", "after", oldContent, newContent, undefined, undefined, {
		context: contextLines,
	});
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
				rows.push({ kind: "remove", oldLine, content });
				oldLine += 1;
				deletions += 1;
				previousChange = "old";
				continue;
			}
			if (prefix === "+") {
				firstChangedLine ??= newLine;
				rows.push({ kind: "add", newLine, content });
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

	return {
		display: {
			lineNumberWidth: String(Math.max(1, oldLineCount, newLineCount)).length,
			rows,
		},
		firstChangedLine,
		stats: { additions, deletions, changedLines: additions + deletions },
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
	return {
		lineNumberWidth: 1,
		rows: lines.map((line) => ({
			kind: "unlocated",
			operation: line.prefix === "+" ? "add" : line.prefix === "-" ? "remove" : "context",
			content: line.text,
		})),
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

export function generateFinalDiff(
	oldContent: string,
	newContent: string,
	contextLines = DEFAULT_CONTEXT_LINES,
): FinalDiff {
	if (!Number.isInteger(contextLines) || contextLines < 0) {
		throw new Error(`diff_context_invalid current=${contextLines} expected="non-negative integer" action="pass a valid context line count"`);
	}
	const generated = buildDisplayDiff(oldContent, newContent, contextLines);
	const output = truncateDisplay(generated.display);
	return {
		display: output.display,
		firstChangedLine: generated.firstChangedLine,
		truncated: output.truncated,
		stats: generated.stats,
	};
}
