import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ENTRYPOINT_NAME } from "./memory-contract.ts";

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

export function resolveProjectMemoryIndexPath(cwd: string): string {
  return join(resolveProjectMemoryDir(cwd), ENTRYPOINT_NAME);
}

export function tryResolveProjectMemoryIndexPath(cwd: string): string | undefined {
  const memoryDir = tryResolveProjectMemoryDir(cwd);
  if (memoryDir === undefined) {
    return undefined;
  }
  return join(memoryDir, ENTRYPOINT_NAME);
}

export function isWithinProjectMemoryDir(cwd: string, inputPath: string): boolean {
  const memoryDir = tryResolveProjectMemoryDir(cwd);
  if (memoryDir === undefined) {
    return false;
  }
  const absolutePath = resolve(cwd, inputPath);
  return absolutePath === memoryDir || absolutePath.startsWith(`${memoryDir}${sep}`);
}

export function isProjectMemoryEntrypoint(cwd: string, inputPath: string): boolean {
  const indexPath = tryResolveProjectMemoryIndexPath(cwd);
  if (indexPath === undefined) {
    return false;
  }
  return resolve(cwd, inputPath) === indexPath;
}
