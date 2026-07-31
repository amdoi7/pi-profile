import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	buildOutcomeAgentContent,
	buildOutcomeSummary,
	buildExecutionOutcome,
	createExecutionPlan,
} from "./pipeline.ts";

async function createTempFile(prefix, name, content = "hello\n") {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	await fs.promises.writeFile(file, content, "utf-8");
	return { dir, file };
}

function makeAppliedGroup(pathName, canonicalPath, previewText) {
	return {
		path: pathName,
		canonicalPath,
		edits: [{ oldText: "x", newText: "y" }],
		editCount: 1,
		status: "applied",
		operation: "replace",
		previewText,
		previewStartLine: 1,
		previewTruncated: false,
		changeStats: { additions: 1, deletions: 0, changedLines: 1 },
		summary: `updated ${pathName} (1 edit)`,
	};
}

function makeFailedGroup(pathName, canonicalPath, error, errorKind = "DUPLICATE_MATCH") {
	return {
		path: pathName,
		canonicalPath,
		edits: [{ oldText: "m", newText: "n" }],
		editCount: 1,
		status: "failed",
		errorKind,
		error,
	};
}

test("createExecutionPlan keeps file order and preserves grouped edits per file", async () => {
	const { dir } = await createTempFile("pi-edit-plan-", "example.txt");

	const plan = createExecutionPlan(
		{
			files: [
				{
					path: "example.txt",
					edits: [
						{ oldText: "hello", newText: "hi" },
						{ oldText: "hello\n", newText: "hi\n" },
					],
				},
			],
		},
		dir,
	);

	assert.equal(plan.groups.length, 1);
	assert.equal(plan.groups[0]?.path, "example.txt");
	assert.equal(plan.groups[0]?.edits.length, 2);
});

test("createExecutionPlan merges duplicate canonical file entries and preserves first path", async () => {
	const { dir } = await createTempFile("pi-edit-dup-", "example.txt");

	const plan = createExecutionPlan(
		{
			files: [
				{ path: "example.txt", edits: [{ oldText: "hello", newText: "hi" }] },
				{ path: "./nested/../example.txt", edits: [{ oldText: "hi", newText: "hey" }] },
			],
		},
		dir,
	);

	assert.equal(plan.groups.length, 1);
	assert.equal(plan.groups[0]?.path, "example.txt");
	assert.deepEqual(plan.groups[0]?.edits, [
		{ oldText: "hello", newText: "hi" },
		{ oldText: "hi", newText: "hey" },
	]);
	assert.equal(plan.totalEdits, 2);
});

test("partial failures produce compact agent-readable JSON with counts and structured errors", () => {
	const outcome = buildExecutionOutcome([
		makeAppliedGroup("a.ts", "/tmp/a.ts", "+1 y"),
		makeFailedGroup("b.ts", "/tmp/b.ts", "DUPLICATE_MATCH the text in b.ts (3 occurrences). oldText is not unique."),
	]);

	const parsed = JSON.parse(buildOutcomeAgentContent(outcome));
	assert.equal(buildOutcomeSummary(outcome), "Applied 1 file; 1 failed.");
	assert.equal(parsed.counts.applied, 1);
	assert.equal(parsed.counts.failed, 1);
	assert.equal(parsed.applied[0].path, "a.ts");
	assert.equal(parsed.failed[0].error.kind, "DUPLICATE_MATCH");
});

test("successful outcomes return compact agent-readable JSON instead of prose summaries", () => {
	const outcome = buildExecutionOutcome([
		makeAppliedGroup("a.ts", "/tmp/a.ts", "+1 y"),
		makeAppliedGroup("b.ts", "/tmp/b.ts", "+1 n"),
	]);

	const parsed = JSON.parse(buildOutcomeAgentContent(outcome));
	assert.equal(parsed.counts.applied, 2);
	assert.equal(parsed.counts.failed, 0);
	assert.deepEqual(parsed.applied.map((group) => group.path), ["a.ts", "b.ts"]);
});

test("failure content carries structured error kind instead of requiring string parsing", () => {
	const outcome = buildExecutionOutcome([
		makeFailedGroup("b.ts", "/tmp/b.ts", "oldText is not unique."),
	]);

	const parsed = JSON.parse(buildOutcomeAgentContent(outcome));
	assert.equal(parsed.failed[0].error.kind, "DUPLICATE_MATCH");
	assert.equal(parsed.failed[0].error.message, "oldText is not unique.");
});
