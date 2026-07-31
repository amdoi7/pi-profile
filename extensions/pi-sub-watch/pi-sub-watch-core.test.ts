import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCompletedRunIds, loadNotified, saveNotified, scanRunsDir, type CompletedRun } from "./pi-sub-watch-core.ts";

function makeRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-sub-watch-test-"));
}

function makeRun(runsDir: string, runId: string, state: string, exitCode = "0"): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), `${state}\t${exitCode}\n`);
}

function collect(runsDir: string, notified = new Set<string>()): { runs: CompletedRun[]; notified: Set<string> } {
  const runs: CompletedRun[] = [];
  scanRunsDir(runsDir, notified, (run) => runs.push(run));
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  return { runs, notified };
}

describe("pi-sub-watch core scan", () => {
  test("ignores missing runs dir", () => {
    const { runs } = collect("/nonexistent/pi-sub-watch-runs");
    expect(runs).toEqual([]);
  });

  test("ignores empty runs dir", () => {
    const runsDir = makeRunsDir();
    try {
      const { runs } = collect(runsDir);
      expect(runs).toEqual([]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("does not report queued or running runs", () => {
    const runsDir = makeRunsDir();
    try {
      makeRun(runsDir, "task.aaaa", "queued");
      makeRun(runsDir, "task.bbbb", "running");
      const { runs } = collect(runsDir);
      expect(runs).toEqual([]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("reports a completed run with its exit code", () => {
    const runsDir = makeRunsDir();
    try {
      makeRun(runsDir, "task.cccc", "complete", "7");
      const { runs } = collect(runsDir);
      expect(runs).toEqual([{ runId: "task.cccc", exitCode: "7" }]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("reports multiple completed runs", () => {
    const runsDir = makeRunsDir();
    try {
      makeRun(runsDir, "task.dddd", "complete", "0");
      makeRun(runsDir, "task.eeee", "complete", "1");
      makeRun(runsDir, "task.ffff", "running");
      const { runs } = collect(runsDir);
      expect(runs).toEqual([
        { runId: "task.dddd", exitCode: "0" },
        { runId: "task.eeee", exitCode: "1" },
      ]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("reports each run exactly once across scans", () => {
    const runsDir = makeRunsDir();
    try {
      makeRun(runsDir, "task.gggg", "complete", "0");
      const notified = new Set<string>();
      const first = collect(runsDir, notified);
      const second = collect(runsDir, notified);
      expect(first.runs).toHaveLength(1);
      expect(second.runs).toHaveLength(0);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("treats a missing exit code as unknown", () => {
    const runsDir = makeRunsDir();
    try {
      const dir = join(runsDir, "task.hhhh");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "status"), "complete\n");
      const { runs } = collect(runsDir);
      expect(runs).toEqual([{ runId: "task.hhhh", exitCode: "?" }]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe("pi-sub-watch notified persistence", () => {
  test("round-trips the notified set through a file", () => {
                
    const dir = mkdtempSync(join(tmpdir(), "pi-sub-watch-persist-"));
    try {
      const file = join(dir, "notified.json");
      const set = new Set(["task.aaaa", "task.bbbb"]);
      saveNotified(file, set);
      const loaded = loadNotified(file);
      expect([...loaded].sort()).toEqual(["task.aaaa", "task.bbbb"]);
      expect(readFileSync(file, "utf8")).not.toContain(".tmp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadNotified returns an empty set for a missing file", () => {
        expect([...loadNotified("/nonexistent/notified.json")]).toEqual([]);
  });

  test("loadNotified ignores corrupt content", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
            
    const dir = mkdtempSync(join(tmpdir(), "pi-sub-watch-corrupt-"));
    try {
      const file = join(dir, "notified.json");
      writeFileSync(file, "{not-json");
      expect([...loadNotified(file)]).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pi-sub-watch first-start seeding", () => {
  test("collectCompletedRunIds returns only complete runs", () => {
    const runsDir = makeRunsDir();
    try {
      makeRun(runsDir, "task.seed1", "complete", "0");
      makeRun(runsDir, "task.seed2", "complete", "1");
      makeRun(runsDir, "task.seed3", "running");
      const ids = collectCompletedRunIds(runsDir);
      expect(ids.sort()).toEqual(["task.seed1", "task.seed2"]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
