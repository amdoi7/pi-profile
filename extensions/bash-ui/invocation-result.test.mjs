import { test } from "vitest";
import assert from "node:assert/strict";

import { parseInvocationResult } from "./invocation-result.ts";

const successBlock = "Success. Updated the following files:\nM a.ts\nA b.ts";

test("success block parses with ordered changes", () => {
	const parsed = parseInvocationResult(`${successBlock}\n`);
	assert.ok(parsed?.success);
	assert.deepEqual(parsed.changes, [
		{ status: "M", path: "a.ts" },
		{ status: "A", path: "b.ts" },
	]);
});

test("failure JSON parses with appliedPrefix and skipped", () => {
	const failure = JSON.stringify({
		ok: false,
		exitCode: 1,
		error: { code: "FILE_NOT_FOUND", message: "resolve file to update missing.txt", hunk: { index: 1, operation: "update", path: "missing.txt" } },
		appliedPrefix: [{ index: 0, operation: "update", path: "a.txt", oldContent: "old\n", newContent: "new\n" }],
		skipped: [{ hunk: { index: 1 }, message: "bad hunk" }],
	});
	const parsed = parseInvocationResult(failure);
	assert.ok(parsed && !parsed.success);
	assert.equal(parsed.failure.error.code, "FILE_NOT_FOUND");
	assert.equal(parsed.failure.appliedPrefix.length, 1);
	assert.equal(parsed.failure.skipped.length, 1);
});

test("unrecognized output returns undefined", () => {
	assert.equal(parseInvocationResult(""), undefined);
	assert.equal(parseInvocationResult("ls: no such file"), undefined);
	assert.equal(parseInvocationResult("Success. Updated the following files:"), undefined);
	assert.equal(parseInvocationResult('{"ok":true}'), undefined);
	assert.equal(parseInvocationResult('{"ok":false,"exitCode":1}'), undefined);
});
