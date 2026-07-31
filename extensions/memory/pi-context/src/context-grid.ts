import type { UsageCategoryLine } from "./context-categories.ts";

export interface ContextGridBlock {
  color: string;
  label: string;
  squareFullness: number;
}

function buildCategoryBlocks(
  category: UsageCategoryLine,
  contextWindow: number,
  totalBlocks: number,
): ContextGridBlock[] {
  const exactSquares = (category.value / contextWindow) * totalBlocks;
  let squares = Math.round(exactSquares);
  if (squares === 0 && category.value > 0) {
    squares = 1;
  }

  const wholeSquares = Math.floor(exactSquares);
  const fractionalPart = exactSquares - wholeSquares;
  const blocks: ContextGridBlock[] = [];

  for (let i = 0; i < squares; i++) {
    let squareFullness = 1;
    if (i === wholeSquares && fractionalPart > 0) {
      squareFullness = fractionalPart;
    }

    blocks.push({
      color: category.color,
      label: category.label,
      squareFullness,
    });
  }

  return blocks;
}

export function buildContextGridBlocks(
  categories: UsageCategoryLine[],
  contextWindow: number,
  gridWidth: number,
  gridHeight: number,
): ContextGridBlock[] {
  const totalBlocks = gridWidth * gridHeight;
  const blocks: ContextGridBlock[] = [];

  const freeSpaceCategory = categories.find(
    (category) => category.label === "Free space",
  );
  const autocompactCategory = categories.find(
    (category) => category.label === "Autocompact buffer",
  );

  const leadingCategories = categories.filter(
    (category) =>
      category.label !== "Free space" &&
      category.label !== "Autocompact buffer",
  );

  for (const category of leadingCategories) {
    const categoryBlocks = buildCategoryBlocks(
      category,
      contextWindow,
      totalBlocks,
    );
    for (const block of categoryBlocks) {
      if (blocks.length >= totalBlocks) {
        break;
      }
      blocks.push(block);
    }
  }

  const autocompactBlocks = autocompactCategory
    ? buildCategoryBlocks(autocompactCategory, contextWindow, totalBlocks)
    : [];
  const reservedTailCount = Math.min(
    totalBlocks - blocks.length,
    autocompactBlocks.length,
  );

  const freeSpaceTarget = totalBlocks - reservedTailCount;
  const freeSpaceColor = freeSpaceCategory?.color ?? "borderMuted";
  while (blocks.length < freeSpaceTarget) {
    blocks.push({
      color: freeSpaceColor,
      label: "Free space",
      squareFullness: 1,
    });
  }

  for (const block of autocompactBlocks.slice(0, reservedTailCount)) {
    if (blocks.length >= totalBlocks) {
      break;
    }
    blocks.push(block);
  }

  return blocks;
}
