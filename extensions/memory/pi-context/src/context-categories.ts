import type { ContextBreakdown } from "./types.ts";

export interface UsageCategoryLine {
  label: string;
  value: number;
  percent: number;
  color: string;
  icon: "⛁" | "⛶" | "⛝";
}

export function getUsageCategoryLines(
  breakdown: ContextBreakdown,
): UsageCategoryLine[] {
  const percent = (value: number) =>
    (value / breakdown.contextWindow) * 100;

  const lines: UsageCategoryLine[] = [
    {
      label: "System prompt",
      value: breakdown.categoryBreakdown.systemPrompt,
      percent: percent(breakdown.categoryBreakdown.systemPrompt),
      color: "dim",
      icon: "⛁",
    },
    {
      label: "System tools",
      value: breakdown.categoryBreakdown.systemTools,
      percent: percent(breakdown.categoryBreakdown.systemTools),
      color: "muted",
      icon: "⛁",
    },
    {
      label: "Skills",
      value: breakdown.categoryBreakdown.skills,
      percent: percent(breakdown.categoryBreakdown.skills),
      color: "success",
      icon: "⛁",
    },
    {
      label: "Memory files",
      value: breakdown.categoryBreakdown.memoryFiles,
      percent: percent(breakdown.categoryBreakdown.memoryFiles),
      color: "warning",
      icon: "⛁",
    },
    {
      label: "Messages",
      value: breakdown.categoryBreakdown.messages,
      percent: percent(breakdown.categoryBreakdown.messages),
      color: "accent",
      icon: "⛁",
    },
  ];

  lines.push({
    label: "Free space",
    value: breakdown.categoryBreakdown.freeSpace,
    percent: percent(breakdown.categoryBreakdown.freeSpace),
    color: "borderMuted",
    icon: "⛶",
  });

  if (breakdown.categoryBreakdown.autocompactBuffer > 0) {
    lines.push({
      label: "Autocompact buffer",
      value: breakdown.categoryBreakdown.autocompactBuffer,
      percent: percent(breakdown.categoryBreakdown.autocompactBuffer),
      color: "mdQuote",
      icon: "⛝",
    });
  }

  return lines;
}
