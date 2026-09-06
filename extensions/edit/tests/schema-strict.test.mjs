import { test } from "vitest";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";

import { editRequestParameters, parseEditRequest } from "../index.ts";

const validator = Compile(editRequestParameters);

// 新契约：note = 批次唯一意图；files[path] = 该文件的 op 链（顺序执行）。
const call = {
	note: "重命名结算域字段",
	files: {
		"a.py": [
			{ match: "amountOwed", new_str: "amountDue" },
			{ match: "# old header", new_str: "# generated" },
		],
		"b.py": [{ match: "dead_code()" }],
	},
};

test("the published schema accepts the documented call", () => {
	const errors = [...validator.Errors(call)].map((e) => `${e.instancePath}: ${e.message}`);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("parseEditRequest projects files into an ordered edits chain", () => {
	const request = parseEditRequest(call);
	assert.equal(request.note, call.note);
	assert.deepEqual(request.edits, [
		{ path: "a.py", match: "amountOwed", new_str: "amountDue" },
		{ path: "a.py", match: "# old header", new_str: "# generated" },
		{ path: "b.py", match: "dead_code()" },
	]);
});

test("the executor consumes the projected shape (note + ordered edits)", () => {
	const request = parseEditRequest(call);
	assert.deepEqual(Object.keys(request).sort(), ["edits", "note"]);
	assert.equal(request.edits.length, 3);
	assert.ok(request.edits.every((e) => typeof e.path === "string" && typeof e.match === "string"));
});

test("entries carry no op field; schema stays anyOf/const-free", () => {
	// Type.Record 编译成 patternProperties/additionalProperties；条目容器在其 items 上。
	const record = editRequestParameters.properties.files;
	const entry = record.additionalProperties ?? Object.values(record.patternProperties ?? {})[0];
	assert.ok(!("op" in entry.items.properties), "op field must be gone");
	const json = JSON.stringify(editRequestParameters);
	assert.ok(!json.includes("anyOf") && !json.includes("const"), "schema must not use anyOf/const");
});

// 严格模式：未声明字段一律拒绝，必须即时报错。
test("rejects an undeclared parameter", () => {
	const bogus = { note: "why", files: { "a.py": [{ match: "x", new_str: "y", stray: 1 }] } };
	assert.throws(() => parseEditRequest(bogus), /files\["a\.py"\]\.stray must be removed/);
});

test("rejects null new_str", () => {
	const bogus = { note: "why", files: { "a.py": [{ match: "x", new_str: null }] } };
	assert.throws(() => parseEditRequest(bogus), /files\["a\.py"\]\.new_str must be a string, got null/);
});

test("rejects a parameter the op uses but as null", () => {
	const bogus = { note: "why", files: { "a.py": [{ match: "x", new_str: null }] } };
	assert.throws(() => parseEditRequest(bogus), /files\["a\.py"\]\.new_str must be a string, got null/);
});

// 顶层严格：多余键、空 files、非对象 files 全部拒绝。
test("rejects a stray top-level key", () => {
	const bogus = { note: "why", files: { "a.py": [{ match: "x" }] }, comment: "legacy" };
	assert.throws(() => parseEditRequest(bogus), /comment must be removed/);
});

test("rejects empty files", () => {
	const bogus = { note: "why", files: {} };
	assert.throws(() => parseEditRequest(bogus), /files must not be empty/);
});

test("rejects files that is not an object", () => {
	const bogus = { note: "why", files: [] };
	assert.throws(() => parseEditRequest(bogus), /files must be an object/);
});

test("rejects missing note", () => {
	const bogus = { files: { "a.py": [{ match: "x" }] } };
	assert.throws(() => parseEditRequest(bogus), /note is required/);
});

test("rejects an empty note", () => {
	const bogus = { note: "", files: { "a.py": [{ match: "x" }] } };
	assert.throws(() => parseEditRequest(bogus), /note is required/);
});

// match 是唯一必填字段（new_str 缺省 = 删除）。
test("rejects an entry missing match", () => {
	const bogus = { note: "why", files: { "a.py": [{ new_str: "y" }] } };
	assert.throws(() => parseEditRequest(bogus), /files\["a\.py"\]\.match must be a string/);
});

test("rejects the removed op field", () => {
	const bogus = { note: "why", files: { "a.py": [{ op: "str_replace", match: "x", new_str: "y" }] } };
	assert.throws(() => parseEditRequest(bogus), /op must be removed/);
});

// 原型键（__proto__/constructor）在 files 里既不可静默执行也不可静默丢弃：
// 严格模式必须枚举自有键，原型污染键被拒绝。
test("prototype keys on files are not silently executed or dropped", () => {
	assert.throws(
		() => parseEditRequest({ note: "why", files: { __proto__: [{ match: "x" }] } }),
		/files must not be empty/,
	);
	// constructor 是自有键（Object.create(null) 无此键，但普通对象字面量有）：
	// 它作为 path 会被枚举并尝试解析——不静默丢弃。
	const request = parseEditRequest({ note: "why", files: { constructor: [{ match: "x" }] } });
	assert.equal(request.edits[0].path, "constructor");
});
