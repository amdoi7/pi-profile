import test from "node:test";
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

test("parseEditRequest rejects removed expectedOccurrences", () => {
	assert.throws(() =>
		parseEditRequest(makeArgs("/tmp/demo.ts", [
			{ oldText: "before", newText: "after", expectedOccurrences: 2 },
		])),
	/expectedOccurrences must be removed/,
	);
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

test("parseEditRequest rejects extra edit properties", () => {
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

test("parseEditRequest unwraps a legacy single-file { files: [...] } wrapper", () => {
	const resolution = parseEditRequest({ files: [{ path: "a.ts", edits: [makeEdit("foo", "alpha")] }] });

	assert.equal(resolution.path, "a.ts");
	assert.deepEqual(resolution.edits, [makeEdit("foo", "alpha")]);
});

test("parseEditRequest rejects legacy multi-file wrappers with a migration error", () => {
	assert.throws(() =>
		parseEditRequest({
			files: [
				{ path: "a.ts", edits: [makeEdit("foo", "alpha")] },
				{ path: "b.ts", edits: [makeEdit("one", "uno")] },
			],
		}),
	/one call per file/,
	);
});

test("buildCallToolViewModel rejects malformed edit entries with a concrete validation error", () => {
	const viewModel = buildCallToolViewModel(makeArgs("a.ts", [{ oldText: "foo" }]));

	assert.equal(viewModel.kind, "invalid");
	assert.match(viewModel.message, /edits\[0\]\.newText must be a string/);
});

test("buildCallToolViewModel preserves the request path without reading or canonicalizing files", () => {
	const viewModel = buildCallToolViewModel(makeArgs("./nested/../example.ts", [
		{ oldText: "hello", newText: "hi" },
	]));

	assert.equal(viewModel.kind, "call");
	assert.equal(viewModel.path, "./nested/../example.ts");
});
