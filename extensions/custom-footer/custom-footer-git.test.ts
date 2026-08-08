import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectGitState } from "./custom-footer-git.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "custom-footer-git-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("detectGitState", () => {
  test("returns no label when no operation is in flight", () => {
    expect(detectGitState({})).toEqual({});
  });

  test("reports REBASING with progress from msgnum/end files", () => {
    withDir((dir) => {
      const rebase = join(dir, "rebase-merge");
      mkdirSync(rebase, { recursive: true });
      writeFileSync(join(rebase, "msgnum"), "3", "utf8");
      writeFileSync(join(rebase, "end"), "5", "utf8");
      expect(
        detectGitState({
          rebaseMerge: rebase,
          rebaseMsgnum: join(rebase, "msgnum"),
          rebaseEnd: join(rebase, "end"),
        }),
      ).toEqual({ gitStateLabel: "REBASING 3/5" });
    });
  });

  test("reports REBASING without progress when progress files are missing", () => {
    withDir((dir) => {
      const rebase = join(dir, "rebase-apply");
      mkdirSync(rebase, { recursive: true });
      expect(detectGitState({ rebaseApply: rebase })).toEqual({ gitStateLabel: "REBASING" });
    });
  });

  test("reports MERGING / CHERRY-PICKING / REVERTING / BISECTING", () => {
    withDir((dir) => {
      const file = (name: string) => {
        const p = join(dir, name);
        writeFileSync(p, "", "utf8");
        return p;
      };
      expect(detectGitState({ mergeHead: file("MERGE_HEAD") })).toEqual({
        gitStateLabel: "MERGING",
      });
      expect(detectGitState({ cherryPickHead: file("CHERRY_PICK_HEAD") })).toEqual({
        gitStateLabel: "CHERRY-PICKING",
      });
      expect(detectGitState({ revertHead: file("REVERT_HEAD") })).toEqual({
        gitStateLabel: "REVERTING",
      });
      expect(detectGitState({ bisectLog: file("BISECT_LOG") })).toEqual({
        gitStateLabel: "BISECTING",
      });
    });
  });

  test("rebase takes precedence over merge", () => {
    withDir((dir) => {
      const rebase = join(dir, "rebase-merge");
      mkdirSync(rebase, { recursive: true });
      const mergeHead = join(dir, "MERGE_HEAD");
      writeFileSync(mergeHead, "", "utf8");
      expect(detectGitState({ rebaseMerge: rebase, mergeHead })).toEqual({
        gitStateLabel: "REBASING",
      });
    });
  });
});

import { createGitWatcher } from "./custom-footer-git.ts";

describe("createGitWatcher", () => {
  test("fires onChange for relevant git files and ignores others", () => {
    let captured: ((event: string, filename: string | null) => void) | undefined;
    let watchedDir: string | undefined;
    let closed = false;
    const watcher = createGitWatcher({
      resolveGitDir: () => "/repo/.git",
      watch(dir, cb) {
        watchedDir = dir;
        captured = cb;
        return {
          close() {
            closed = true;
          },
        };
      },
    });
    let onChangeCalls = 0;
    const stop = watcher("/repo", () => {
      onChangeCalls += 1;
    });

    expect(watchedDir).toBe("/repo/.git");
    captured?.("rename", "index");
    captured?.("rename", "MERGE_HEAD");
    captured?.("change", "rebase-merge");
    captured?.("rename", "index.lock");
    captured?.("rename", "objects");
    captured?.("change", null);
    expect(onChangeCalls).toBe(4);

    stop();
    expect(closed).toBe(true);
  });

  test("returns a noop when not in a git repo", () => {
    let watchCalled = false;
    const watcher = createGitWatcher({
      resolveGitDir: () => null,
      watch() {
        watchCalled = true;
        return { close() {} };
      },
    });
    const stop = watcher("/plain", () => {});
    stop();
    expect(watchCalled).toBe(false);
  });

  test("degrades to a noop when watch fails", () => {
    const watcher = createGitWatcher({
      resolveGitDir: () => "/repo/.git",
      watch() {
        throw new Error("EMFILE");
      },
    });
    const stop = watcher("/repo", () => {});
    stop();
  });
});
