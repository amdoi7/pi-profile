import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeExecutionPlan } from "./batch-execution.ts";

async function makeTempFile(content = "hello\n") {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-batch-"));
	const file = path.join(dir, "file.ts");
	await fs.promises.writeFile(file, content, "utf-8");
	return file;
}

function makePlanGroup(pathName, canonicalPath, oldText, newText) {
	return {
		path: pathName,
		canonicalPath,
		edits: [{ oldText, newText }],
	};
}

function makePlan(groups, maxConcurrency = groups.length) {
	return {
		groups,
		totalEdits: groups.reduce((total, group) => total + group.edits.length, 0),
		maxConcurrency,
	};
}

function makeAppliedResult(displayPath, edits) {
	return {
		previewText: `preview:${displayPath}`,
		previewStartLine: 1,
		previewTruncated: false,
		changeStats: { additions: 1, deletions: 0, changedLines: 1 },
		summary: `Successfully replaced ${edits.length} block(s) in ${displayPath}.`,
	};
}

test("executeExecutionPlan runs plan groups concurrently for small files and keeps result order", async () => {
	const slowFile = await makeTempFile("before\n");
	const fastFile = await makeTempFile("old\n");

	const started = [];
	let activeCount = 0;
	let maxActiveCount = 0;

	const results = await executeExecutionPlan(
		makePlan([
			makePlanGroup("src/slow.ts", slowFile, "before", "after"),
			makePlanGroup("src/fast.ts", fastFile, "old", "new"),
		], 2),
		undefined,
		async (_absolutePath, displayPath, edits) => {
			started.push(displayPath);
			activeCount += 1;
			if (activeCount > maxActiveCount) maxActiveCount = activeCount;
			const delayMs = displayPath === "src/slow.ts" ? 25 : 5;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			activeCount -= 1;
			return makeAppliedResult(displayPath, edits);
		},
	);

	assert.equal(started.length, 2);
	assert.ok(maxActiveCount > 1, "expected multiple plan groups to execute concurrently");
	assert.ok(maxActiveCount <= 2, "expected concurrency to stay within the plan limit");
	assert.deepEqual(results.map((r) => r.path), ["src/slow.ts", "src/fast.ts"]);
	assert.deepEqual(results.map((r) => r.status), ["applied", "applied"]);
	assert.equal(results[0]?.previewText, "preview:src/slow.ts");
	assert.equal(results[1]?.previewText, "preview:src/fast.ts");
});

test("executeExecutionPlan isolates per-file failures without hiding successful siblings", async () => {
	const okFile = await makeTempFile("before\n");
	const failFile = await makeTempFile("missing\n");

	const results = await executeExecutionPlan(
		makePlan([
			makePlanGroup("src/ok.ts", okFile, "before", "after"),
			makePlanGroup("src/fail.ts", failFile, "missing", "replacement"),
		], 2),
		undefined,
		async (_absolutePath, displayPath, edits) => {
			if (displayPath === "src/fail.ts") {
				throw new Error(`Could not find the exact text in ${displayPath}. The old text must match exactly including all whitespace and newlines.`);
			}
			return makeAppliedResult(displayPath, edits);
		},
	);

	assert.deepEqual(results.map((r) => r.path), ["src/ok.ts", "src/fail.ts"]);
	assert.equal(results[0]?.status, "applied");
	assert.equal(results[1]?.status, "failed");
	if (results[1]?.status !== "failed") throw new Error("expected the second file group to fail");
	assert.match(results[1].error, /Could not find the exact text in src\/fail\.ts/);
});
