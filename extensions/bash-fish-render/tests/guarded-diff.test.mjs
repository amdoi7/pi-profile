import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	computeGuardedPatchDiffs,
	extractPatchFiles,
} from "../guarded-diff.ts";
import { generateFinalDiff } from "../../_shared/final-diff.ts";

describe("extractPatchFiles", () => {
	it("parses Add/Update/Delete headers from an apply_patch command", () => {
		const command = [
			"apply_patch '*** Begin Patch",
			"*** Add File: a.txt",
			"+x",
			"*** Update File: b dir/nested.txt",
			"@@",
			"-a",
			"+b",
			"*** Delete File: c.txt",
			"-z",
			"*** End Patch'",
		].join("\n");
		expect(extractPatchFiles(command)).toEqual([
			{ op: "Add", path: "a.txt" },
			{ op: "Update", path: "b dir/nested.txt" },
			{ op: "Delete", path: "c.txt" },
		]);
	});

	it("returns empty for non-apply_patch commands", () => {
		expect(extractPatchFiles("ls -la")).toEqual([]);
	});
});

describe("guarded diff engine boundedness (the hang fix)", () => {
	it("resolves adversarial partially-shared 20k-line change quickly", async () => {
		const size = 20000;
		const oldLines = Array.from({ length: size }, (_, i) => `line-${i}-common-tail`);
		const newLines = oldLines.map((line, i) => (i % 3 === 0 ? line : line.replace("common-tail", `changed-${i}`)));
		const oldText = oldLines.join("\n");
		const newText = newLines.join("\n");
		const started = Date.now();
		const display = generateFinalDiff(oldText, newText).display;
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(5000);
		expect(display.rows.length).toBeGreaterThan(0);
	});

	it("full-file 16k-line rewrite completes fast (the reported hang case)", async () => {
		const size = 16000;
		const oldText = Array.from({ length: size }, (_, i) => `old-line-${i}-padding-padding-padding`).join("\n");
		const newText = Array.from({ length: size }, (_, i) => `new-line-${i}-padding-padding-padding`).join("\n");
		const started = Date.now();
		generateFinalDiff(oldText, newText);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(3000);
	});
});

describe("computeGuardedPatchDiffs (file-level)", () => {
	it("returns an empty list when no before snapshot exists", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guard-diff-"));
		const diffs = await computeGuardedPatchDiffs(cwd, [{ op: "Update", path: "nope.txt" }], new Map());
		expect(diffs).toEqual([]);
	});

	it("returns structured per-file results with dual line coordinates", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guard-diff-struct-"));
		fs.writeFileSync(path.join(cwd, "hello.txt"), "hello\npi\n");
		const before = new Map([["hello.txt", "hello\nworld\n"]]);
		const [result] = await computeGuardedPatchDiffs(cwd, [{ op: "Update", path: "hello.txt" }], before);

		expect(result.kind).toBe("Update");
		expect(result.path).toBe("hello.txt");
		expect(result.cwd).toBe(cwd);
		expect(result.changeStats).toEqual({ additions: 1, deletions: 1, changedLines: 2 });
		expect(result.truncated).toBe(false);
		// 双侧行号坐标必须保留（remove 带 oldLine，add 带 newLine）。
		const rows = result.display.rows;
		expect(rows).toContainEqual({ kind: "context", oldLine: 1, newLine: 1, content: "hello" });
		expect(rows).toContainEqual(expect.objectContaining({ kind: "remove", oldLine: 2, content: "world" }));
		expect(rows).toContainEqual(expect.objectContaining({ kind: "add", newLine: 2, content: "pi" }));
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("maps Add and Delete ops to structured kinds", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guard-diff-kinds-"));
		fs.writeFileSync(path.join(cwd, "added.txt"), "new\n");
		const before = new Map([["added.txt", undefined], ["removed.txt", "gone\n"]]);
		const results = await computeGuardedPatchDiffs(
			cwd,
			[{ op: "Add", path: "added.txt" }, { op: "Delete", path: "removed.txt" }],
			before,
		);
		expect(results.map((r) => [r.kind, r.path])).toEqual([["Add", "added.txt"], ["Delete", "removed.txt"]]);
		expect(results[0].changeStats).toEqual({ additions: 1, deletions: 0, changedLines: 1 });
		expect(results[1].changeStats).toEqual({ additions: 0, deletions: 1, changedLines: 1 });
		fs.rmSync(cwd, { recursive: true, force: true });
	});
});
