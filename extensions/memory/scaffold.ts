import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildDefaultLessonsContent,
  ISSUE_DETAILS_DIR,
  LESSONS_FILE_NAME,
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
  await ensureFileIfMissing(join(memoryDir, LESSONS_FILE_NAME), buildDefaultLessonsContent());
}

export function buildPromptTemplateValues(ctx: ExtensionContext): MemoryPromptTemplateValues {
  return {
    memoryDir: resolveProjectMemoryDir(ctx.cwd),
    sessionsDir: ctx.sessionManager.getSessionDir(),
  };
}
