/**
 * History topology analysis.
 * Answers: "Is your context management structure healthy?"
 * NOT involved in token breakdown — that's a different domain.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HistoryMetrics } from "./types.ts";

/**
 * Analyze branch structure and metadata.
 * Separate from working context analysis.
 */
export function analyzeHistory(sm: SessionManager): HistoryMetrics {
  const branch = sm.getBranch();

  // Find distance to nearest tag
  let tagDistance = 0;
  let nearestTag: string | null = null;

  for (let i = branch.length - 1; i >= 0; i--) {
    const label = sm.getLabel(branch[i].id);
    if (label) {
      nearestTag = label;
      break;
    }
    tagDistance++;
  }

  // Count summaries and compactions
  const summaryCount = branch.filter((e) => e.type === "branch_summary").length;
  const compactionCount = branch.filter((e) => e.type === "compaction").length;

  return {
    branchDepth: branch.length,
    tagDistance,
    nearestTag,
    summaryCount,
    compactionCount,
  };
}
