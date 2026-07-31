import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const GIT_STATUS_TTL_MS = 2_000;

export type GitStatusSnapshot = {
  branch: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
};

export type GitRepoMtimes = {
  headMtimeMs: number;
  indexMtimeMs: number;
};

type GitStatusCacheDeps = {
  getNowMs(): number;
  getRepoMtimes(gitDir: string): GitRepoMtimes;
  readStatus(cwd: string): GitStatusSnapshot | null;
  resolveGitDir(cwd: string): string | null;
};

type GitStatusCacheEntry = {
  expiresAtMs: number;
  gitDir: string | null;
  mtimes: GitRepoMtimes;
  status: GitStatusSnapshot | null;
};

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function getFileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function getDefaultGitRepoMtimes(gitDir: string): GitRepoMtimes {
  return {
    headMtimeMs: getFileMtimeMs(resolve(gitDir, "HEAD")),
    indexMtimeMs: getFileMtimeMs(resolve(gitDir, "index")),
  };
}

function getDefaultGitStatus(cwd: string): GitStatusSnapshot | null {
  let branch = "";
  try {
    branch = runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    try {
      branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      return null;
    }
  }

  if (branch.length === 0 || branch === "-") {
    return null;
  }

  let dirtyCount = 0;
  try {
    const porcelain = runGit(cwd, ["status", "--porcelain"]);
    dirtyCount = porcelain.length === 0 ? 0 : porcelain.split("\n").length;
  } catch {
    dirtyCount = 0;
  }

  let ahead = 0;
  let behind = 0;
  try {
    ahead = Number.parseInt(runGit(cwd, ["rev-list", "--count", "@{u}..HEAD"]), 10) || 0;
    behind = Number.parseInt(runGit(cwd, ["rev-list", "--count", "HEAD..@{u}"]), 10) || 0;
  } catch {
    ahead = 0;
    behind = 0;
  }

  return { branch, dirtyCount, ahead, behind };
}

function getDefaultGitDir(cwd: string): string | null {
  try {
    const gitDir = runGit(cwd, ["rev-parse", "--git-dir"]);
    return resolve(cwd, gitDir);
  } catch {
    return null;
  }
}

export function createGitStatusCache(deps: Partial<GitStatusCacheDeps> = {}) {
  const getNowMs = deps.getNowMs ?? (() => Date.now());
  const getRepoMtimes = deps.getRepoMtimes ?? getDefaultGitRepoMtimes;
  const readStatus = deps.readStatus ?? getDefaultGitStatus;
  const resolveGitDir = deps.resolveGitDir ?? getDefaultGitDir;
  const cache = new Map<string, GitStatusCacheEntry>();

  return (cwd: string): GitStatusSnapshot | null => {
    const nowMs = getNowMs();
    const cached = cache.get(cwd);
    if (cached) {
      if (cached.gitDir === null && cached.expiresAtMs > nowMs) {
        return null;
      }
      if (cached.gitDir !== null && cached.expiresAtMs > nowMs) {
        const mtimes = getRepoMtimes(cached.gitDir);
        if (
          mtimes.headMtimeMs === cached.mtimes.headMtimeMs &&
          mtimes.indexMtimeMs === cached.mtimes.indexMtimeMs
        ) {
          return cached.status;
        }
      }
    }

    const gitDir = resolveGitDir(cwd);
    if (gitDir === null) {
      cache.set(cwd, {
        expiresAtMs: nowMs + GIT_STATUS_TTL_MS,
        gitDir: null,
        mtimes: { headMtimeMs: -1, indexMtimeMs: -1 },
        status: null,
      });
      return null;
    }

    const mtimes = getRepoMtimes(gitDir);
    const status = readStatus(cwd);
    cache.set(cwd, {
      expiresAtMs: nowMs + GIT_STATUS_TTL_MS,
      gitDir,
      mtimes,
      status,
    });
    return status;
  };
}
