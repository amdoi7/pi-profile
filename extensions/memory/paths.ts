import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MISSING_GIT_ROOT_PREFIX = "memory extension requires a git project root; none found above ";

export function findProjectRoot(startCwd: string): string {
  let current = resolve(startCwd);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      throw new Error(`${MISSING_GIT_ROOT_PREFIX}${startCwd}`);
    }
    current = parent;
  }
}

export function tryFindProjectRoot(startCwd: string): string | undefined {
  try {
    return findProjectRoot(startCwd);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(MISSING_GIT_ROOT_PREFIX)) {
      return undefined;
    }
    throw error;
  }
}

function flattenProjectRoot(root: string): string {
  return resolve(root)
    .replace(/^[/\\]+/, "")
    .replace(/[/\\:]/g, "-");
}

function resolvePiHome(): string {
  return process.env.HOME || homedir();
}

export function resolveProjectMemoryDir(cwd: string): string {
  return join(resolvePiHome(), ".pi", "memory", flattenProjectRoot(findProjectRoot(cwd)));
}

export function tryResolveProjectMemoryDir(cwd: string): string | undefined {
  const root = tryFindProjectRoot(cwd);
  if (root === undefined) {
    return undefined;
  }
  return join(resolvePiHome(), ".pi", "memory", flattenProjectRoot(root));
}
