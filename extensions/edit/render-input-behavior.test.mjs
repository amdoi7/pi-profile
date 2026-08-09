import { test } from "vitest";
import assert from "node:assert/strict";

import { buildCallToolViewModel, parseEditRequest } from "./pipeline.ts";

function makeArgs(path, edits) {
	return { path, edits };
}

function makeEdit(oldText, newText) {
	return { oldText, newText };
}

test("parseEditRequest returns a ready request for a valid single-file edit", () => {
	const resolution = parseEditRequest(makeArgs("a.ts", [
		makeEdit("foo", "alpha"),
		makeEdit("bar", "beta"),
	]));

	assert.equal(resolution.path, "a.ts");
	assert.equal(resolution.edits.length, 2);
});

test("parseEditRequest accepts replaceAll", () => {
	const resolution = parseEditRequest(makeArgs("/tmp/demo.ts", [
		{ oldText: "before", newText: "after", replaceAll: true },
	]));

	assert.equal(resolution.edits[0]?.replaceAll, true);
});

test("parseEditRequest drops legacy expectedOccurrences", () => {
	const resolution = parseEditRequest(makeArgs("/tmp/demo.ts", [
		{ oldText: "before", newText: "after", expectedOccurrences: 2 },
	]));

	assert.equal(resolution.edits.length, 1);
	assert.deepEqual(resolution.edits[0], { oldText: "before", newText: "after" });
});

test("parseEditRequest rejects non-boolean replaceAll", () => {
	assert.throws(() =>
		parseEditRequest(makeArgs("/tmp/demo.ts", [
			{ oldText: "before", newText: "after", replaceAll: "yes" },
		])),
	/replaceAll must be boolean/,
	);
});

test("parseEditRequest parses edits given as a JSON string", () => {
	const resolution = parseEditRequest(makeArgs("a.ts", JSON.stringify([makeEdit("foo", "alpha")])));

	assert.equal(resolution.edits.length, 1);
	assert.deepEqual(resolution.edits, [makeEdit("foo", "alpha")]);
});

test("parseEditRequest still rejects malformed JSON string edits", () => {
	assert.throws(() =>
		parseEditRequest(makeArgs("a.ts", "not-json")),
	/edits must be an array/,
	);
});

test("parseEditRequest merges the flat legacy { path, oldText, newText } shape", () => {
	const resolution = parseEditRequest({
		path: "a.ts",
		oldText: "foo",
		newText: "alpha",
	});

	assert.equal(resolution.path, "a.ts");
	assert.deepEqual(resolution.edits, [{ oldText: "foo", newText: "alpha" }]);
});

test("parseEditRequest keeps a flat legacy replaceAll on the merged edit", () => {
	const resolution = parseEditRequest({
		path: "a.ts",
		oldText: "foo",
		newText: "alpha",
		replaceAll: true,
	});

	assert.deepEqual(resolution.edits, [{ oldText: "foo", newText: "alpha", replaceAll: true }]);
});

test("parseEditRequest appends flat legacy edits after explicit edits", () => {
	const resolution = parseEditRequest({
		path: "a.ts",
		edits: [{ oldText: "foo", newText: "alpha" }],
		oldText: "bar",
		newText: "beta",
	});

	assert.equal(resolution.edits.length, 2);
	assert.deepEqual(resolution.edits[1], { oldText: "bar", newText: "beta" });
});

test("parseEditRequest merges numbered legacy pairs at top level", () => {
	const resolution = parseEditRequest({
		path: "a.ts",
		edits: [{ oldText: "foo", newText: "alpha" }],
		oldText2: "bar",
		newText2: "beta",
	});

	assert.equal(resolution.edits.length, 2);
	assert.deepEqual(resolution.edits[1], { oldText: "bar", newText: "beta" });
});

test("parseEditRequest moves numbered legacy pairs nested in an edit to the tail", () => {
	const resolution = parseEditRequest(makeArgs("a.ts", [
		{ oldText: "foo", newText: "alpha", oldText2: "bar", newText2: "beta" },
	]));

	assert.equal(resolution.edits.length, 2);
	assert.deepEqual(resolution.edits[0], { oldText: "foo", newText: "alpha" });
	assert.deepEqual(resolution.edits[1], { oldText: "bar", newText: "beta" });
});

test("parseEditRequest rejects unpaired legacy numbered keys", () => {
	assert.throws(() =>
		parseEditRequest(makeArgs("a.ts", [
			{ oldText: "foo", newText: "alpha", oldText2: 42 },
		])),
	/oldText2/,
	);
});

test("parseEditRequest rejects unknown edit properties", () => {
	assert.throws(() =>
		parseEditRequest(makeArgs("a.ts", [{ oldText: "foo", newText: "bar", extra: true }])),
	/extra must be removed/,
	);
});

test("parseEditRequest rejects extra top-level properties", () => {
	assert.throws(() =>
		parseEditRequest({ path: "a.ts", edits: [makeEdit("foo", "alpha")], surprise: 1 }),
	/surprise must be removed/,
	);
});

test("buildCallToolViewModel reports a missing oldText", () => {
	const viewModel = buildCallToolViewModel(makeArgs("a.ts", [{ newText: "foo" }]));

	assert.equal(viewModel.kind, "invalid");
	assert.match(viewModel.message, /edits\[0\]\.oldText must be a string/);
});

test("buildCallToolViewModel rejects a missing path", () => {
	const viewModel = buildCallToolViewModel({ edits: [{ oldText: "foo", newText: "bar" }] });

	assert.equal(viewModel.kind, "invalid");
	assert.match(viewModel.message, /path must be a string/);
});

test("buildCallToolViewModel preserves the request path without reading or canonicalizing files", () => {
	const viewModel = buildCallToolViewModel(makeArgs("./nested/../example.ts", [
		{ oldText: "hello", newText: "hi" },
	]));

	assert.equal(viewModel.kind, "call");
	assert.equal(viewModel.path, "./nested/../example.ts");
});
