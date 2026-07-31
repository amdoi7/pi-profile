import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildDefaultEntrypointContent,
  buildDefaultIssueIndexContent,
  buildDefaultLessonsContent,
  buildDefaultTaskIndexContent,
  ENTRYPOINT_HEADER,
  ENTRYPOINT_NAME,
  ISSUE_DETAILS_DIR,
  MEMORY_SURFACES,
  TASK_DETAILS_DIR,
} from "./memory-contract.ts";
import { resolveProjectMemoryDir } from "./paths.ts";

export type MemoryPromptTemplateValues = {
  memoryDir: string;
  sessionsDir: string;
};

async function ensureFileIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

export async function ensureMemoryDir(cwd: string): Promise<void> {
  const memoryDir = resolveProjectMemoryDir(cwd);
  await mkdir(memoryDir, { recursive: true });
  await mkdir(join(memoryDir, ISSUE_DETAILS_DIR), { recursive: true });
  await mkdir(join(memoryDir, TASK_DETAILS_DIR), { recursive: true });

  const indexPath = join(memoryDir, ENTRYPOINT_NAME);
  await ensureFileIfMissing(join(memoryDir, MEMORY_SURFACES.issues.name), buildDefaultIssueIndexContent());
  await ensureFileIfMissing(join(memoryDir, MEMORY_SURFACES.tasks.name), buildDefaultTaskIndexContent());
  await ensureFileIfMissing(join(memoryDir, MEMORY_SURFACES.lessons.name), buildDefaultLessonsContent());
  await ensureFileIfMissing(indexPath, buildDefaultEntrypointContent(ENTRYPOINT_HEADER));
}

export function buildPromptTemplateValues(ctx: ExtensionContext): MemoryPromptTemplateValues {
  return {
    memoryDir: resolveProjectMemoryDir(ctx.cwd),
    sessionsDir: ctx.sessionManager.getSessionDir(),
  };
}
