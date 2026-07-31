/**
 * Render context breakdown to /context overlay.
 * Pure rendering layer — takes ContextBreakdown, produces UI.
 */

import {
  type ExtensionCommandContext,
  DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextBreakdown, HistoryMetrics } from "./types.ts";
import { getUsageCategoryLines } from "./context-categories.ts";
import {
  formatCategoryColumns,
  measureCategoryColumns,
} from "./context-category-layout.ts";
import { buildOverlayHeaderLines } from "./context-overlay-layout.ts";
import {
  getMemoryFileDetailItems,
  getSkillDetailItems,
  getSystemToolDetailItems,
} from "./context-detail-sections.ts";
import { buildContextGridBlocks } from "./context-grid.ts";
import { formatSymbolCell } from "./context-symbols.ts";
import { formatTokens } from "./utils.ts";

const DETAIL_SECTION_INDENT = "  ";
const DETAIL_SECTION_GAP = "  ";

function buildDetailSectionLines(
  title: string,
  items: Array<{ label: string; tokens: number }>,
  emptyText: string,
): string[] {
  const lines = [title];
  if (items.length === 0) {
    lines.push(`  └ ${emptyText}`);
    return lines;
  }

  for (const item of items) {
    lines.push(`  └ ${item.label}: ${formatTokens(item.tokens)} tokens`);
  }
  return lines;
}

export function buildDetailColumns(
  breakdown: ContextBreakdown,
  maxLabelLength = 56,
): { left: string[]; right: string[] } {
  const systemToolItems = getSystemToolDetailItems(breakdown, maxLabelLength);
  const memoryItems = getMemoryFileDetailItems(breakdown, maxLabelLength);
  const skillItems = getSkillDetailItems(breakdown, maxLabelLength);

  return {
    left: buildDetailSectionLines("System tools", systemToolItems, "none active"),
    right: [
      ...buildDetailSectionLines("Memory files", memoryItems, "none loaded"),
      "",
      ...buildDetailSectionLines("Skills", skillItems, "none loaded"),
    ],
  };
}

function padToVisibleWidth(text: string, width: number): string {
  const paddingWidth = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(paddingWidth)}`;
}

function computeDetailColumnWidths(
  columns: { left: string[]; right: string[] },
  totalWidth: number,
): { leftWidth: number; rightWidth: number } {
  const indentWidth = visibleWidth(DETAIL_SECTION_INDENT);
  const gapWidth = visibleWidth(DETAIL_SECTION_GAP);
  const minColumnWidth = 18;
  const usableWidth = Math.max(minColumnWidth * 2 + gapWidth, totalWidth - indentWidth);

  const desiredLeft = columns.left.reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
  const desiredRight = columns.right.reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
  if (desiredLeft + gapWidth + desiredRight <= usableWidth) {
    return {
      leftWidth: desiredLeft,
      rightWidth: usableWidth - gapWidth - desiredLeft,
    };
  }

  const distributableWidth = usableWidth - gapWidth - minColumnWidth * 2;
  if (distributableWidth <= 0) {
    const leftWidth = Math.max(minColumnWidth, Math.floor((usableWidth - gapWidth) / 2));
    return {
      leftWidth,
      rightWidth: Math.max(minColumnWidth, usableWidth - gapWidth - leftWidth),
    };
  }

  const desiredLeftExtra = Math.max(0, desiredLeft - minColumnWidth);
  const desiredRightExtra = Math.max(0, desiredRight - minColumnWidth);
  const totalDesiredExtra = desiredLeftExtra + desiredRightExtra;
  if (totalDesiredExtra === 0) {
    return {
      leftWidth: minColumnWidth,
      rightWidth: minColumnWidth,
    };
  }

  let leftExtra = Math.round((distributableWidth * desiredLeftExtra) / totalDesiredExtra);
  let rightExtra = distributableWidth - leftExtra;

  if (leftExtra > desiredLeftExtra) {
    const remainder = leftExtra - desiredLeftExtra;
    leftExtra = desiredLeftExtra;
    rightExtra += remainder;
  }
  if (rightExtra > desiredRightExtra) {
    const remainder = rightExtra - desiredRightExtra;
    rightExtra = desiredRightExtra;
    leftExtra += remainder;
  }

  return {
    leftWidth: minColumnWidth + leftExtra,
    rightWidth: minColumnWidth + rightExtra,
  };
}

function formatDetailValueLine(line: string, width: number): string {
  if (!line.startsWith("  └ ") || line.includes("none ")) {
    return truncateToWidth(line, width, "…");
  }

  const match = line.match(/^(  └ )(.*)(: [^:]+ tokens)$/);
  if (!match) {
    return truncateToWidth(line, width, "…");
  }

  const [, prefix, label, suffix] = match;
  const suffixWidth = visibleWidth(suffix);
  const prefixWidth = visibleWidth(prefix);
  const maxLabelWidth = width - prefixWidth - suffixWidth;
  if (maxLabelWidth <= 1) {
    return truncateToWidth(line, width, "…");
  }

  const truncatedLabel = truncateToWidth(label, maxLabelWidth, "…");
  return `${prefix}${truncatedLabel}${suffix}`;
}

export function formatDetailColumnsForWidth(
  columns: { left: string[]; right: string[] },
  totalWidth: number,
): { left: string[]; right: string[]; leftWidth: number; rightWidth: number } {
  const { leftWidth, rightWidth } = computeDetailColumnWidths(columns, totalWidth);
  return {
    leftWidth,
    rightWidth,
    left: columns.left.map((line) => {
      if (line.length === 0) {
        return "";
      }
      if (!line.startsWith("  └ ")) {
        return truncateToWidth(line, leftWidth, "…");
      }
      return formatDetailValueLine(line, leftWidth);
    }),
    right: columns.right.map((line) => {
      if (line.length === 0) {
        return "";
      }
      if (!line.startsWith("  └ ")) {
        return truncateToWidth(line, rightWidth, "…");
      }
      return formatDetailValueLine(line, rightWidth);
    }),
  };
}

function formatDetailColumnLine(
  line: string,
  paddedLine: string,
  theme: ExtensionCommandContext["ui"]["theme"],
): string {
  if (line.length === 0) {
    return paddedLine;
  }
  if (!line.startsWith("  └ ")) {
    return theme.fg("text", theme.bold(paddedLine));
  }
  if (line.includes("none ")) {
    return theme.fg("dim", paddedLine);
  }
  return theme.fg("text", paddedLine);
}

export async function renderContextOverlay(
  breakdown: ContextBreakdown,
  history: HistoryMetrics,
  ctx: ExtensionCommandContext
) {
  await ctx.ui.custom((tui, theme, kb, done) => {
    const container = new Container();

    const categories = getUsageCategoryLines(breakdown);
    const gridWidth = 10;
    const gridHeight = 10;
    const blocks = buildContextGridBlocks(
      getUsageCategoryLines(breakdown),
      breakdown.contextWindow,
      gridWidth,
      gridHeight,
    );

    const rebuildLayout = (width: number) => {
      container.clear();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold(" Context Usage")), 1, 0)
      );
      container.addChild(new Spacer(1));

      const gridLines: string[] = [];
      for (let r = 0; r < gridHeight; r++) {
        let rowStr = "";
        for (let c = 0; c < gridWidth; c++) {
          const b = blocks[r * gridWidth + c];
          let symbol = "⛁";
          if (b.label === "Free space") {
            symbol = "⛶";
          } else if (b.label === "Autocompact buffer") {
            symbol = "⛝";
          } else if (b.squareFullness < 0.7) {
            symbol = "⛀";
          }
          rowStr += theme.fg(b.color as any, formatSymbolCell(symbol));
        }
        gridLines.push(rowStr.trimEnd());
      }

      const modelName = ctx.model?.name ?? "Unknown model";
      const headerLines = buildOverlayHeaderLines(modelName, breakdown, history);
      container.addChild(
        new Text(theme.fg("text", theme.bold(` ${headerLines[0]}`)), 1, 0)
      );
      container.addChild(
        new Text(theme.fg("dim", ` ${headerLines[1]}`), 1, 0)
      );
      container.addChild(new Spacer(1));

      const detailLines: string[] = [];
      detailLines.push(theme.fg("dim", theme.italic("Estimated usage by category")));

      const categoryWidths = measureCategoryColumns(categories);
      categories.forEach((cat) => {
        const icon = cat.icon;
        const columns = formatCategoryColumns(cat, categoryWidths);
        detailLines.push(
          `${theme.fg(cat.color as any, formatSymbolCell(icon))} ${theme.fg("text", columns.label)} ${theme.fg("accent", columns.value)} (${columns.percent})`
        );
      });

      detailLines.push("");

      const leftSideWidth = 30;
      const maxH = Math.max(gridLines.length, detailLines.length);
      for (let i = 0; i < maxH; i++) {
        const left = (gridLines[i] || "").padEnd(leftSideWidth);
        const right = detailLines[i] || "";
        container.addChild(new Text(`    ${left}      ${right}`, 1, 0));
      }

      const detailColumns = buildDetailColumns(breakdown, 120);
      const formattedDetailColumns = formatDetailColumnsForWidth(detailColumns, width);
      const detailRowCount = Math.max(
        formattedDetailColumns.left.length,
        formattedDetailColumns.right.length,
      );

      container.addChild(new Spacer(1));
      for (let index = 0; index < detailRowCount; index += 1) {
        const leftRaw = formattedDetailColumns.left[index] ?? "";
        const rightRaw = formattedDetailColumns.right[index] ?? "";
        const leftPadded = padToVisibleWidth(leftRaw, formattedDetailColumns.leftWidth);
        const renderedLeft = formatDetailColumnLine(leftRaw, leftPadded, theme);
        const renderedRight = formatDetailColumnLine(rightRaw, rightRaw, theme);
        container.addChild(
          new Text(`${DETAIL_SECTION_INDENT}${renderedLeft}${DETAIL_SECTION_GAP}${renderedRight}`, 1, 0),
        );
      }

      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.fg("dim", " Press any key to close"), 1, 0)
      );
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    };

    return {
      render: (w) => {
        rebuildLayout(w);
        return container.render(w);
      },
      invalidate: () => container.invalidate(),
      handleInput: (data) => done(undefined),
    };
  }, { overlay: true });
}
