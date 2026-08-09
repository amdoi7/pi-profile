import type { ContextBreakdown } from "./types.ts";

export interface DetailItem {
  label: string;
  tokens: number;
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 1) {
    return "…";
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, headLength)}…${text.slice(text.length - tailLength)}`;
}

function appendOverheadItem(
  items: DetailItem[],
  bucketTotal: number,
  label: string,
  bucketName: string,
): DetailItem[] {
  const detailTokenTotal = items.reduce((sum, item) => sum + item.tokens, 0);
  const overheadTokens = bucketTotal - detailTokenTotal;
  if (overheadTokens < 0) {
    throw new Error(
      `${bucketName} detail tokens exceed the bucket total (${detailTokenTotal} > ${bucketTotal}).`,
    );
  }
  if (overheadTokens === 0) {
    return items;
  }

  return [
    ...items,
    {
      label,
      tokens: overheadTokens,
    },
  ];
}

export function getMemoryFileDetailItems(
  breakdown: ContextBreakdown,
  maxLabelLength = 64,
): DetailItem[] {
  const files = breakdown.details?.memoryFiles ?? [];
  const items = files.map((file) => ({
    label: truncateMiddle(file.path, maxLabelLength),
    tokens: file.tokens,
  }));

  return appendOverheadItem(items, breakdown.buckets.memory, "Prompt wrapper", "Memory");
}

export function getSkillDetailItems(
  breakdown: ContextBreakdown,
  maxLabelLength = 64,
): DetailItem[] {
  const skills = breakdown.details?.skills ?? [];
  const items = skills.map((skill) => ({
    label: truncateMiddle(skill.name, maxLabelLength),
    tokens: skill.tokens,
  }));

  return appendOverheadItem(items, breakdown.buckets.skills, "Prompt wrapper", "Skills");
}

export function getSystemToolDetailItems(
  breakdown: ContextBreakdown,
  maxLabelLength = 64,
): DetailItem[] {
  const tools = breakdown.details?.systemTools ?? [];
  const items = tools.map((tool) => ({
    label: truncateMiddle(tool.name, maxLabelLength),
    tokens: tool.tokens,
  }));

  return appendOverheadItem(items, breakdown.buckets.systemTools, "Payload wrapper", "System tools");
}
