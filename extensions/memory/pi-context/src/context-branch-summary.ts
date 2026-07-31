import type { HistoryMetrics } from "./types.ts";

export function formatBranchSummaryLine(
  history: HistoryMetrics,
  messageCount: number,
): string {
  const parts = [
    `Messages ${messageCount}`,
    `Segment ${history.tagDistance} steps since '${history.nearestTag || "root"}'`,
  ];

  if (history.summaryCount > 0) {
    parts.push(`Summaries ${history.summaryCount}`);
  }
  if (history.compactionCount > 0) {
    parts.push(`Compactions ${history.compactionCount}`);
  }

  return `Branch: ${parts.join(" · ")}`;
}
