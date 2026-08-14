import {
	Container,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

import type { DisplayDiff, DisplayDiffRow, FinalDiff } from "./final-diff.ts";

type DiffColor = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "muted" | "warning";

type DiffTheme = {
	fg: (color: DiffColor, text: string) => string;
	inverse: (text: string) => string;
};

export type DiffPreview = Pick<FinalDiff, "display" | "truncated">;

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightedContent(row: DisplayDiffRow, theme: DiffTheme): string {
	if (row.kind !== "remove" && row.kind !== "add" && row.kind !== "unlocated") return rowContent(row);
	let rendered = "";
	let cursor = 0;
	for (const range of row.highlights) {
		rendered += replaceTabs(row.content.slice(cursor, range.start));
		rendered += theme.inverse(replaceTabs(row.content.slice(range.start, range.end)));
		cursor = range.end;
	}
	return rendered + replaceTabs(row.content.slice(cursor));
}

function operationPrefix(row: DisplayDiffRow): " " | "+" | "-" {
	if (row.kind === "unlocated") {
		return row.operation === "add" ? "+" : row.operation === "remove" ? "-" : " ";
	}
	if (row.kind === "add") return "+";
	if (row.kind === "remove") return "-";
	return " ";
}

function numberCell(value: number | undefined, width: number): string {
	return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

function fullGutter(row: DisplayDiffRow, width: number, continuation: boolean): string {
	const prefix = continuation ? " " : operationPrefix(row);
	const oldLine = continuation || row.kind !== "context" && row.kind !== "remove"
		? undefined
		: row.oldLine;
	const newLine = continuation || row.kind !== "context" && row.kind !== "add"
		? undefined
		: row.newLine;
	return `${prefix}${numberCell(oldLine, width)} ${numberCell(newLine, width)} │ `;
}

function compactGutter(row: DisplayDiffRow, continuation: boolean): string {
	return `${continuation ? " " : operationPrefix(row)}│ `;
}

function rowContent(row: DisplayDiffRow): string {
	if (row.kind === "fold") {
		return `... ${row.omittedLines} unchanged ${row.omittedLines === 1 ? "line" : "lines"} omitted`;
	}
	if (row.kind === "annotation") return `\\ No newline at end of ${row.side} file`;
	return replaceTabs(row.content);
}

function rowColor(row: DisplayDiffRow): DiffColor {
	if (row.kind === "unlocated") {
		return row.operation === "add" ? "toolDiffAdded" : row.operation === "remove" ? "toolDiffRemoved" : "toolDiffContext";
	}
	if (row.kind === "add") return "toolDiffAdded";
	if (row.kind === "remove") return "toolDiffRemoved";
	if (row.kind === "fold" || row.kind === "annotation") return "muted";
	return "toolDiffContext";
}

export class DiffComponent implements Component {
	private readonly display: DisplayDiff;
	private readonly theme: DiffTheme;
	/** 段状态色条前缀（背景块）；内容行保持无背景以免淹没 diff 高亮。 */
	private readonly rail: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(display: DisplayDiff, theme: DiffTheme, rail = "") {
		this.display = display;
		this.theme = theme;
		this.rail = rail;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const availableWidth = Math.max(0, width);
		const lines: string[] = [];

		for (let index = 0; index < this.display.rows.length; index += 1) {
			const row = this.display.rows[index]!;
			const full = fullGutter(row, this.display.lineNumberWidth, false);
			const useCompactGutter = availableWidth <= visibleWidth(full);
			const firstGutter = useCompactGutter ? compactGutter(row, false) : full;
			const continuationGutter = useCompactGutter
				? compactGutter(row, true)
				: fullGutter(row, this.display.lineNumberWidth, true);
			const contentWidth = availableWidth - visibleWidth(firstGutter);
			if (contentWidth <= 0) {
				lines.push(truncateToWidth(firstGutter, width, ""));
				continue;
			}
			const content = highlightedContent(row, this.theme);
			const wrapped = wrapTextWithAnsi(content, contentWidth);
			for (let wrappedIndex = 0; wrappedIndex < wrapped.length; wrappedIndex += 1) {
				const gutter = wrappedIndex === 0 ? firstGutter : continuationGutter;
				const line = gutter + wrapped[wrappedIndex]!;
				lines.push(this.rail + this.theme.fg(rowColor(row), line));
			}
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export class DiffPreviewComponent implements Component {
	private readonly container = new Container();

	constructor(preview: DiffPreview, theme: DiffTheme, rail = "") {
		if (preview.display.rows.length > 0) {
			this.container.addChild(new DiffComponent(preview.display, theme, rail));
		}
		if (preview.truncated) {
			this.container.addChild(new Text(
				rail + theme.fg("warning", "... diff truncated at tool output limit"),
				0,
				0,
			));
		}
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
	}
}
