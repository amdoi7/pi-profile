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
  test("session_start scaffolds only the issues directory and lessons.md", async () => {
    const projectDir = makeProjectDir();
    const ctx = makeCtx(projectDir);
    const { hooks } = registerMemoryExtension();
    const sessionStartHandler = hooks.get("session_start");
    if (!sessionStartHandler) throw new Error("session_start handler was not registered");

    await sessionStartHandler({}, ctx);

    const memoryDir = projectMemoryDir(process.env.HOME!, projectDir);
    expect(fs.existsSync(memoryDir)).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "issues"))).toBe(true);
    expect(fs.statSync(path.join(memoryDir, "issues")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "lessons.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "MEMORY.md"))).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "issues.md"))).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "tasks.md"))).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "tasks"))).toBe(false);

    const lessons = fs.readFileSync(path.join(memoryDir, "lessons.md"), "utf8");
    expect(lessons).toContain("# Lessons");
    expect(lessons).toContain("MUST");
    expect(lessons).toContain("OBSERVED");
    expect(lessons).not.toContain("# LESSONS LEARNED");
  });

  test("session_start leaves existing memory files untouched", async () => {
    const projectDir = makeProjectDir();
    const memoryDir = projectMemoryDir(process.env.HOME!, projectDir);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "issues"));
    fs.writeFileSync(path.join(memoryDir, "lessons.md"), "# Lessons\n\ncustom\n", "utf8");

    const ctx = makeCtx(projectDir);
    const { hooks } = registerMemoryExtension();
    const sessionStartHandler = hooks.get("session_start");
    if (!sessionStartHandler) throw new Error("session_start handler was not registered");

    await sessionStartHandler({}, ctx);

    expect(fs.readFileSync(path.join(memoryDir, "lessons.md"), "utf8")).toBe("# Lessons\n\ncustom\n");
  });

  test("before_agent_start injects the compact memory contract", async () => {
    const projectDir = makeProjectDir();
    const ctx = makeCtx(projectDir);
    const { hooks } = registerMemoryExtension();
    const sessionStartHandler = hooks.get("session_start");
    const beforeAgentStartHandler = hooks.get("before_agent_start");
    if (!sessionStartHandler) throw new Error("session_start handler was not registered");
    if (!beforeAgentStartHandler) throw new Error("before_agent_start handler was not registered");
    await sessionStartHandler({}, ctx);

    const result = await beforeAgentStartHandler({ prompt: "", systemPrompt: "base" }, ctx);

    expect(result.systemPrompt).toContain(projectMemoryDir(process.env.HOME!, projectDir));
    expect(result.systemPrompt).toContain("issues/");
    expect(result.systemPrompt).toContain("lessons.md");
    expect(result.systemPrompt).toContain("Before acting");
    expect(result.systemPrompt).toContain("While acting");
    expect(result.systemPrompt).toContain("After finishing");
    expect(result.systemPrompt).toContain("only when it changes future behavior");
    expect(result.systemPrompt).toMatch(/SKILL\.md/);
    expect(result.systemPrompt).toContain(".pi/agent/extensions/memory/skills/project-memory/SKILL.md");
    expect(result.systemPrompt).not.toContain("MEMORY.md");
    expect(result.systemPrompt).not.toContain("tasks.md");
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

  test("memory registers no tools or commands", () => {
    const { tools, commands } = registerMemoryExtension();
    expect(tools.size).toBe(0);
    expect(commands.size).toBe(0);
  });
});
