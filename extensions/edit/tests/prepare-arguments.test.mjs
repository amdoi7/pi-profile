import { test } from "vitest";
import assert from "node:assert/strict";

import editExtension, { editRequestParameters } from "../index.ts";
import { Compile } from "typebox/compile";

function captureTool() {
	let registeredTool;
	editExtension({
		registerTool(definition) {
			registeredTool = definition;
		},
		on() {},
	});
	if (!registeredTool) throw new Error("edit tool was not registered");
	return registeredTool;
}

// pi 的 prepare 顺序（agent-loop prepareToolCall）：prepareArguments →
// validateToolArguments（schema 闸门）→ beforeToolCall → execute；prepare 段任何
// 异常都被包成 isError tool_result 回给模型。prepareArguments 因此是扩展唯一
// 能抢在 schema 闸门之前的错误通道——rich 文案（字段名+当前值）必须在这里先炸，
// generic 的 TypeBox 文案（"root: must not have additional properties"）才轮不到出场。
// 不向后兼容：旧形状在这里被 rich 拒绝，错误即教新形状。

const canonical = { note: "why", path: "a.py", edits: [{ match: "x", new_str: "y" }] };

test("prepare passes the canonical call through unchanged", () => {
	const tool = captureTool();
	assert.equal(tool.prepareArguments(canonical), canonical);
});

test("prepare returns an object the published schema accepts", () => {
	const tool = captureTool();
	const validator = Compile(editRequestParameters);
	const out = tool.prepareArguments(canonical);
	const errors = [...validator.Errors(out)].map((e) => `${e.instancePath}: ${e.message}`);
	assert.deepEqual(errors, [], errors.join("\n"));
});

// ─── rich 错误必须抢在 schema 闸门之前 ──────────────────────────────────────

test("prepare surfaces the rich error for a stray top-level key", () => {
	const tool = captureTool();
	const bogus = { ...canonical, comment: "legacy" };
	assert.throws(() => tool.prepareArguments(bogus), /comment must be removed/);
});

test("prepare surfaces the rich error for an entry missing match", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ note: "why", path: "a.py", edits: [{ new_str: "y" }] }),
		/edits\[0\]\.match must be a string/,
	);
});

test("prepare surfaces the rich error for a stray entry key", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ note: "why", path: "a.py", edits: [{ match: "x", stray: 1 }] }),
		/edits\[0\]\.stray must be removed/,
	);
});

test("prepare accepts null new_str as delete (provider null-is-omit)", () => {
	const tool = captureTool();
	const out = tool.prepareArguments({ note: "why", path: "a.py", edits: [{ match: "x", new_str: null }] });
	assert.ok(out, "null new_str = delete, not an error");
});

test("prepare surfaces the rich error for missing note", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ path: "a.py", edits: [{ match: "x" }] }),
		/note is required/,
	);
});

test("prepare surfaces the rich error for missing path", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ note: "why", edits: [{ match: "x" }] }),
		/path is required/,
	);
});

// ─── 不向后兼容：旧形状被 rich 拒绝，错误教新形状 ─────────────────────────

test("rejects the legacy files-group shape with the shape fix in the message", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ note: "why", files: { "a.py": [{ match: "x" }] } }),
		/files must be removed/,
	);
});

test("rejects a legacy per-entry path (path is top-level only)", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ note: "why", path: "a.py", edits: [{ path: "a.py", match: "x" }] }),
		/edits\[0\]\.path must be removed/,
	);
});

test("rejects the built-in-edit prior (root path + oldText/newText entries)", () => {
	const tool = captureTool();
	assert.throws(
		() => tool.prepareArguments({ path: "a.py", edits: [{ oldText: "x", newText: "y" }] }),
		/note is required/,
	);
});
