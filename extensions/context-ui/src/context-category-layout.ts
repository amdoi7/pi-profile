import type { UsageCategoryLine } from "./context-categories.ts";
import { formatTokens } from "./utils.ts";

export interface CategoryColumnWidths {
  label: number;
  value: number;
  percent: number;
}

export interface FormattedCategoryColumns {
  label: string;
  value: string;
  percent: string;
}

export function formatCategoryPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export function measureCategoryColumns(
  categories: UsageCategoryLine[],
): CategoryColumnWidths {
  const labelWidth = Math.max(
    ...categories.map((category) => `${category.label}:`.length),
    0,
  );
  const valueWidth = Math.max(
    ...categories.map((category) => formatTokens(category.value).length),
    0,
  );
  const percentWidth = Math.max(
    ...categories.map((category) => formatCategoryPercent(category.percent).length),
    0,
  );

  return {
    label: labelWidth,
    value: valueWidth,
    percent: percentWidth,
  };
}

export function formatCategoryColumns(
  category: UsageCategoryLine,
  widths: CategoryColumnWidths,
): FormattedCategoryColumns {
  return {
    label: `${category.label}:`.padEnd(widths.label),
    value: formatTokens(category.value).padStart(widths.value),
    percent: formatCategoryPercent(category.percent).padStart(widths.percent),
  };
}
