import { closeSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type CompletedRun = {
  runId: string;
  exitCode: string;
};

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function claimNotification(runDir: string): string | undefined {
  const claimPath = join(runDir, "notification-claimed");
  try {
    closeSync(openSync(claimPath, "wx", 0o600));
    return claimPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

function releaseFailedClaim(claimPath: string, deliveryError: unknown): never {
  try {
    unlinkSync(claimPath);
  } catch (cleanupError) {
    throw new AggregateError([deliveryError, cleanupError], "pi-sub notification delivery and claim cleanup failed");
  }
  throw deliveryError;
}

export function scanRunsDir(
  runsDir: string,
  ownerSessionId: string,
  onCompleted: (run: CompletedRun) => void,
): void {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;

    const runDir = join(runsDir, entry.name);
    if (readTrimmed(join(runDir, "owner-session-id")) !== ownerSessionId) continue;

    const status = readTrimmed(join(runDir, "status"));
    if (status === undefined) continue;
    const [state, exitCode] = status.split("\t");
    if (state !== "complete" || !/^[0-9]+$/.test(exitCode ?? "") || Number(exitCode) > 255) continue;

    const claimPath = claimNotification(runDir);
    if (claimPath === undefined) continue;
    try {
      onCompleted({ runId: entry.name, exitCode });
    } catch (error) {
      releaseFailedClaim(claimPath, error);
    }
  }
}
