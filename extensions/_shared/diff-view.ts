import { diffWords } from "diff";
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

type RenderedContents = Map<number, string>;

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	theme: DiffTheme,
): { oldContent: string; newContent: string } {
	const parts = diffWords(oldContent, newContent);
	let renderedOld = "";
	let renderedNew = "";
	let firstRemoved = true;
	let firstAdded = true;

	for (const part of parts) {
		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const whitespace = value.match(/^\s*/)?.[0] ?? "";
				renderedOld += whitespace;
				value = value.slice(whitespace.length);
				firstRemoved = false;
			}
			if (value.length > 0) renderedOld += theme.inverse(value);
			continue;
		}
		if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const whitespace = value.match(/^\s*/)?.[0] ?? "";
				renderedNew += whitespace;
				value = value.slice(whitespace.length);
				firstAdded = false;
			}
			if (value.length > 0) renderedNew += theme.inverse(value);
			continue;
		}
		renderedOld += part.value;
		renderedNew += part.value;
	}

	return { oldContent: renderedOld, newContent: renderedNew };
}

function intraLineContents(display: DisplayDiff, theme: DiffTheme): RenderedContents {
	const rendered: RenderedContents = new Map();
	for (let index = 0; index < display.rows.length; index += 1) {
		if (display.rows[index]?.kind !== "remove") continue;
		let removedEnd = index;
		while (display.rows[removedEnd + 1]?.kind === "remove") removedEnd += 1;
		let addedEnd = removedEnd;
		while (display.rows[addedEnd + 1]?.kind === "add") addedEnd += 1;
		if (removedEnd !== index || addedEnd !== removedEnd + 1) {
			index = addedEnd;
			continue;
		}
		const removed = display.rows[index];
		const added = display.rows[addedEnd];
		if (removed?.kind !== "remove" || added?.kind !== "add") continue;
		const contents = renderIntraLineDiff(
			replaceTabs(removed.content),
			replaceTabs(added.content),
			theme,
		);
		rendered.set(index, contents.oldContent);
		rendered.set(addedEnd, contents.newContent);
		index = addedEnd;
	}
	return rendered;
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
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(display: DisplayDiff, theme: DiffTheme) {
		this.display = display;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const availableWidth = Math.max(0, width);
		const renderedContents = intraLineContents(this.display, this.theme);
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
			const content = renderedContents.get(index) ?? rowContent(row);
			const wrapped = wrapTextWithAnsi(content, contentWidth);
			for (let wrappedIndex = 0; wrappedIndex < wrapped.length; wrappedIndex += 1) {
				const gutter = wrappedIndex === 0 ? firstGutter : continuationGutter;
				const line = gutter + wrapped[wrappedIndex]!;
				lines.push(this.theme.fg(rowColor(row), line));
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

	constructor(preview: DiffPreview, theme: DiffTheme) {
		if (preview.display.rows.length > 0) {
			this.container.addChild(new DiffComponent(preview.display, theme));
		}
		if (preview.truncated) {
			this.container.addChild(new Text(
				theme.fg("warning", "... diff truncated at tool output limit"),
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
