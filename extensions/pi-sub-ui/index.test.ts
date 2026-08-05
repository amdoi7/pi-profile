import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piSubUiExtension from "./index.ts";
import { COMPLETION_MESSAGE_TYPE, type CompletionMessage } from "./ui.ts";

const OWNER = "019fc0d6-53f1-7b5b-b382-2ddee71c0353";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.PI_SUB_RUN_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

function makeRun(runsDir: string, runId: string, state: "queued" | "running" | "complete", exitCode = ""): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "owner-session-id"), `${OWNER}\n`);
  writeFileSync(join(runDir, "status"), `${state}\t${exitCode}\n`);
  writeFileSync(join(runDir, "alias"), `${runId.split(".")[0]}\n`);
  writeFileSync(join(runDir, "task-mode"), "read-only\n");
  writeFileSync(join(runDir, "tools"), "read,grep\n");
  writeFileSync(join(runDir, "project-cwd"), "/workspace/project\n");
  writeFileSync(join(runDir, "provider"), "opencode-go\n");
  writeFileSync(join(runDir, "model"), "test-model\n");
  writeFileSync(join(runDir, "thinking"), "high\n");
  writeFileSync(join(runDir, "write-scopes"), "");
  writeFileSync(join(runDir, "stdout"), state === "complete" ? "review complete\n" : "");
  writeFileSync(join(runDir, "stderr"), state === "complete" && exitCode !== "0" ? "review failed\n" : "");
  return runDir;
}

function listEntry(runId: string, state: string, exitCode: number | null = null, age = 3): string {
  return JSON.stringify({
    runId,
    alias: runId.split(".")[0],
    state,
    exitCode,
    model: null,
    stateAgeSeconds: age,
  });
}

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type WidgetCall = { id: string; content: unknown; options: unknown };

function loadExtension(exec: (command: string, args: string[]) => Promise<ExecResult>) {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const messages: Array<{ message: CompletionMessage; options: any }> = [];
  const renderers = new Map<string, unknown>();
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(event, handler);
    },
    registerMessageRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options);
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message: message as CompletionMessage, options });
    },
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
      return exec(command, args);
    },
  };
  piSubUiExtension(pi as never);
  return { handlers, messages, renderers, execCalls, commands };
}

function makeContext(mode = "tui") {
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const widgets: WidgetCall[] = [];
  return {
    ctx: {
      mode,
      hasUI: mode === "tui",
      sessionManager: { getSessionId: () => OWNER },
      ui: {
        setStatus(_id: string, value: string | undefined) {
          statuses.push(value);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setWidget(id: string, content: unknown, options?: unknown) {
          widgets.push({ id, content, options });
        },
      },
    },
    statuses,
    notifications,
    widgets,
  };
}

function capturePollInterval() {
  const original = globalThis.setInterval;
  const state: { poll?: () => Promise<void> } = {};
  globalThis.setInterval = ((fn: () => void) => {
    state.poll = fn as () => Promise<void>;
    return 42;
  }) as typeof setInterval;
  return {
    async tick() {
      await state.poll?.();
    },
    restore() {
      globalThis.setInterval = original;
    },
  };
}

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

const okExec = async () => ({ stdout: "[]", stderr: "", code: 0, killed: false });

describe("pi-sub UI extension", () => {
  let interval: ReturnType<typeof capturePollInterval> | undefined;

  beforeEach(() => {
    interval = capturePollInterval();
  });

  afterEach(() => {
    interval?.restore();
    interval = undefined;
  });

  test("immediately renders active state and sends a structured owner completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    const runsDir = join(root, "runs");
    const completeDir = makeRun(runsDir, "review.done", "complete", "0");
    makeRun(runsDir, "inspect.running", "running");
    process.env.PI_SUB_RUN_DIR = root;
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";

    const { handlers, messages, renderers, execCalls } = loadExtension(async (_cmd, _args) => ({
      stdout: `[${listEntry("inspect.running", "running", null, 5)}]`,
      stderr: "",
      code: 0,
      killed: false,
    }));
    const { ctx, statuses, notifications, widgets } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    expect(renderers.has(COMPLETION_MESSAGE_TYPE)).toBeTrue();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.customType).toBe(COMPLETION_MESSAGE_TYPE);
    expect(messages[0]?.message.details.outcome).toBe("complete");
    expect(messages[0]?.message.details.collectCommand).toBe("'/custom/agent/bin/pi-sub' --result review.done");
    expect(messages[0]?.message.content).toContain("stdout:\nreview complete");
    expect(messages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(notifications).toEqual([{ message: "pi-sub complete: review.done", level: "info" }]);
    expect(existsSync(join(completeDir, "notification-claimed"))).toBeTrue();
    expect(execCalls).toEqual([{ command: "/custom/agent/bin/pi-sub", args: ["--list"] }]);

    const widget = widgets.at(-1);
    expect(widget?.options).toEqual({ placement: "belowEditor" });
    const component = (widget?.content as (tui: unknown, theme: unknown) => { render: (width: number) => string[] })(null, theme);
    expect(component.render(200)).toEqual(["● inspect · read-only · opencode-go/test-model · think:high · running 5s"]);

    await handlers.get("session_shutdown")?.({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
    expect(widgets.at(-1)?.content).toBeUndefined();
  });

  test("reports a failed completion as an error notification", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    makeRun(join(root, "runs"), "review.failed", "complete", "7");
    process.env.PI_SUB_RUN_DIR = root;

    const { handlers, execCalls } = loadExtension(okExec);
    const { ctx, notifications } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    expect(notifications).toEqual([{ message: "pi-sub failed: review.failed (exit 7)", level: "error" }]);
    expect(execCalls).toEqual([]);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("reports a cancelled completion as a warning notification", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    makeRun(join(root, "runs"), "review.cancelled", "complete", "130");
    process.env.PI_SUB_RUN_DIR = root;

    const { handlers, messages } = loadExtension(okExec);
    const { ctx, notifications } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    expect(notifications).toEqual([
      { message: "pi-sub cancelled: review.cancelled (exit 130)", level: "warning" },
    ]);
    expect(messages[0]?.message.details.outcome).toBe("cancelled");
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("clears footer and widget when no active run remains", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    makeRun(join(root, "runs"), "review.done", "complete", "0");
    process.env.PI_SUB_RUN_DIR = root;

    const { handlers } = loadExtension(okExec);
    const { ctx, statuses, widgets } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    expect(statuses.at(-1)).toBeUndefined();
    expect(widgets.at(-1)?.content).toBeUndefined();
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("renders one widget line per active run without a redundant footer count", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    const runsDir = join(root, "runs");
    makeRun(runsDir, "impl.running", "running");
    makeRun(runsDir, "review.running", "running");
    makeRun(runsDir, "audit.queued", "queued");
    process.env.PI_SUB_RUN_DIR = root;

    const { handlers } = loadExtension(async () => ({
      stdout: `[${listEntry("impl.running", "running")},${listEntry("review.running", "running")},${listEntry("audit.queued", "queued")}]`,
      stderr: "",
      code: 0,
      killed: false,
    }));
    const { ctx, statuses, widgets } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    expect(statuses).toEqual([]);
    const widget = widgets.at(-1);
    const component = (widget?.content as (tui: unknown, theme: unknown) => { render: (width: number) => string[] })(null, theme);
    expect(component.render(200)).toEqual([
      "○ audit · read-only · opencode-go/test-model · think:high · queued 3s",
      "● impl · read-only · opencode-go/test-model · think:high · running 3s",
      "● review · read-only · opencode-go/test-model · think:high · running 3s",
    ]);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("delivers a lost completion only after two consecutive observations", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    const runsDir = join(root, "runs");
    const lostDir = makeRun(runsDir, "review.lost", "running");
    process.env.PI_SUB_RUN_DIR = root;

    const { handlers, messages } = loadExtension(async () => ({
      stdout: `[${listEntry("review.lost", "lost", null, 12)}]`,
      stderr: "",
      code: 0,
      killed: false,
    }));
    const { ctx, statuses, notifications, widgets } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    expect(messages).toHaveLength(0);
    expect(notifications).toEqual([]);
    expect(existsSync(join(lostDir, "notification-claimed"))).toBeFalse();

    await interval?.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.details.outcome).toBe("lost");
    expect(messages[0]?.message.details.exitCode).toBeNull();
    expect(notifications).toEqual([{ message: "pi-sub lost: review.lost", level: "error" }]);
    expect(existsSync(join(lostDir, "notification-claimed"))).toBeTrue();
    expect(widgets.at(-1)?.content).toBeUndefined();

    await interval?.tick();
    expect(messages).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("does not deliver lost when the run completes between observations", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    const runsDir = join(root, "runs");
    makeRun(runsDir, "review.race", "running");
    process.env.PI_SUB_RUN_DIR = root;

    let listedLost = true;
    const { handlers, messages } = loadExtension(async () => ({
      stdout: listedLost ? `[${listEntry("review.race", "lost", null, 3)}]` : "[]",
      stderr: "",
      code: 0,
      killed: false,
    }));
    const { ctx, notifications } = makeContext();
    await handlers.get("session_start")?.({}, ctx);
    expect(messages).toHaveLength(0);

    listedLost = false;
    writeFileSync(join(runsDir, "review.race", "status"), "complete\t130\n");
    await interval?.tick();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.details.outcome).toBe("cancelled");
    expect(notifications).toEqual([
      { message: "pi-sub cancelled: review.race (exit 130)", level: "warning" },
    ]);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("shows recent tool activity from the events stream in the widget", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-ui-index-"));
    roots.push(root);
    const runsDir = join(root, "runs");
    const runDir = makeRun(runsDir, "impl.busy", "running");
    writeFileSync(
      join(runDir, "events"),
      '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"bun test extensions/pi-sub-ui"}}\n',
    );
    process.env.PI_SUB_RUN_DIR = root;

    const { handlers } = loadExtension(async () => ({
      stdout: `[${listEntry("impl.busy", "running")}]`,
      stderr: "",
      code: 0,
      killed: false,
    }));
    const { ctx, widgets } = makeContext();
    await handlers.get("session_start")?.({}, ctx);

    const widget = widgets.at(-1);
    const component = (widget?.content as (tui: unknown, theme: unknown) => { render: (width: number) => string[] })(null, theme);
    expect(component.render(200)).toEqual(["● impl · read-only · opencode-go/test-model · think:high · running 3s · $ bun test extensions/pi-sub-ui"]);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("does not start polling in print mode", async () => {
    const { handlers, messages } = loadExtension(okExec);
    const { ctx, statuses } = makeContext("print");
    await handlers.get("session_start")?.({}, ctx);

    expect(messages).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
