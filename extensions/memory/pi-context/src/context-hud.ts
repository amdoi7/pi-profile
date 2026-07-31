/**
 * Render context dashboard HUD for /context statistics.
 * Takes both ContextBreakdown and HistoryMetrics.
 */

import type { ContextBreakdown, HistoryMetrics } from "./types.ts";
import { getUsageCategoryLines } from "./context-categories.ts";
import {
  formatCategoryColumns,
  measureCategoryColumns,
} from "./context-category-layout.ts";
import {
  formatEstimatedUsageLine,
  formatUsageAttributionLine,
} from "./context-display.ts";
import { formatSymbolCell } from "./context-symbols.ts";
import { formatTokens } from "./utils.ts";

export function renderContextHud(
  breakdown: ContextBreakdown,
  history: HistoryMetrics
): string {
  // Usage line — prefer the real measured total whenever the session
  // has one, regardless of calibration drift. Confidence still shows
  // below so the delta isn't hidden, but the headline number reflects
  // the model's own accounting.
  let usageStr: string;
  if (breakdown.measuredTotal !== null) {
    const percent =
      ((breakdown.measuredTotal / breakdown.contextWindow) * 100).toFixed(1);
    usageStr = `${percent}% (${breakdown.measuredTotal}/${breakdown.contextWindow})`;
  } else {
    usageStr = `? (${formatTokens(breakdown.contextWindow)} window)`;
  }

  const estimatedUsageLine = formatEstimatedUsageLine(breakdown);
  const attributionLine = formatUsageAttributionLine(breakdown);

  // Available line
  const availStr = formatTokens(breakdown.available);

  // Build HUD lines
  const lines = [
    `[Context Dashboard]`,
    `• Usage:          ${usageStr}`,
    `• Available:      ${availStr}`,
    `• Confidence:     ${breakdown.confidence}`,
  ];

  if (estimatedUsageLine) {
    lines.push(`• Estimated split:${estimatedUsageLine.replace(/^Estimated split\s*/, " ")}`);
  }

  if (attributionLine) {
    lines.push(`• Attribution:    ${attributionLine}`);
  }

  // Delta if available
  if (breakdown.delta !== null) {
    const deltaSign = breakdown.delta > 0 ? "+" : "";
    const deltaDesc =
      breakdown.delta > 0 ? "unattributed" : "overestimate";
    lines.push(`• Delta:          ${deltaSign}${breakdown.delta} (${deltaDesc})`);
  }

  lines.push(`• Estimated usage by category:`);
  const categories = getUsageCategoryLines(breakdown);
  const categoryWidths = measureCategoryColumns(categories);
  for (const category of categories) {
    const columns = formatCategoryColumns(category, categoryWidths);
    lines.push(`  ${formatSymbolCell(category.icon)} ${columns.label} ${columns.value} (${columns.percent})`);
  }

  const pushMetric = (label: string, value: string) => {
    lines.push(`• ${`${label}:`.padEnd(14)} ${value}`);
  };

  // Message count
  pushMetric(
    "Messages",
    String(breakdown.metadata.buildSessionContextMessageCount),
  );

  // History metrics
  pushMetric(
    "Segment",
    `${history.tagDistance} steps since '${history.nearestTag || "root"}'`,
  );

  if (history.summaryCount > 0) {
    pushMetric("Summaries", String(history.summaryCount));
  }
  if (history.compactionCount > 0) {
    pushMetric("Compactions", String(history.compactionCount));
  }

  lines.push(`---------------------------------------------------`);

  return lines.join("\n");
}
