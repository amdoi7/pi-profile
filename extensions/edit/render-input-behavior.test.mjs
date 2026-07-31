import test from "node:test";
import assert from "node:assert/strict";

import { buildCallToolViewModel, parseEditRequest } from "./pipeline.ts";

function makeEditArgs(files) {
	return { files };
}

function makeFile(path, edits) {
	return { path, edits };
}

function makeEdit(oldText, newText) {
	return { oldText, newText };
}

test("parseEditRequest returns a ready request for valid grouped edits", () => {
	const resolution = parseEditRequest(makeEditArgs([
		makeFile("a.ts", [
			makeEdit("foo", "alpha"),
			makeEdit("bar", "beta"),
		]),
		makeFile("b.ts", [makeEdit("one", "uno")]),
	]));

	assert.equal(resolution.files.length, 2);
	assert.equal(resolution.files[0]?.path, "a.ts");
	assert.equal(resolution.files[1]?.path, "b.ts");
});

test("parseEditRequest accepts { files: [...] } wrapper", () => {
	const resolution = parseEditRequest(makeEditArgs([
		makeFile("/tmp/demo.ts", [makeEdit("before", "after")]),
	]));

	assert.equal(resolution.files.length, 1);
	assert.equal(resolution.files[0]?.path, "/tmp/demo.ts");
	assert.deepEqual(resolution.files[0]?.edits, [makeEdit("before", "after")]);
});

test("parseEditRequest accepts positive expectedOccurrences", () => {
	const resolution = parseEditRequest(makeEditArgs([
		makeFile("/tmp/demo.ts", [{ oldText: "before", newText: "after", expectedOccurrences: 2 }]),
	]));

	assert.equal(resolution.files[0]?.edits[0]?.expectedOccurrences, 2);
});

test("parseEditRequest rejects non-positive expectedOccurrences", () => {
	assert.throws(() =>
		parseEditRequest(makeEditArgs([
			makeFile("/tmp/demo.ts", [{ oldText: "before", newText: "after", expectedOccurrences: 0 }]),
		])),
	/must be at least 1/,
	);
});

test("parseEditRequest rejects extra nested edit properties", () => {
	assert.throws(() =>
		parseEditRequest(makeEditArgs([
			{ path: "a.ts", edits: [{ oldText: "foo", newText: "bar", extra: true }] },
		])),
	/extra must be removed/,
	);
});

test("buildCallToolViewModel rejects malformed file entries with a concrete validation error", () => {
	const viewModel = buildCallToolViewModel(makeEditArgs([
		{ path: "a.ts", edits: [{ oldText: "foo" }] },
	]));

	assert.equal(viewModel.kind, "invalid");
	assert.match(viewModel.message, /files\[0\]\.edits\[0\]\.newText must be a string/);
});


test("buildCallToolViewModel preserves request paths without reading or canonicalizing files", () => {
	const viewModel = buildCallToolViewModel(makeEditArgs([
		{ path: "example.ts", edits: [{ oldText: "hello", newText: "hi" }] },
		{ path: "./nested/../example.ts", edits: [{ oldText: "hi", newText: "hey" }] },
	]));

	assert.equal(viewModel.kind, "call");
	assert.equal(viewModel.groups.length, 2);
	assert.equal(viewModel.groups[0]?.path, "example.ts");
	assert.equal(viewModel.groups[1]?.path, "./nested/../example.ts");
});
