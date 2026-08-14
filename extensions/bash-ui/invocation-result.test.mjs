import { test } from "vitest";
import assert from "node:assert/strict";

import { parseInvocationResult } from "./invocation-result.ts";

const successText = "Success. Updated the following files:\nM a.ts\nA b.ts\n";

test("success text parses with ordered changes", () => {
	const parsed = parseInvocationResult(successText);
	assert.ok(parsed?.success);
	assert.deepEqual(parsed.changes, [
		{ status: "M", path: "a.ts" },
		{ status: "A", path: "b.ts" },
	]);
});

test("success text keeps paths with spaces", () => {
	const parsed = parseInvocationResult("Success. Updated the following files:\nM my file.ts\n");
	assert.ok(parsed?.success);
	assert.deepEqual(parsed.changes, [{ status: "M", path: "my file.ts" }]);
});

test("failure text parses code, message, hunk, applied and skipped", () => {
	const failure = [
		"error[FILE_NOT_FOUND]",
		"hunk: #1 update missing.txt",
		"applied: #0 update a.txt",
		"skipped: #1 update chunk 0 bad.txt — Invalid patch hunk on line 3: no +/- lines",
		"message: resolve file to update missing.txt",
	].join("\n");
	const parsed = parseInvocationResult(failure);
	assert.ok(parsed && !parsed.success);
	assert.equal(parsed.failure.error.code, "FILE_NOT_FOUND");
	assert.equal(parsed.failure.error.message, "resolve file to update missing.txt");
	assert.deepEqual(parsed.failure.error.hunk, { index: 1, operation: "update", path: "missing.txt", chunkIndex: undefined });
	assert.deepEqual(parsed.failure.appliedPrefix, [{ index: 0, operation: "update", path: "a.txt" }]);
	assert.deepEqual(parsed.failure.skipped, [
		{ index: 1, operation: "update", path: "bad.txt", chunkIndex: 0, message: "Invalid patch hunk on line 3: no +/- lines" },
	]);
});

test("failure message spans multiple lines to EOF", () => {
	const failure = [
		"error[CONTEXT_NOT_FOUND]",
		"hunk: #0 update chunk 1 example.txt",
		"message: Failed to find expected lines in example.txt:",
		"missing line one",
		"missing line two",
	].join("\n");
	const parsed = parseInvocationResult(failure);
	assert.ok(parsed && !parsed.success);
	assert.equal(
		parsed.failure.error.message,
		"Failed to find expected lines in example.txt:\nmissing line one\nmissing line two",
	);
	assert.equal(parsed.failure.error.hunk?.chunkIndex, 1);
});

test("failure without hunk reference and with bare index", () => {
	const usage = parseInvocationResult("error[USAGE]\nmessage: apply_patch accepts exactly one argument\n");
	assert.ok(usage && !usage.success);
	assert.equal(usage.failure.error.code, "USAGE");
	assert.equal(usage.failure.error.hunk, undefined);
	assert.deepEqual(usage.failure.appliedPrefix, []);

	const bare = parseInvocationResult("error[INVALID_PATCH]\nhunk: #0\nmessage: content before envelope\n");
	assert.ok(bare && !bare.success);
	assert.deepEqual(bare.failure.error.hunk, { index: 0, operation: undefined, path: undefined, chunkIndex: undefined });
});

test("unrecognized output returns undefined", () => {
	assert.equal(parseInvocationResult(""), undefined);
	assert.equal(parseInvocationResult("ls: no such file"), undefined);
	// JSON 信封契约已退役：不再被识别。
	assert.equal(parseInvocationResult('{"ok":true,"exitCode":0,"changes":[]}'), undefined);
	assert.equal(parseInvocationResult('{"ok":false,"exitCode":1}'), undefined);
	// failure 缺 message 行 → 形状不符。
	assert.equal(parseInvocationResult("error[USAGE]\n"), undefined);
	// success marker 之后出现非 change 行 → 形状不符。
	assert.equal(parseInvocationResult("Success. Updated the following files:\nnot a change\n"), undefined);
});
