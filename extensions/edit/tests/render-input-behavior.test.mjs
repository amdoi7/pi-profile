import { test } from "vitest";
import assert from "node:assert/strict";

import { parseEditRequest } from "../index.ts";
import { entryLabel } from "../ui.ts";

const file = (path, chain) => ({ [path]: chain });
const replace = (oldStr, newStr) => ({ match: oldStr, new_str: newStr });

test("parseEditRequest parses a replace entry", () => {
	const request = parseEditRequest({
		note: "why",
		files: file("a.py", [{ match: "x", new_str: "y" }]),
	});
	assert.deepEqual(request.edits[0], {
		path: "a.py",
		match: "x",
		new_str: "y",
	});
});

test("parseEditRequest rejects the removed create and write ops", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", files: file("new.py", [{ op: "create", match: "x" }]) }),
		/op must be removed/,
	);
	assert.throws(
		() => parseEditRequest({ note: "why", files: file("new.py", [{ op: "write", match: "x" }]) }),
		/op must be removed/,
	);
});



test("parseEditRequest returns the entry sequence", () => {
	const request = parseEditRequest({
		note: "why",
		files: {
			"a.ts": [replace("foo", "alpha")],
			"b.ts": [{ match: "beta" }],
		},
	});
	assert.deepEqual(request.edits[0], { path: "a.ts", match: "foo", new_str: "alpha" });
	assert.deepEqual(request.edits[1], { path: "b.ts", match: "beta" });
});

test("parseEditRequest rejects an unknown field", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", files: file("a.ts", [{ op: "move", match: "x", new_str: "y" }]) }),
		/op must be removed/,
	);
});

test("parseEditRequest requires match and validates new_str", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", files: file("a.ts", [{ new_str: "y" }]) }),
		/files\["a\.ts"\]\.match must be a string/,
	);
	assert.throws(
		() => parseEditRequest({ note: "why", files: file("a.ts", [{ match: "x", new_str: 42 }]) }),
		/files\["a\.ts"\]\.new_str must be a string/,
	);
});

test("parseEditRequest rejects an empty sequence", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", files: {} }),
		/files must not be empty/,
	);
});

test("parseEditRequest rejects extra top-level properties", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", surprise: 1, files: file("a.ts", [replace("foo", "alpha")]) }),
		/surprise must be removed/,
	);
});

test("note is required: the script needs its why", () => {
	assert.throws(
		() => parseEditRequest({ files: file("a.ts", [replace("foo", "alpha")]) }),
		/note is required: one line naming why this batch exists/,
	);
});

// entryLabel 仍是渲染的摘要函数：各 op 一行摘要。
test("entryLabel renders a one-line summary per op", () => {
	assert.equal(entryLabel({ match: "a", new_str: "b" }), "a → b");
	assert.equal(entryLabel({ match: "x" }), 'delete "x"');
});

test("entryLabel shows selectors: occurrence, limit, anchors, regex", () => {
	assert.equal(
		entryLabel({ match: "import", new_str: "IMPORT", occurrence: 2 }),
		"import → IMPORT [#2]",
	);
	assert.equal(
		entryLabel({ match: "x", new_str: "y", limit: 3 }),
		"x → y [≤3]",
	);
	assert.equal(
		entryLabel({ match: "foo", new_str: "bar", after: "class X" }),
		"foo → bar [after \"class X\"]",
	);
	assert.equal(
		entryLabel({ match: "x", before: "end", regex: true }),
		'delete "x" [before "end", regex]',
	);
});
