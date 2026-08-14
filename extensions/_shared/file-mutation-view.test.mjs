import { test } from "vitest";
import assert from "node:assert/strict";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import {
	appendFileMutationBatch,
	beginFileMutationResultRender,
	beginPendingFileMutationRender,
} from "./file-mutation-view.ts";

initTheme("dark");

function createTheme() {
	return {
		fg: (_name, text) => text,
		inverse: (text) => `<inv>${text}</inv>`,
	};
}

function renderLines(component) {
	return component.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

test("a one-item edit is rendered through the batch contract without a title gap", () => {
	const container = new Container();
	appendFileMutationBatch(container, [{
		title: "edit file src/a.ts",
		outcome: "applied",
		previews: [{
			display: {
				lineNumberWidth: 1,
				rows: [
					{ kind: "remove", oldLine: 1, content: "before", highlights: [{ start: 0, end: 6 }] },
					{ kind: "add", newLine: 1, content: "after", highlights: [{ start: 0, end: 5 }] },
				],
			},
			truncated: false,
		}],
	}], createTheme());

	assert.deepEqual(renderLines(container), [
		"edit file src/a.ts",
		"-1   │ <inv>before</inv>",
		"+  1 │ <inv>after</inv>",
	]);
});

test("independent previews cannot form an intra-line pair across patch boundaries", () => {
	const container = new Container();
	appendFileMutationBatch(container, [{
		title: "apply_patch Update file src/a.ts",
		outcome: "applied",
		previews: [
			{
				display: { lineNumberWidth: 1, rows: [{ kind: "remove", oldLine: 1, content: "removed", highlights: [] }] },
				truncated: false,
			},
			{
				display: { lineNumberWidth: 1, rows: [{ kind: "add", newLine: 1, content: "added", highlights: [] }] },
				truncated: false,
			},
		],
	}], createTheme());

	const output = renderLines(container).join("\n");
	assert.doesNotMatch(output, /<inv>/);
	assert.match(output, /-1   │ removed/);
	assert.match(output, /\+  1 │ added/);
});

test("result rendering clears pending content and reuses the result slot", () => {
	const state = {};
	const pending = beginPendingFileMutationRender({ state });
	pending.addChild(new Text("pending", 0, 0));
	const previousResult = new Container();
	previousResult.addChild(new Text("stale", 0, 0));

	const result = beginFileMutationResultRender({ state, lastComponent: previousResult });

	assert.deepEqual(renderLines(pending), []);
	assert.equal(result, previousResult);
	assert.deepEqual(renderLines(result), []);
});
