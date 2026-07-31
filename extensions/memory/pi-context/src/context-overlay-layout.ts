import { formatBranchSummaryLine } from "./context-branch-summary.ts";
import {
  formatEstimatedUsageLine,
  formatModelSummaryLine,
  formatUsageAttributionLine,
} from "./context-display.ts";
import type { ContextBreakdown, HistoryMetrics } from "./types.ts";

export function buildOverlayHeaderLines(
  modelName: string,
  breakdown: ContextBreakdown,
  history: HistoryMetrics,
): string[] {
  const estimatedUsageLine = formatEstimatedUsageLine(breakdown);
  const attributionLine = formatUsageAttributionLine(breakdown);

  return [
    formatModelSummaryLine(modelName, breakdown),
    ...(estimatedUsageLine ? [estimatedUsageLine] : []),
    ...(attributionLine ? [attributionLine] : []),
    formatBranchSummaryLine(
      history,
      breakdown.metadata.buildSessionContextMessageCount,
    ),
  ];
}
