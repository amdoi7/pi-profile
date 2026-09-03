import { test } from "vitest";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";

import { editRequestParameters, parseEditRequest } from "../index.ts";

const validator = Compile(editRequestParameters);

// README 里公布的那一次调用，逐字。
const call = {
	note: "跨结算域重命名:amountOwed/amountDue 对齐新结算模型",
	edits: [
		{ path: "a.py", op: "replaceAll", old_str: "amountOwed", new_str: "amountDue" },
		{ path: "a.py", op: "insert", insert_line: 3, new_str: "# generated\n" },
		{ path: "b.py", op: "delete", old_str: "dead_code()" },
		{ path: "c.py", op: "create", file_text: "# generated module\n\nVERSION = 1\n" },
	],
};

// 一种形状：schema 说的形状 = 校验后的形状 = 执行层吃的形状。
test("the published schema accepts the documented call", () => {
	const errors = [...validator.Errors(call)].map((e) => `${e.instancePath}: ${e.message}`);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("validation narrows the type without reshaping the object", () => {
	assert.deepEqual(parseEditRequest(call), call);
});

test("what parseEditRequest returns still satisfies the schema", () => {
	const errors = [...validator.Errors(parseEditRequest(call))].map((e) => `${e.instancePath}: ${e.message}`);
	assert.deepEqual(errors, [], errors.join("\n"));
});

// Google 的 API 不接受 anyOf/const（docs/extensions.md）：枚举必须是裸 enum。
test("enum fields are published as string enums, not anyOf/const unions", () => {
	const entry = editRequestParameters.properties.edits.items;
	assert.deepEqual(entry.properties.op.enum, ["replace", "replaceAll", "insert", "delete", "create", "write"]);
	const json = JSON.stringify(editRequestParameters);
	assert.ok(!json.includes("anyOf") && !json.includes("const"), "schema must not use anyOf/const");
});

// op 名单是 schema 与手写校验的共同真源：schema 先拒，parse 的消息也带全名单。
test("an op outside the enum is rejected by both the schema and the hand-written check", () => {
	const bogus = { note: "why", edits: [{ path: "a.py", op: "str_replace", old_str: "x", new_str: "y" }] };
	assert.equal(validator.Check(bogus), false);
	assert.throws(() => parseEditRequest(bogus), /op must be one of replace \| replaceAll \| insert \| delete/);
});

// null 占位（str_replace_editor 语义）：schema 可空；校验后 null 当省略删除。
test("null placeholders on unused parameters are treated as omitted", () => {
	const withNulls = {
		note: "why",
		edits: [{ path: "a.py", op: "replace", old_str: "x", new_str: "y", insert_line: null, file_text: null }],
	};
	assert.equal(validator.Check(withNulls), true);
	assert.deepEqual(parseEditRequest(withNulls).edits[0], { path: "a.py", op: "replace", old_str: "x", new_str: "y" });
});

// 共享参数集：op 不读的参数（非 null）原样保留，执行层忽略。
test("parameters the op does not read stay inert", () => {
	const request = parseEditRequest({
		note: "why",
		edits: [{ path: "a.py", op: "delete", old_str: "x", new_str: "nope" }],
	});
	assert.deepEqual(request.edits[0], { path: "a.py", op: "delete", old_str: "x", new_str: "nope" });
});
