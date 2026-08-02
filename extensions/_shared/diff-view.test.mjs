import test from "node:test";
import assert from "node:assert/strict";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DiffComponent, DiffPreviewComponent } from "./diff-view.ts";

initTheme("dark");

function createTheme() {
	return {
		fg: (_name, text) => text,
		inverse: (text) => text,
	};
}

const display = {
	lineNumberWidth: 3,
	rows: [
		{ kind: "context", oldLine: 171, newLine: 171, content: "before" },
		{ kind: "remove", oldLine: 172, content: "const value = someVeryLongIdentifier;" },
		{ kind: "add", newLine: 172, content: "const value = anotherVeryLongIdentifier;" },
		{ kind: "context", oldLine: 173, newLine: 181, content: "" },
		{ kind: "fold", omittedLines: 24 },
	],
};

test("shared preview component owns the truncation footer", () => {
	const lines = new DiffPreviewComponent(
		{ display: { lineNumberWidth: 1, rows: [] }, truncated: true },
		createTheme(),
	).render(80);

	const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.match(plain[0], /^\.\.\. diff truncated at tool output limit/);
});

test("Pi diff component renders dual gutters and visible source blank lines", () => {
	const lines = new DiffComponent(display, createTheme()).render(80);

	assert.equal(lines[0], " 171 171 │ before");
	assert.equal(lines[1], "-172     │ const value = someVeryLongIdentifier;");
	assert.equal(lines[2], "+    172 │ const value = anotherVeryLongIdentifier;");
	assert.equal(lines[3], " 173 181 │ ");
	assert.equal(lines[4], "         │ ... 24 unchanged lines omitted");
});

test("Pi diff component wraps content under an empty continuation gutter", () => {
	const width = 30;
	const lines = new DiffComponent(display, createTheme()).render(width);

	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	const removedIndex = lines.findIndex((line) => line.startsWith("-172"));
	assert.ok(removedIndex >= 0);
	assert.match(lines[removedIndex + 1], /^         │ /);
});

test("Pi diff component drops line numbers only when the full gutter cannot leave content width", () => {
	const width = 9;
	const lines = new DiffComponent(display, createTheme()).render(width);

	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	assert.match(lines[0], /^ │ /);
	assert.match(lines.find((line) => line.startsWith("-")), /^-│ /);
	assert.match(lines.find((line) => line.startsWith("+")), /^\+│ /);
});
