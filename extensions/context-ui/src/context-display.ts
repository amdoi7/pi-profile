import type { ContextBreakdown } from "./types.ts";

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${stripTrailingZero(millions.toFixed(1))}M`;
  }

  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${stripTrailingZero(thousands.toFixed(1))}k`;
  }

  return value.toString();
}

function stripTrailingZero(value: string): string {
  return value.replace(/\.0$/, "");
}

export function formatContextWindowLabel(contextWindow: number): string {
  return `${formatCompactNumber(contextWindow)} context`;
}

export function formatUsageHeadline(breakdown: ContextBreakdown): string {
  if (breakdown.measuredTotal === null) {
    return `?/${formatCompactNumber(breakdown.contextWindow)} tokens`;
  }

  const percent = ((breakdown.measuredTotal / breakdown.contextWindow) * 100).toFixed(1);
  return `${formatCompactNumber(breakdown.measuredTotal)}/${formatCompactNumber(breakdown.contextWindow)} tokens (${stripTrailingZero(percent)}%)`;
}

export function formatEstimatedUsageLine(
  breakdown: ContextBreakdown,
): string | null {
  if (breakdown.measuredTotal !== null) {
    return null;
  }

  const percent = ((breakdown.estimatedTotal / breakdown.contextWindow) * 100).toFixed(1);
  return `Estimated split ${formatCompactNumber(breakdown.estimatedTotal)}/${formatCompactNumber(breakdown.contextWindow)} tokens (${stripTrailingZero(percent)}%)`;
}

export function formatUsageAttributionLine(
  breakdown: ContextBreakdown,
): string | null {
  if (breakdown.measuredTotal === null) {
    return "Exact usage is unknown after compaction until the next response. Footer and /context show ?; section totals below are estimated.";
  }

  if (breakdown.delta === null || breakdown.delta === 0) {
    return null;
  }

  if (breakdown.delta > 0) {
    return `Total matches footer. Per-section split is estimated; ${formatCompactNumber(breakdown.delta)} tokens remain unattributed.`;
  }

  return `Total matches footer. Per-section split is estimated and currently overcounts by ${formatCompactNumber(Math.abs(breakdown.delta))} tokens.`;
}

export function formatModelSummaryLine(
  modelName: string,
  breakdown: ContextBreakdown,
): string {
  return `${modelName} (${formatContextWindowLabel(breakdown.contextWindow)})  ${formatUsageHeadline(breakdown)}`;
}
