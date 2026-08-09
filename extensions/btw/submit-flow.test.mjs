import { test } from "vitest";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

import { BtwOverlay } from "./overlay.ts";
import { TurnRunner } from "./turn-runner.ts";

/**
 * Wires the overlay to a TurnRunner the same way the extension does, to pin the
 * reported bug: the submitted question used to stay in the input box for the whole
 * response, because the draft was only cleared after `run()` resolved.
 */
function makeHarness({ prompt }) {
	const tui = { requestRender: () => {}, requestImmediateRender: () => {} };
	const theme = { fg: (_c, text) => String(text), bold: (text) => String(text) };
	const runner = new TurnRunner();
	const notices = [];
	const pending = [];

	const deps = {
		getModel: () => ({ provider: "test", id: "mock", api: "openai-responses" }),
		hasCredentials: () => true,
		ensureSideSession: async () => ({
			prompt,
			getLastAssistantMessage: () => ({
				content: [{ type: "text", text: "answer text" }],
				stopReason: "stop",
			}),
		}),
		getThinkingLevel: () => "off",
		setStatus: () => {},
		notify: (message, level) => notices.push({ message, level }),
		onAccepted: () => {
			overlay.setDraft("");
		},
		onTurnComplete: () => {},
	};

	const overlay = new BtwOverlay(
		tui,
		theme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		() => (runner.current ? [runner.current.question] : []),
		() => "status",
		(value) => {
			const question = value.trim();
			if (!question) return;
			pending.push(runner.run(question, deps));
		},
		() => {},
	);
	overlay.focused = true;

	return { overlay, runner, notices, getDraft: () => overlay.getDraft(), pending };
}

test("submitted question leaves the input immediately, not after the answer arrives", async () => {
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const harness = makeHarness({ prompt: async () => await promptGate });

	harness.overlay.setDraft("why is this slow?");
	harness.overlay.render(100);
	harness.overlay.handleInput("\r");

	// Still mid-turn: the box must already be empty.
	assert.equal(harness.runner.busy, true);
	assert.equal(harness.getDraft(), "");

	releasePrompt();
	await Promise.all(harness.pending);
	assert.equal(harness.getDraft(), "");
});

test("a submit rejected as busy keeps the draft for editing", async () => {
	let releasePrompt;
	const promptGate = new Promise((resolve) => {
		releasePrompt = resolve;
	});
	const harness = makeHarness({ prompt: async () => await promptGate });

	harness.overlay.setDraft("first");
	harness.overlay.render(100);
	harness.overlay.handleInput("\r");
	assert.equal(harness.getDraft(), "");

	// Type a second question while the first is in flight.
	harness.overlay.setDraft("second");
	harness.overlay.handleInput("\r");
	await Promise.resolve();
	assert.equal(harness.getDraft(), "second", "rejected submit must not lose the text");
	assert.ok(harness.notices.some((n) => n.message.includes("still processing")));

	releasePrompt();
	await Promise.all(harness.pending);
	assert.deepEqual(await Promise.all(harness.pending), [true, false]);
});
