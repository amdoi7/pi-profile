import { test } from "vitest";
import assert from "node:assert/strict";

import { parseEditRequest } from "../index.ts";
import { entryLabel } from "../ui.ts";

const replace = (oldStr, newStr) => ({ match: oldStr, new_str: newStr });

test("parseEditRequest parses a replace entry", () => {
	const request = parseEditRequest({
		note: "why",
		path: "a.py",
		edits: [{ match: "x", new_str: "y" }],
	});
	assert.deepEqual(request.edits[0], { match: "x", new_str: "y" });
});

test("parseEditRequest rejects the removed create and write ops", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", path: "new.py", edits: [{ op: "create", match: "x" }] }),
		/op must be removed/,
	);
	assert.throws(
		() => parseEditRequest({ note: "why", path: "new.py", edits: [{ op: "write", match: "x" }] }),
		/op must be removed/,
	);
});



test("parseEditRequest returns the entry sequence", () => {
	const request = parseEditRequest({
		note: "why",
		path: "a.ts",
		edits: [
			replace("foo", "alpha"),
			{ match: "beta" },
		],
	});
	assert.deepEqual(request.edits[0], { match: "foo", new_str: "alpha" });
	assert.deepEqual(request.edits[1], { match: "beta" });
});

test("parseEditRequest rejects an unknown field", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", path: "a.ts", edits: [{ op: "move", match: "x", new_str: "y" }] }),
		/op must be removed/,
	);
});

test("parseEditRequest requires match and validates new_str", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", path: "a.ts", edits: [{ new_str: "y" }] }),
		/edits\[0\]\.match must be a string/,
	);
	assert.throws(
		() => parseEditRequest({ note: "why", path: "a.ts", edits: [{ match: "x", new_str: 42 }] }),
		/edits\[0\]\.new_str must be a string/,
	);
});

test("parseEditRequest rejects an empty sequence", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", path: "a.ts", edits: [] }),
		/edits must not be empty/,
	);
});

test("parseEditRequest rejects extra top-level properties", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", path: "a.ts", surprise: 1, edits: [replace("foo", "alpha")] }),
		/surprise must be removed/,
	);
});

test("note is required: the script needs its why", () => {
	assert.throws(
		() => parseEditRequest({ path: "a.ts", edits: [replace("foo", "alpha")] }),
		/note is required: one line naming why this batch exists/,
	);
});

// entryLabel 仍是渲染的摘要函数：各 op 一行摘要。
test("entryLabel renders a one-line summary per op", () => {
	assert.equal(entryLabel({ match: "a", new_str: "b" }), "a → b");
	assert.equal(entryLabel({ match: "x" }), 'delete "x"');
	assert.equal(entryLabel({ match: "old", new_str: "new", replace_all: true }), "old → new [all]");
});
