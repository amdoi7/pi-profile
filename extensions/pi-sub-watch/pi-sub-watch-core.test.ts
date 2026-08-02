import { describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRunsDir, type CompletedRun } from "./pi-sub-watch-core.ts";

const OWNER = "019fc0d6-53f1-7b5b-b382-2ddee71c0353";
const OTHER_OWNER = "019fc0d6-53f1-7b5b-b382-2ddee71c0354";

function makeRunsDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-sub-watch-test-"));
}

function makeRun(runsDir: string, runId: string, state: string, exitCode = "0", owner = OWNER): string {
	const dir = join(runsDir, runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status"), `${state}\t${exitCode}\n`);
	if (owner !== "") writeFileSync(join(dir, "owner-session-id"), `${owner}\n`);
	return dir;
}

function collect(runsDir: string, owner = OWNER): CompletedRun[] {
	const runs: CompletedRun[] = [];
	scanRunsDir(runsDir, owner, (run) => runs.push(run));
	runs.sort((a, b) => a.runId.localeCompare(b.runId));
	return runs;
}

describe("pi-sub-watch owner routing", () => {
	test("ignores a missing or empty runs directory", () => {
		expect(collect("/nonexistent/pi-sub-watch-runs")).toEqual([]);
		const runsDir = makeRunsDir();
		try {
			expect(collect(runsDir)).toEqual([]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("reports only completed runs owned by the current session", () => {
		const runsDir = makeRunsDir();
		try {
			makeRun(runsDir, "owned.complete", "complete", "7");
			makeRun(runsDir, "owned.running", "running");
			makeRun(runsDir, "other.complete", "complete", "0", OTHER_OWNER);
			makeRun(runsDir, "unowned.complete", "complete", "0", "");

			expect(collect(runsDir)).toEqual([{ runId: "owned.complete", exitCode: "7" }]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("atomically claims a completion across scans and watcher instances", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.once", "complete");

			expect(collect(runsDir)).toEqual([{ runId: "task.once", exitCode: "0" }]);
			expect(collect(runsDir)).toEqual([]);
			expect(() => openSync(join(runDir, "notification-claimed"), "wx")).toThrow();
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("releases the claim when delivery fails so a later scan can retry", () => {
		const runsDir = makeRunsDir();
		try {
			makeRun(runsDir, "task.retry", "complete");
			expect(() =>
				scanRunsDir(runsDir, OWNER, () => {
					throw new Error("delivery failed");
				}),
			).toThrow("delivery failed");
			expect(collect(runsDir)).toEqual([{ runId: "task.retry", exitCode: "0" }]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("skips a run whose completion was already claimed", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.claimed", "complete");
			closeSync(openSync(join(runDir, "notification-claimed"), "wx", 0o600));
			expect(collect(runsDir)).toEqual([]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});
});
