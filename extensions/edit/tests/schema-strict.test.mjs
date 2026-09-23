import { test } from "vitest";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";

import { editRequestParameters, parseEditRequest } from "../index.ts";

const validator = Compile(editRequestParameters);

// 新契约：一次调用 = 一个文件。note = 批次唯一意图；path = 唯一目标文件；
// edits = 该文件的条目链（顺序执行）。
const call = {
	note: "重命名结算域字段",
	path: "a.py",
	edits: [
		{ match: "amountOwed", new_str: "amountDue" },
		{ match: "# old header", new_str: "# generated" },
		{ match: "dead_code()" },
	],
};

test("the published schema accepts the documented call", () => {
	const errors = [...validator.Errors(call)].map((e) => `${e.instancePath}: ${e.message}`);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("parseEditRequest keeps the flat edits chain (input == internal shape)", () => {
	const request = parseEditRequest(call);
	assert.equal(request.note, call.note);
	assert.equal(request.path, call.path);
	assert.deepEqual(request.edits, call.edits);
});

test("the executor consumes the validated shape (note + path + ordered edits)", () => {
	const request = parseEditRequest(call);
	assert.deepEqual(Object.keys(request).sort(), ["edits", "note", "path"]);
	assert.equal(request.edits.length, 3);
	assert.ok(request.edits.every((e) => typeof e.match === "string"));
});

test("entries carry no op field and no path; schema stays anyOf/const-free", () => {
	// 扁平数组：条目容器就是 properties.edits.items；path 只在顶层。
	const entry = editRequestParameters.properties.edits.items;
	assert.ok(!("op" in entry.properties), "op field must be gone");
	assert.ok(!("path" in entry.properties), "path belongs at the top level");
	const json = JSON.stringify(editRequestParameters);
	assert.ok(!json.includes("anyOf") && !json.includes("const"), "schema must not use anyOf/const");
});

// 严格模式：未声明字段一律拒绝，必须即时报错。
test("rejects an undeclared parameter", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ match: "x", new_str: "y", stray: 1 }] };
	assert.throws(() => parseEditRequest(bogus), /edits\[0\]\.stray must be removed/);
});

test("null new_str means delete, not an error (provider null-is-omit)", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ match: "x", new_str: null }] };
	const parsed = parseEditRequest(bogus);
	assert.equal(parsed.edits[0].new_str, undefined, "null normalizes to absent = delete");
});

// 顶层严格：多余键、缺 note/path、空 edits 全部拒绝。
test("rejects a stray top-level key", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ match: "x" }], comment: "legacy" };
	assert.throws(() => parseEditRequest(bogus), /comment must be removed/);
});

test("rejects a legacy per-entry path (path is top-level only)", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ path: "a.py", match: "x" }] };
	assert.throws(() => parseEditRequest(bogus), /edits\[0\]\.path must be removed/);
});

test("rejects empty edits", () => {
	const bogus = { note: "why", path: "a.py", edits: [] };
	assert.throws(() => parseEditRequest(bogus), /edits must not be empty/);
});

test("rejects edits that is not an array", () => {
	const bogus = { note: "why", path: "a.py", edits: {} };
	assert.throws(() => parseEditRequest(bogus), /edits must be an array/);
});

test("rejects missing note", () => {
	const bogus = { path: "a.py", edits: [{ match: "x" }] };
	assert.throws(() => parseEditRequest(bogus), /note is required/);
});

test("rejects an empty note", () => {
	const bogus = { note: "", path: "a.py", edits: [{ match: "x" }] };
	assert.throws(() => parseEditRequest(bogus), /note is required/);
});

test("rejects missing path", () => {
	const bogus = { note: "why", edits: [{ match: "x" }] };
	assert.throws(() => parseEditRequest(bogus), /path is required/);
});

// match 是唯一必填条目字段（new_str 缺省 = 删除）。
test("rejects an entry missing match", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ new_str: "y" }] };
	assert.throws(() => parseEditRequest(bogus), /edits\[0\]\.match must be a string/);
});

test("rejects the removed op field", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ op: "str_replace", match: "x", new_str: "y" }] };
	assert.throws(() => parseEditRequest(bogus), /op must be removed/);
});

// 条目多余键（含构造器污染键）必须拒绝，不静默执行也不静默丢弃。
test("rejects a stray entry key", () => {
	const bogus = { note: "why", path: "a.py", edits: [{ match: "x", constructor: { match: "y" } }] };
	assert.throws(() => parseEditRequest(bogus), /edits\[0\]\.constructor must be removed/);
});
