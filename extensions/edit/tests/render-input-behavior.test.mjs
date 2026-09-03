import { test } from "vitest";
import assert from "node:assert/strict";

import { parseEditRequest } from "../index.ts";
import { entryLabel } from "../ui.ts";

const makeEntry = (path, op) => ({ path, ...op });
const replace = (oldStr, newStr) => ({ op: "replace", old_str: oldStr, new_str: newStr });

test("parseEditRequest parses a write entry", () => {
	const request = parseEditRequest({
		note: "why",
		edits: [{ path: "new.py", op: "write", file_text: "x = 1\n" }],
	});
	assert.deepEqual(request.edits[0], {
		path: "new.py",
		op: "write",
		file_text: "x = 1\n",
	});
});

// 共享参数集：create 只要 file_text；别的参数（含非 null）原样保留、执行层不读。
test("create requires file_text and leaves other parameters inert", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [{ path: "a.py", op: "create" }] }),
		/edits\[0\]\.file_text must be a string, got undefined/,
	);
	const request = parseEditRequest({
		note: "why",
		edits: [{ path: "a.py", op: "create", file_text: "x", old_str: "y", new_str: null }],
	});
	assert.equal(request.edits[0].file_text, "x");
	assert.equal(request.edits[0].old_str, "y"); // 惰性参数保留
	assert.equal("new_str" in request.edits[0], false); // null 视为省略
});

test("parseEditRequest returns the entry sequence", () => {
	const request = parseEditRequest({
		note: "why", edits: [
			makeEntry("a.ts", replace("foo", "alpha")),
			makeEntry("b.ts", { op: "insert", insert_line: 2, new_str: "gamma" }),
		],
	});

	assert.equal(request.edits.length, 2);
	assert.deepEqual(request.edits[0], { path: "a.ts", op: "replace", old_str: "foo", new_str: "alpha" });
	assert.deepEqual(request.edits[1], { path: "b.ts", op: "insert", insert_line: 2, new_str: "gamma" });
});

test("parseEditRequest rejects an unknown op", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [makeEntry("a.ts", { op: "move", old_str: "x", new_str: "y" })] }),
		/edits\[0\]\.op must be one of replace \| replaceAll \| insert \| delete/,
	);
});

test("parseEditRequest requires the fields each op needs", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [makeEntry("a.ts", { op: "replace", old_str: "x" })] }),
		/edits\[0\]\.new_str must be a string, got undefined/,
	);
	// delete 只要 old_str：new_str 惰性在场不报错。
	assert.deepEqual(
		parseEditRequest({ note: "why", edits: [makeEntry("a.ts", { op: "delete", old_str: "x", new_str: "y" })] }).edits[0],
		{ path: "a.ts", op: "delete", old_str: "x", new_str: "y" },
	);
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [makeEntry("a.ts", { op: "insert", insert_line: "x", new_str: "y" })] }),
		/edits\[0\]\.insert_line must be an integer, got string/,
	);
});

test("parseEditRequest rejects an empty sequence", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [] }),
		/edits must not be empty/,
	);
});

test("parseEditRequest rejects extra top-level properties", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", surprise: 1, edits: [makeEntry("a.ts", replace("foo", "alpha"))] }),
		/surprise must be removed/,
	);
});

test("note is required: the script needs its why", () => {
	assert.throws(
		() => parseEditRequest({ edits: [makeEntry("a.ts", replace("foo", "alpha"))] }),
		/note is required: one line naming why this change exists/,
	);
});

test("a per-entry note rides on the entry", () => {
	const request = parseEditRequest({
		note: "why",
		edits: [makeEntry("a.ts", { ...replace("foo", "alpha"), note: "aligns the call site" })],
	});
	assert.equal(request.edits[0].note, "aligns the call site");
});

// 旧形状零向后兼容：主形状校验直接响亮拒绝，不抬升不猜。
test("the legacy flat { path, oldText, newText } shape is rejected", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", path: "a.ts", oldText: "a", newText: "b" }),
		/path must be removed/,
	);
});

test("a missing field is reported with its field path", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [makeEntry("a.ts", { op: "replace", new_str: "foo" })] }),
		/edits\[0\]\.old_str must be a string, got undefined/,
	);
});

test("a wrong-typed field names the type that arrived", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [makeEntry("a.ts", { op: "replace", old_str: 7, new_str: "foo" })] }),
		/old_str must be a string, got number/,
	);
	assert.throws(
		() => parseEditRequest({ note: "why", edits: [makeEntry(3, replace("foo", "bar"))] }),
		/edits\[0\]\.path must be a string, got number/,
	);
});

// 渲染面不读盘、不解析路径：模型写的 path 原样带到展示。
test("a request path is kept verbatim, without reading or canonicalizing files", () => {
	const request = parseEditRequest({
		note: "why", edits: [makeEntry("./nested/../example.ts", replace("hello", "hi"))],
	});

	assert.deepEqual(request.edits, [{ path: "./nested/../example.ts", op: "replace", old_str: "hello", new_str: "hi" }]);
});

test("entry summaries name the op for the UI rail", () => {
	const request = parseEditRequest({
		note: "why", edits: [
			makeEntry("a.ts", { op: "insert", insert_line: 1, new_str: "y\n" }),
			makeEntry("b.ts", { op: "delete", old_str: "z" }),
		],
	});

	assert.equal(entryLabel(request.edits[0]), 'insert after line 1 "y\n"');
	assert.equal(entryLabel(request.edits[1]), 'delete "z"');
});
