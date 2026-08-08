import { describe, expect, test } from "vitest";
import { createGitStatusCache } from "./custom-footer-git.ts";
import customFooterExtension from "./index.ts";

describe("custom footer git status cache", () => {
  test("reuses cached git status while TTL is valid and mtimes are unchanged", () => {
    let nowMs = 1_000;
    let readStatusCalls = 0;
    let resolveGitDirCalls = 0;
    let repoMtimesCalls = 0;

    const readGitStatus = createGitStatusCache({
      getNowMs: () => nowMs,
      resolveGitDir(cwd) {
        resolveGitDirCalls += 1;
        return `${cwd}/.git`;
      },
      getRepoMtimes() {
        repoMtimesCalls += 1;
        return { headMtimeMs: 10, indexMtimeMs: 20 };
      },
      readStatus() {
        readStatusCalls += 1;
        return { branch: "main", dirtyCount: 1, ahead: 2, behind: 3 };
      },
    });

    expect(readGitStatus("/repo")).toEqual({ branch: "main", dirtyCount: 1, ahead: 2, behind: 3 });
    nowMs = 2_000;
    expect(readGitStatus("/repo")).toEqual({ branch: "main", dirtyCount: 1, ahead: 2, behind: 3 });

    expect(resolveGitDirCalls).toBe(1);
    expect(readStatusCalls).toBe(1);
    expect(repoMtimesCalls).toBe(2);
  });

  test("refreshes cached git status when mtimes change before TTL expiry", () => {
    let nowMs = 1_000;
    let mtimes = { headMtimeMs: 10, indexMtimeMs: 20 };
    let readStatusCalls = 0;

    const readGitStatus = createGitStatusCache({
      getNowMs: () => nowMs,
      resolveGitDir(cwd) {
        return `${cwd}/.git`;
      },
      getRepoMtimes() {
        return mtimes;
      },
      readStatus() {
        readStatusCalls += 1;
        return { branch: `main-${readStatusCalls}`, dirtyCount: 0, ahead: 0, behind: 0 };
      },
    });

    expect(readGitStatus("/repo")?.branch).toBe("main-1");
    nowMs = 1_500;
    mtimes = { headMtimeMs: 10, indexMtimeMs: 21 };
    expect(readGitStatus("/repo")?.branch).toBe("main-2");
    expect(readStatusCalls).toBe(2);
  });

  test("caches non-repo lookups until TTL expires", () => {
    let nowMs = 1_000;
    let resolveGitDirCalls = 0;

    const readGitStatus = createGitStatusCache({
      getNowMs: () => nowMs,
      resolveGitDir() {
        resolveGitDirCalls += 1;
        return null;
      },
      getRepoMtimes() {
        throw new Error("should not read mtimes for non-repo cwd");
      },
      readStatus() {
        throw new Error("should not read status for non-repo cwd");
      },
    });

    expect(readGitStatus("/plain")).toBeNull();
    nowMs = 2_000;
    expect(readGitStatus("/plain")).toBeNull();
    nowMs = 3_500;
    expect(readGitStatus("/plain")).toBeNull();

    expect(resolveGitDirCalls).toBe(2);
  });
});

describe("custom footer extension statusline", () => {
  test("renders extension statuses in the statusline", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const pi = {
      getThinkingLevel: () => "high",
      on(event: string, handler: (event: unknown, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
    };
    customFooterExtension(pi as never);

    let footerFactory: any;
    const ctx = {
      getContextUsage: () => undefined,
      model: { id: "test-model" },
      sessionManager: {
        getCwd: () => "/tmp",
        getEntries: () => [],
      },
      ui: {
        setFooter(factory: unknown) {
          footerFactory = factory;
        },
      },
    };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    const footer = footerFactory(
      { requestRender() {} },
      { fg: (_name: string, text: string) => text },
      {
        getExtensionStatuses: () => new Map([["pi-sub", "review running\nimpl queued"]]),
        onBranchChange: () => () => {},
      },
    );

    expect(footer.render(120)).toEqual([
      `cwd: /tmp${" ".repeat(35)}test-model · think:high`,
      "ctx: ? ? │ $0.00",
      "review running",
      "impl queued",
    ]);
    footer.dispose();
  });
});
