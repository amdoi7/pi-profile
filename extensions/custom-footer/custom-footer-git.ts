import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";

const GIT_STATUS_TTL_MS = 2_000;

export type GitStatusSnapshot = {
  branch: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  /** 进行中 git 操作标签（REBASING 3/5 / MERGING …）；无操作时不出现。 */
  gitStateLabel?: string;
};

export type GitRepoMtimes = {
  headMtimeMs: number;
  indexMtimeMs: number;
  /** 操作标记文件 mtime（缺失 = -1）：这些文件变化时缓存必须失效，
   * 否则 merge --quit 之类的操作会让状态标签滞留。 */
  mergeHeadMtimeMs: number;
  cherryPickHeadMtimeMs: number;
  revertHeadMtimeMs: number;
  bisectLogMtimeMs: number;
  rebaseMsgnumMtimeMs: number;
  rebaseEndMtimeMs: number;
};

type GitStatusCacheDeps = {
  getNowMs(): number;
  getRepoMtimes(gitDir: string): GitRepoMtimes;
  readStatus(cwd: string, gitDir: string): GitStatusSnapshot | null;
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

/** 全 -1 的 mtime 集：非仓库 cwd 的占位（所有探测文件都不存在）。 */
const NO_MTIMES: GitRepoMtimes = {
  headMtimeMs: -1,
  indexMtimeMs: -1,
  mergeHeadMtimeMs: -1,
  cherryPickHeadMtimeMs: -1,
  revertHeadMtimeMs: -1,
  bisectLogMtimeMs: -1,
  rebaseMsgnumMtimeMs: -1,
  rebaseEndMtimeMs: -1,
};

function sameMtimes(a: GitRepoMtimes, b: GitRepoMtimes): boolean {
  return (
    a.headMtimeMs === b.headMtimeMs &&
    a.indexMtimeMs === b.indexMtimeMs &&
    a.mergeHeadMtimeMs === b.mergeHeadMtimeMs &&
    a.cherryPickHeadMtimeMs === b.cherryPickHeadMtimeMs &&
    a.revertHeadMtimeMs === b.revertHeadMtimeMs &&
    a.bisectLogMtimeMs === b.bisectLogMtimeMs &&
    a.rebaseMsgnumMtimeMs === b.rebaseMsgnumMtimeMs &&
    a.rebaseEndMtimeMs === b.rebaseEndMtimeMs
  );
}

function getDefaultGitRepoMtimes(gitDir: string): GitRepoMtimes {
  return {
    headMtimeMs: getFileMtimeMs(resolve(gitDir, "HEAD")),
    indexMtimeMs: getFileMtimeMs(resolve(gitDir, "index")),
    mergeHeadMtimeMs: getFileMtimeMs(resolve(gitDir, "MERGE_HEAD")),
    cherryPickHeadMtimeMs: getFileMtimeMs(resolve(gitDir, "CHERRY_PICK_HEAD")),
    revertHeadMtimeMs: getFileMtimeMs(resolve(gitDir, "REVERT_HEAD")),
    bisectLogMtimeMs: getFileMtimeMs(resolve(gitDir, "BISECT_LOG")),
    rebaseMsgnumMtimeMs: getFileMtimeMs(resolve(gitDir, "rebase-merge", "msgnum")),
    rebaseEndMtimeMs: getFileMtimeMs(resolve(gitDir, "rebase-merge", "end")),
  };
}

function getDefaultGitStatus(cwd: string, gitDir: string): GitStatusSnapshot | null {
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

  return { branch, dirtyCount, ahead, behind, ...detectGitState(resolveGitStatePaths(gitDir)) };
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
        if (sameMtimes(mtimes, cached.mtimes)) {
          return cached.status;
        }
      }
    }

    const gitDir = resolveGitDir(cwd);
    if (gitDir === null) {
      cache.set(cwd, {
        expiresAtMs: nowMs + GIT_STATUS_TTL_MS,
        gitDir: null,
        mtimes: NO_MTIMES,
        status: null,
      });
      return null;
    }

    const mtimes = getRepoMtimes(gitDir);
    const status = readStatus(cwd, gitDir);
    cache.set(cwd, {
      expiresAtMs: nowMs + GIT_STATUS_TTL_MS,
      gitDir,
      mtimes,
      status,
    });
    return status;
  };
}

// --- git operation state (rebase/merge/cherry-pick/revert/bisect) ----------

export type GitStatePaths = {
  rebaseMerge?: string;
  rebaseApply?: string;
  mergeHead?: string;
  cherryPickHead?: string;
  revertHead?: string;
  bisectLog?: string;
  rebaseMsgnum?: string;
  rebaseEnd?: string;
};

function readOptionalText(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * 进行中 git 操作检测（zentui/Starship 优先级）：rebase > merge >
 * cherry-pick > revert > bisect；rebase 进度来自 rebase 目录 msgnum/end。
 */
export function detectGitState(paths: GitStatePaths): { gitStateLabel?: string } {
  if (paths.rebaseMerge || paths.rebaseApply) {
    const msgnum = readOptionalText(paths.rebaseMsgnum);
    const end = readOptionalText(paths.rebaseEnd);
    if (msgnum && end) return { gitStateLabel: `REBASING ${msgnum}/${end}` };
    return { gitStateLabel: "REBASING" };
  }
  if (paths.mergeHead) return { gitStateLabel: "MERGING" };
  if (paths.cherryPickHead) return { gitStateLabel: "CHERRY-PICKING" };
  if (paths.revertHead) return { gitStateLabel: "REVERTING" };
  if (paths.bisectLog) return { gitStateLabel: "BISECTING" };
  return {};
}

/** 操作标记文件都在 gitDir 内（worktree 场景 gitDir 即 worktree 私有目录）。 */
function resolveGitStatePaths(gitDir: string): GitStatePaths {
  const existing = (name: string): string | undefined => {
    const p = resolve(gitDir, name);
    return existsSync(p) ? p : undefined;
  };
  const rebaseDir = existing("rebase-merge") ?? existing("rebase-apply");
  return {
    rebaseMerge: existing("rebase-merge"),
    rebaseApply: existing("rebase-apply"),
    mergeHead: existing("MERGE_HEAD"),
    cherryPickHead: existing("CHERRY_PICK_HEAD"),
    revertHead: existing("REVERT_HEAD"),
    bisectLog: existing("BISECT_LOG"),
    rebaseMsgnum: rebaseDir ? resolve(rebaseDir, "msgnum") : undefined,
    rebaseEnd: rebaseDir ? resolve(rebaseDir, "end") : undefined,
  };
}

// --- git dir watcher（外部 git 变化 → 即时重渲染）---------------------------

const RELEVANT_GIT_FILES = new Set([
  "index",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
]);

type WatchHandle = { close(): void };

type GitWatcherDeps = {
  resolveGitDir(cwd: string): string | null;
  watch(dir: string, listener: (event: string, filename: string | null) => void): WatchHandle;
};

/**
 * 监听 gitDir 目录内影响 footer 显示的文件（index/MERGE_HEAD/…）。
 *
 * 必须 watch 目录而非单个文件：git 写 index 是 rename 语义
 * （index.lock → index），watch 文件 inode 会丢事件。branch/HEAD 变化
 * 由 pi 的 onBranchChange hook 覆盖，这里不管。事件丢失时静默降级——
 * 30s 轮询兜底仍在，watch 只是把 30s 滞后变成即时。
 */
export function createGitWatcher(deps: Partial<GitWatcherDeps> = {}) {
  const resolveGitDir = deps.resolveGitDir ?? getDefaultGitDir;
  const watchDir = deps.watch ?? ((dir: string, listener: (event: string, filename: string | null) => void) => watch(dir, listener));
  return (cwd: string, onChange: () => void): (() => void) => {
    const gitDir = resolveGitDir(cwd);
    if (gitDir === null) return () => {};
    let handle: WatchHandle | undefined;
    try {
      handle = watchDir(gitDir, (event, filename) => {
        if (filename !== null && !RELEVANT_GIT_FILES.has(filename)) return;
        onChange();
      });
    } catch {
      return () => {};
    }
    return () => handle?.close();
  };
}
