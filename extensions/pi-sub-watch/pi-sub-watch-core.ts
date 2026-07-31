/**
 * Core scan logic for pi-sub-watch: detect completed pi-sub runs.
 *
 * Pure and testable: scans a runs directory (as written by pi-sub.sh's
 * publish_status: `state\tvalue` in each run dir's `status` file) and calls
 * onCompleted exactly once per run that transitions to "complete".
 */

import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CompletedRun = {
  runId: string;
  exitCode: string;
};

export function scanRunsDir(
  runsDir: string,
  notified: Set<string>,
  onCompleted: (run: CompletedRun) => void,
): void {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || notified.has(entry.name)) continue;

    let status: string;
    try {
      status = readFileSync(join(runsDir, entry.name, "status"), "utf8");
    } catch {
      continue;
    }

    const [state, value] = status.split("\t");
    if (state?.trim() !== "complete") continue;

    notified.add(entry.name);
    onCompleted({ runId: entry.name, exitCode: value?.trim() || "?" });
  }
}

export function loadNotified(file: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
    }
  } catch {
    // missing or corrupt file: start empty
  }
  return new Set<string>();
}

export function saveNotified(file: string, notified: Set<string>): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify([...notified]));
  renameSync(temporary, file);
}

/**
 * Collect every run that is already in "complete" state. Used on first start
 * or upgrade from a pre-persistence version: those runs were announced (or
 * finished) before this extension existed, so they must be marked as notified
 * silently instead of being re-announced.
 */
export function collectCompletedRunIds(runsDir: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  scanRunsDir(runsDir, seen, (run) => {
    ids.push(run.runId);
  });
  return ids;
}
