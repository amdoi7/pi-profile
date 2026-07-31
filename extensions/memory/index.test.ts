import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("node:os", () => ({
  ...os,
  homedir() {
    if (!process.env.HOME) {
      throw new Error("HOME must be set in memory extension tests");
    }
    return process.env.HOME;
  },
}));

const memoryModule = await import("./index.ts") as Record<string, unknown>;
const memoryExtension = memoryModule.default as (api: unknown) => void;

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectDir(): string {
  const projectDir = makeTempDir("memory-extension-project-");
  fs.mkdirSync(path.join(projectDir, ".git"));
  return projectDir;
}

function makeNonProjectDir(): string {
  return makeTempDir("memory-extension-no-git-");
}

function projectMemoryDir(homeDir: string, projectDir: string): string {
  const flattened = path.resolve(projectDir).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
  return path.join(homeDir, ".pi", "memory", flattened);
}

function makeCtx(projectDir: string, notifications: string[] = []) {
  return {
    cwd: projectDir,
    hasUI: false,
    hasPendingMessages() {
      return false;
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      custom: async () => undefined,
      theme: {
        fg: (_name: string, text: string) => text,
        bold: (text: string) => text,
      },
    },
    sessionManager: {
      getSessionDir() {
        return path.join(projectDir, ".sessions");
      },
    },
  } as any;
}

function registerMemoryExtension() {
  const hooks = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();

  memoryExtension({
    appendEntry() {},
    on(event: string, handler: any) {
      hooks.set(event, handler);
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
  } as any);

  return { commands, hooks, tools };
}

beforeEach(() => {
  process.env.HOME = makeTempDir("memory-extension-home-");
});

afterEach(() => {
  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory extension behavior", () => {
  test("session_start creates the scaffold under ~/.pi/memory with a flattened project path", async () => {
    const projectDir = makeProjectDir();
    const nestedDir = path.join(projectDir, "apps", "web");
    fs.mkdirSync(nestedDir, { recursive: true });
    const ctx = makeCtx(nestedDir);
    const { hooks, tools, commands } = registerMemoryExtension();
    const sessionStartHandler = hooks.get("session_start");
    if (!sessionStartHandler) throw new Error("session_start handler was not registered");

    await sessionStartHandler({}, ctx);

    const memoryDir = projectMemoryDir(process.env.HOME!, projectDir);
    expect(fs.existsSync(memoryDir)).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "issues.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "issues"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "tasks.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "lessons.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "tasks"))).toBe(true);
    const memoryIndex = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    const issuesIndex = fs.readFileSync(path.join(memoryDir, "issues.md"), "utf8");
    const tasksIndex = fs.readFileSync(path.join(memoryDir, "tasks.md"), "utf8");
    const lessonsIndex = fs.readFileSync(path.join(memoryDir, "lessons.md"), "utf8");
    expect(memoryIndex).toContain("# MEMORY");
    expect(memoryIndex).toContain("issues.md");
    expect(memoryIndex).toContain("tasks.md");
    expect(memoryIndex).toContain("lessons.md");
    expect(memoryIndex).not.toContain("TASKS.md");
    expect(memoryIndex).not.toContain("LESSONS.md");
    expect(memoryIndex).not.toContain("TODO.md");
    expect(issuesIndex).toContain("# Issues");
    expect(issuesIndex).toContain("Core flow: Issue -> Task.");
    expect(issuesIndex).toContain("issue owns outcome, scope, constraints, and acceptance");
    expect(issuesIndex).not.toContain("Commit/PR -> Lesson");
    expect(issuesIndex).not.toContain("## Intent granularity");
    expect(issuesIndex).toContain("## Ownership contract");
    expect(issuesIndex).toContain("one issue ledger per deliverable");
    expect(tasksIndex).toContain("self-contained final-state artifact");
    expect(tasksIndex).toContain("objective, scope, constraints, acceptance, result, and evidence");
    expect(tasksIndex).not.toContain("draft");
    expect(tasksIndex).not.toContain("review round");
    expect(lessonsIndex).toContain("## Lesson strength");
    expect(lessonsIndex).toContain("MUST");
    expect(lessonsIndex).toContain("OBSERVED");
    expect(lessonsIndex).not.toContain("supersedes");
    expect(tasksIndex).toContain("# Tasks");
    expect(tasksIndex).not.toContain("# TASKS");
    expect(lessonsIndex).toContain("# Lessons");
    expect(lessonsIndex).not.toContain("# LESSONS LEARNED");
    expect(tools.size).toBe(0);
    expect(commands.has("context")).toBe(true);
    expect(commands.has("memory")).toBe(false);
    expect(commands.size).toBe(1);

    expect(commands.get("context").description).toBe("Show context usage");
    expect(hooks.has("tool_result")).toBe(false);
  });

  test("before_agent_start injects only the control-plane contract", async () => {
    const projectDir = makeProjectDir();
    const ctx = makeCtx(projectDir);
    const { hooks } = registerMemoryExtension();
    const sessionStartHandler = hooks.get("session_start");
    const beforeAgentStartHandler = hooks.get("before_agent_start");
    if (!sessionStartHandler) throw new Error("session_start handler was not registered");
    if (!beforeAgentStartHandler) throw new Error("before_agent_start handler was not registered");
    await sessionStartHandler({}, ctx);
    const memoryDir = projectMemoryDir(process.env.HOME!, projectDir);
    fs.appendFileSync(path.join(memoryDir, "MEMORY.md"), "\n- private-detail.md — do not inject\n", "utf8");

    const result = await beforeAgentStartHandler({ prompt: "", systemPrompt: "base" }, ctx);

    expect(result.systemPrompt).toContain("Core flow: Issue -> Task.");
    expect(result.systemPrompt).toContain("self-contained final-state artifact");
    expect(result.systemPrompt).toContain("normal read/edit/write tools");
    expect(result.systemPrompt).not.toContain("session task draft");
    expect(result.systemPrompt).not.toContain("private-detail.md");
  });

  test("session hooks stay inactive outside a git project", async () => {
    const nonProjectDir = makeNonProjectDir();
    const ctx = makeCtx(nonProjectDir);
    const { hooks } = registerMemoryExtension();
    const sessionStartHandler = hooks.get("session_start");
    const beforeAgentStartHandler = hooks.get("before_agent_start");
    if (!sessionStartHandler) throw new Error("session_start handler was not registered");
    if (!beforeAgentStartHandler) throw new Error("before_agent_start handler was not registered");

    await expect(sessionStartHandler({}, ctx)).resolves.toBeUndefined();
    expect(beforeAgentStartHandler({ prompt: "", systemPrompt: "base" }, ctx)).toBeUndefined();
    expect(fs.existsSync(path.join(process.env.HOME!, ".pi", "memory"))).toBe(false);
  });

});
