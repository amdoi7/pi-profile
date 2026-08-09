import { describe, expect, test } from "vitest";
import { createGitStatusCache, type GitRepoMtimes } from "./custom-footer-git.ts";
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
        return {
          headMtimeMs: 10,
          indexMtimeMs: 20,
          mergeHeadMtimeMs: -1,
          cherryPickHeadMtimeMs: -1,
          revertHeadMtimeMs: -1,
          bisectLogMtimeMs: -1,
          rebaseMsgnumMtimeMs: -1,
          rebaseEndMtimeMs: -1,
        };
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
    let mtimes: GitRepoMtimes = {
      headMtimeMs: 10,
      indexMtimeMs: 20,
      mergeHeadMtimeMs: -1,
      cherryPickHeadMtimeMs: -1,
      revertHeadMtimeMs: -1,
      bisectLogMtimeMs: -1,
      rebaseMsgnumMtimeMs: -1,
      rebaseEndMtimeMs: -1,
    };
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
    mtimes = {
      headMtimeMs: 10,
      indexMtimeMs: 21,
      mergeHeadMtimeMs: -1,
      cherryPickHeadMtimeMs: -1,
      revertHeadMtimeMs: -1,
      bisectLogMtimeMs: -1,
      rebaseMsgnumMtimeMs: -1,
      rebaseEndMtimeMs: -1,
    };
    expect(readGitStatus("/repo")?.branch).toBe("main-2");
    expect(readStatusCalls).toBe(2);
  });

  test("refreshes cached status when an operation marker file mtime changes", () => {
    let nowMs = 1_000;
    let mtimes: GitRepoMtimes = {
      headMtimeMs: 10,
      indexMtimeMs: 20,
      mergeHeadMtimeMs: -1,
      cherryPickHeadMtimeMs: -1,
      revertHeadMtimeMs: -1,
      bisectLogMtimeMs: -1,
      rebaseMsgnumMtimeMs: -1,
      rebaseEndMtimeMs: -1,
    };
    let readStatusCalls = 0;

    const readGitStatus = createGitStatusCache({
      getNowMs: () => nowMs,
      resolveGitDir() {
        return "/repo/.git";
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
    // MERGE_HEAD 出现（mtime 变化）：HEAD/index 未动，缓存也必须失效。
    mtimes = { ...mtimes, mergeHeadMtimeMs: 500 };
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
      mode: "tui",
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

describe("custom footer extension round metrics wiring", () => {
  test("agent events drive round duration and message_end feeds session stats", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const pi = {
      getThinkingLevel: () => "off",
      on(event: string, handler: (event: unknown, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
    };
    customFooterExtension(pi as never);

    let footerFactory: any;
    const ctx = {
      mode: "tui",
      getContextUsage: () => undefined,
      model: { id: "test-model" },
      sessionManager: {
        getCwd: () => "/tmp",
        getEntries: () => [],
      },
      modelRegistry: { find: () => undefined, getProviderDisplayName: () => "test" },
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
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => {},
      },
    );

    // 事件接线：agent_start/agent_settled → 本轮时长；
    // message_update(首块) → TTFB 点；message_end → 输出累计 + 会话聚合。
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("message_update")?.({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")?.(
      { message: { role: "assistant", usage: { input: 100, output: 200 } } },
      ctx,
    );
    await handlers.get("agent_settled")?.({}, ctx);

    const [, row] = footer.render(120);
    // 完成态本轮时长（agent_start → agent_settled 接线）
    expect(row).toContain("本轮");
    // message_end → 会话聚合（flow 累计）接线
    expect(row).toContain("↑100 ↓200");
    footer.dispose();
  });
});

describe("custom footer extension model hook", () => {
  test("model_select triggers an immediate footer render", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const pi = {
      getThinkingLevel: () => "high",
      on(event: string, handler: (event: unknown, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
    };
    customFooterExtension(pi as never);

    let footerFactory: any;
    let renderCalls = 0;
    const ctx = {
      mode: "tui",
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
      { requestRender() { renderCalls += 1; } },
      { fg: (_name: string, text: string) => text },
      {
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => {},
      },
    );
    footer.render(120);

    await handlers.get("model_select")?.({ model: {}, previousModel: undefined, source: "user" }, ctx);
    expect(renderCalls).toBe(1);
    footer.dispose();
  });
});
