import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

import { BTW_OVERLAY_MAX_HEIGHT_PERCENT, BtwOverlay } from "./overlay.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
// Bare PageUp/PageDown are swallowed by the alt-screen viewport listener before the
// overlay sees them; ctrl+PageUp/ctrl+PageDown are the page keys that arrive.
const CTRL_PAGE_UP = "\x1b[5;5~";
const CTRL_PAGE_DOWN = "\x1b[6;5~";

const originalRows = process.stdout.rows;

afterEach(() => {
	Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
});

function setTerminalRows(rows) {
	Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
}

function heightBudget(rows) {
	return Math.min(Math.floor((rows * BTW_OVERLAY_MAX_HEIGHT_PERCENT) / 100), rows - 1);
}

function themeStub() {
	const theme = {};
	theme.fg = (color, text) => String(text);
	theme.bold = (text) => String(text);
	return theme;
}

function makeOverlay(transcriptLines) {
	const tui = {
		requestRender: () => {},
		requestImmediateRender: () => {},
	};
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	const submitted = [];
	let dismissed = 0;
	const overlay = new BtwOverlay(
		tui,
		themeStub(),
		keybindings,
		() => transcriptLines,
		() => "status",
		(value) => submitted.push(value),
		() => dismissed++,
	);
	overlay.focused = true;
	overlay.setDraft("hello draft");
	return { overlay, getSubmitted: () => submitted, getDismissed: () => dismissed };
}

test("scroll: transcript longer than viewport scrolls with up arrow", () => {
	const transcript = Array.from({ length: 50 }, (_, i) => `line ${i}`);
	const { overlay } = makeOverlay(transcript);
	const first = overlay.render(100);
	// Bottom-aligned at first: last lines visible.
	assert.ok(first.some((l) => l.includes("line 49")));
	assert.ok(!first.some((l) => l.includes("line 0")));

	// Arrow up (legacy CSI-A) should scroll up by one.
	overlay.handleInput(UP);
	const second = overlay.render(100);
	assert.ok(second.some((l) => l.includes("↑ 1")), "status should show scroll offset 1");
	assert.ok(second.some((l) => l.includes("line 48")), "should still show line 48");
});

test("scroll: down arrow after scrolling up restores bottom", () => {
	const transcript = Array.from({ length: 50 }, (_, i) => `line ${i}`);
	const { overlay } = makeOverlay(transcript);
	overlay.render(100);
	overlay.handleInput(UP);
	overlay.handleInput(UP);
	overlay.handleInput(DOWN);
	const lines = overlay.render(100);
	assert.ok(lines.some((l) => l.includes("↑ 1")), "offset should be 1 after up,up,down");
});

test("scroll: ctrl+PageUp/ctrl+PageDown move a full viewport", () => {
	setTerminalRows(40);
	const transcript = Array.from({ length: 200 }, (_, i) => `line ${i}`);
	const { overlay } = makeOverlay(transcript);
	const first = overlay.render(100);
	const viewport = first.filter((l) => l.includes("line ")).length;
	assert.ok(viewport > 1, "viewport should hold several transcript lines");

	overlay.handleInput(CTRL_PAGE_UP);
	const paged = overlay.render(100);
	assert.ok(paged.some((l) => l.includes(`↑ ${viewport} `)), `offset should be ${viewport} after a page up`);

	overlay.handleInput(CTRL_PAGE_DOWN);
	const back = overlay.render(100);
	assert.ok(!back.some((l) => l.includes("↑ ")), "page down should return to the bottom");
});

test("scroll keys fall through to the input when there is nothing to scroll", () => {
	const { overlay, getSubmitted } = makeOverlay(["line 0"]);
	overlay.render(100);
	// Up/down are not swallowed as scroll here, and must not disturb the draft.
	overlay.handleInput(UP);
	overlay.handleInput(CTRL_PAGE_UP);
	assert.equal(overlay.getDraft(), "hello draft");
	overlay.handleInput("\r");
	assert.deepEqual(getSubmitted(), ["hello draft"]);
});

test("submit: enter calls onSubmit with draft value", () => {
	const { overlay, getSubmitted } = makeOverlay(["line 0"]);
	overlay.render(100);
	overlay.handleInput("\r");
	assert.deepEqual(getSubmitted(), ["hello draft"]);
});

test("setDraft('') clears the input value", () => {
	const { overlay, getSubmitted } = makeOverlay(["line 0"]);
	overlay.render(100);
	overlay.setDraft("");
	assert.equal(overlay.getDraft(), "");
	overlay.handleInput("\r");
	assert.deepEqual(getSubmitted(), [""]);
});

test("escape dismisses the overlay", () => {
	const { overlay, getDismissed } = makeOverlay(["line 0"]);
	overlay.render(100);
	overlay.handleInput("\x1b");
	assert.equal(getDismissed(), 1);
});

// Regression: the dialog used to be sized with a chrome count of 7 instead of 9, so on
// short terminals the TUI clipped the bottom lines — the input line and the footer hint.
test("dialog never renders taller than the overlay height budget", () => {
	const transcript = Array.from({ length: 200 }, (_, i) => `line ${i}`);
	for (const rows of [16, 20, 24, 30, 40, 60, 120]) {
		setTerminalRows(rows);
		const { overlay } = makeOverlay(transcript);
		const lines = overlay.render(100);
		assert.ok(
			lines.length <= heightBudget(rows),
			`rows=${rows}: rendered ${lines.length} lines, budget ${heightBudget(rows)}`,
		);
		// The input line and the footer hint must survive.
		assert.ok(lines.some((l) => l.includes("Enter submit")), `rows=${rows}: footer hint missing`);
	}
});

test("declared overlay width is used in full", () => {
	setTerminalRows(40);
	const { overlay } = makeOverlay(["line 0"]);
	const lines = overlay.render(100);
	for (const line of lines) {
		assert.equal(visibleWidth(line), 100, "every rendered line should fill the declared width");
	}
});
