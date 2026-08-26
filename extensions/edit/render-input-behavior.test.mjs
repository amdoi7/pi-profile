import { test } from "vitest";
import assert from "node:assert/strict";

import { buildCallToolViewModel, parseEditRequest } from "./pipeline.ts";

function batch(files, intent = "state the change") {
	return { intent, files };
}

function makeEdit(oldText, newText) {
	return { oldText, newText };
}

test("parseEditRequest returns a ready batch for several files", () => {
	const request = parseEditRequest(batch([
		{ path: "a.ts", edits: [makeEdit("foo", "alpha"), makeEdit("bar", "beta")] },
		{ path: "b.ts", hint: "call site", edits: [makeEdit("baz", "gamma")] },
	]));

	assert.equal(request.intent, "state the change");
	assert.equal(request.files.length, 2);
	assert.equal(request.files[0].edits.length, 2);
	assert.equal(request.files[1].hint, "call site");
});

test("parseEditRequest collapses a multi-line intent into one label", () => {
	const request = parseEditRequest(batch([{ path: "a.ts", edits: [makeEdit("foo", "alpha")] }], "split\n  ToolCtx  into two"));

	assert.equal(request.intent, "split ToolCtx into two");
});

test("parseEditRequest rejects an empty intent", () => {
	assert.throws(
		() => parseEditRequest(batch([{ path: "a.ts", edits: [makeEdit("foo", "alpha")] }], "   ")),
		/intent must not be empty/,
	);
});

test("parseEditRequest rejects a missing intent", () => {
	assert.throws(
		() => parseEditRequest({ files: [{ path: "a.ts", edits: [makeEdit("foo", "alpha")] }] }),
		/intent must be a string/,
	);
});

test("parseEditRequest accepts replaceAll", () => {
	const request = parseEditRequest(batch([
		{ path: "/tmp/demo.ts", edits: [{ oldText: "before", newText: "after", replaceAll: true }] },
	]));

	assert.equal(request.files[0].edits[0].replaceAll, true);
});

test("parseEditRequest rejects non-boolean replaceAll with the field path", () => {
	assert.throws(
		() => parseEditRequest(batch([
			{ path: "/tmp/demo.ts", edits: [{ oldText: "before", newText: "after", replaceAll: "yes" }] },
		])),
		/files\[0\]\.edits\[0\]\.replaceAll must be boolean/,
	);
});

test("parseEditRequest parses files given as a JSON string", () => {
	const request = parseEditRequest({
		intent: "state the change",
		files: JSON.stringify([{ path: "a.ts", edits: [makeEdit("foo", "alpha")] }]),
	});

	assert.equal(request.files.length, 1);
	assert.deepEqual(request.files[0].edits, [makeEdit("foo", "alpha")]);
});

test("parseEditRequest parses per-file edits given as a JSON string", () => {
	const request = parseEditRequest(batch([
		{ path: "a.ts", edits: JSON.stringify([makeEdit("foo", "alpha")]) },
	]));

	assert.deepEqual(request.files[0].edits, [makeEdit("foo", "alpha")]);
});

// 实际语料（2026-08-25，2 例）：edits 到达时是一段未闭合的 JSON 文本（大代码串在
// 传输中被截断）。把它报成「must be an array」会把模型引向改写本来就对的形状，
// 而正确动作是原样重发。
test("edits arriving as unparseable text says so and asks for a re-send", () => {
	assert.throws(
		() => parseEditRequest(batch([{ path: "a.ts", edits: '[{"oldText": "a", "newText"' }])),
		/files\[0\]\.edits .*not valid JSON.*re-send/s,
	);
	assert.throws(
		() => parseEditRequest(batch([{ path: "a.ts", edits: "not-json" }])),
		/files\[0\]\.edits/,
	);
});

// 语料 2026-08-26：文件项只剩 path（且 path 尾巴粘着 " }"）。报「must be an array」
// 把「这一项根本没写完」说成了类型错误。
test("a file entry without any edits says the entry is incomplete", () => {
	assert.throws(
		() => parseEditRequest({ intent: "route sessions to a branch", files: [{ path: "src/tenancy.py }" }] }),
		/files\[0\]\.edits is missing/,
	);
});

// 语料 2026-08-25：单文件形状 + edits 是截断的 JSON 文本。旧行为报「path must be
// removed」——把模型指向删掉唯一正确的字段。
test("a truncated single-file shape blames the edits text, not the path", () => {
	assert.throws(
		() => parseEditRequest({
			intent: "import UTC",
			path: "a.py",
			edits: '[{"newText": "from datetime import UTC, ',
		}),
		/files\[0\]\.edits .*not valid JSON.*re-send/s,
	);
});

test("parseEditRequest lifts the built-in single-file shape into the batch", () => {
	const request = parseEditRequest({
		intent: "state the change",
		path: "a.ts",
		edits: [makeEdit("foo", "alpha")],
	});

	assert.equal(request.files.length, 1);
	assert.equal(request.files[0].path, "a.ts");
	assert.deepEqual(request.files[0].edits, [makeEdit("foo", "alpha")]);
});

test("parseEditRequest lifts the flat { path, oldText, newText } shape with replaceAll", () => {
	const request = parseEditRequest({
		intent: "state the change",
		path: "a.ts",
		oldText: "foo",
		newText: "alpha",
		replaceAll: true,
	});

	assert.deepEqual(request.files[0].edits, [{ oldText: "foo", newText: "alpha", replaceAll: true }]);
});

test("parseEditRequest keeps a lifted single file ahead of explicitly listed files", () => {
	const request = parseEditRequest({
		intent: "state the change",
		path: "a.ts",
		oldText: "foo",
		newText: "alpha",
		files: [{ path: "b.ts", edits: [makeEdit("bar", "beta")] }],
	});

	assert.deepEqual(request.files.map((file) => file.path), ["a.ts", "b.ts"]);
});

test("parseEditRequest rejects the same path listed twice", () => {
	assert.throws(
		() => parseEditRequest(batch([
			{ path: "a.ts", edits: [makeEdit("foo", "alpha")] },
			{ path: "a.ts", edits: [makeEdit("bar", "beta")] },
		])),
		/files\[1\]\.path repeats a\.ts; merge its edits into one entry/,
	);
});

test("parseEditRequest rejects unknown edit properties with the field path", () => {
	assert.throws(
		() => parseEditRequest(batch([
			{ path: "a.ts", edits: [{ oldText: "foo", newText: "bar", extra: true }] },
		])),
		/files\[0\]\.edits\[0\]\.extra must be removed/,
	);
});

test("parseEditRequest rejects unknown file properties", () => {
	assert.throws(
		() => parseEditRequest(batch([{ path: "a.ts", note: "why", edits: [makeEdit("foo", "alpha")] }])),
		/files\[0\]\.note must be removed/,
	);
});

test("parseEditRequest rejects extra top-level properties", () => {
	assert.throws(
		() => parseEditRequest({ ...batch([{ path: "a.ts", edits: [makeEdit("foo", "alpha")] }]), surprise: 1 }),
		/surprise must be removed/,
	);
});

test("buildCallToolViewModel reports a missing oldText", () => {
	const viewModel = buildCallToolViewModel(batch([{ path: "a.ts", edits: [{ newText: "foo" }] }]));

	assert.equal(viewModel.kind, "invalid");
	assert.match(viewModel.message, /files\[0\]\.edits\[0\]\.oldText must be a string/);
});

test("buildCallToolViewModel rejects a missing path", () => {
	const viewModel = buildCallToolViewModel(batch([{ edits: [makeEdit("foo", "bar")] }]));

	assert.equal(viewModel.kind, "invalid");
	assert.match(viewModel.message, /files\[0\]\.path must be a string/);
});

test("buildCallToolViewModel preserves request paths without reading or canonicalizing files", () => {
	const viewModel = buildCallToolViewModel(batch([
		{ path: "./nested/../example.ts", edits: [makeEdit("hello", "hi")] },
	]));

	assert.equal(viewModel.kind, "call");
	assert.deepEqual(viewModel.files, [{ path: "./nested/../example.ts", editCount: 1 }]);
});
