const AMBIGUOUS_WIDE_ICONS = new Set(["⛶", "⛝"]);

function isEastAsianWideLocale(locale: string | undefined): boolean {
  if (!locale) {
    return false;
  }

  return /\b(zh|ja|ko)([_-]|$)/i.test(locale);
}

export function shouldTreatAmbiguousSymbolsAsWide(): boolean {
  return isEastAsianWideLocale(
    process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG,
  );
}

export function formatSymbolCell(
  symbol: string,
  ambiguousWide = shouldTreatAmbiguousSymbolsAsWide(),
): string {
  if (ambiguousWide && AMBIGUOUS_WIDE_ICONS.has(symbol)) {
    return symbol;
  }

  return `${symbol} `;
}
