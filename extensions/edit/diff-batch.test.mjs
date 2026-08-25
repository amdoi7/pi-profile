import { test, vi } from "vitest";
import assert from "node:assert/strict";

// 事务的展示 diff 必须一次提交：N 个文件 = 1 次 worker 往返（旧契约是
// N 次单文件调用 = N 次往返 + N 次排队）。
const { calls } = vi.hoisted(() => ({ calls: [] }));

vi.mock("../_shared/diff-service.ts", () => ({
	warmUpDiffWorker: () => {},
	requestDiffBatch: async (files, requestId) => {
		calls.push({ requestId, fileCount: files.length });
		return {
			requestId,
			files: files.map((file) => ({
				fileId: file.fileId,
				display: { lineNumberWidth: 1, rows: [] },
				stats: { additions: 1, deletions: 1, changedLines: 2 },
				truncated: false,
				degraded: false,
			})),
		};
	},
}));

const { executeBatchEdits } = await import("./edit-engine.ts");

function memoryOperations(initial) {
	const contents = new Map(Object.entries(initial));
	return {
		stat: async (target) => ({ size: Buffer.byteLength(contents.get(target) ?? "") }),
		access: async (target) => {
			if (!contents.has(target)) throw Object.assign(new Error("Missing file"), { code: "ENOENT" });
		},
		readFile: async (target) => contents.get(target),
		writeFile: async (target, content) => {
			contents.set(target, content);
		},
	};
}

test("one transaction computes every file's diff in a single worker round trip", async () => {
	calls.length = 0;
	const paths = ["/mem/a.ts", "/mem/b.ts", "/mem/c.ts"];
	const operations = memoryOperations(Object.fromEntries(paths.map((target) => [target, "const value = 1;\n"])));

	const result = await executeBatchEdits(
		paths.map((absolutePath) => ({
			absolutePath,
			edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
		})),
		undefined,
		operations,
	);

	assert.equal(result.status, "applied");
	assert.deepEqual(calls, [{ requestId: "edit-preview", fileCount: 3 }]);
});

test("a rejected transaction computes no diff at all", async () => {
	calls.length = 0;
	const operations = memoryOperations({ "/mem/a.ts": "const value = 1;\n", "/mem/b.ts": "const value = 1;\n" });

	const result = await executeBatchEdits([
		{ absolutePath: "/mem/a.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] },
		{ absolutePath: "/mem/b.ts", edits: [{ oldText: "missing", newText: "x" }] },
	], undefined, operations);

	assert.equal(result.status, "rejected");
	assert.deepEqual(calls, []);
});
