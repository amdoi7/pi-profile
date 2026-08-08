/**
 * Pure formatting and layout helpers for the custom footer.
 *
 * All functions are theme-injected (no imports from pi) so they can be unit
 * tested with a mock theme. `index.ts` owns lifecycle and data access; this
 * module owns presentation.
 */

import type { GitStatusSnapshot } from "./custom-footer-git.ts";

/** Foreground color names actually used by the footer (subset of pi theme). */
export type FooterColor =
  | "text"
  | "muted"
  | "warning"
  | "error"
  | "success"
  | "accent"
  | "thinkingText";

export type FooterTheme = {
  fg(name: FooterColor, text: string): string;
};

// --- number formatting ------------------------------------------------------

export function formatCompact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const millions = n / 1_000_000;
  return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

// --- context usage ----------------------------------------------------------

/**
 * Color for the context percent, gradient like usageColor:
 * <70 green, 70-84 orange, >=85 red (or 400k+ tokens, the tripwire
 * beyond normal session sizes).
 */
export function contextColor(pct: number | undefined, used: number | undefined): FooterColor {
  const hasPct = typeof pct === "number";
  const hasUsed = typeof used === "number";
  if (!hasPct && !hasUsed) return "muted";
  if ((hasPct && pct >= 85) || (hasUsed && used >= 400_000)) return "error";
  if (hasPct && pct >= 70) return "warning";
  return "success";
}

export function formatTokenStats(
  theme: FooterTheme,
  opts: {
    used: number | undefined;
    pct: number | undefined;
    cost: number;
    tps: number | null;
    flow: TokenFlow | null;
  },
): string {
  const hasPct = typeof opts.pct === "number";
  const hasUsed = typeof opts.used === "number";
  const color = contextColor(opts.pct, opts.used);
  const segments = [
    `${theme.fg("muted", "ctx:")} ${theme.fg("text", hasUsed ? formatCompact(opts.used) : "?")} ${theme.fg(color, hasPct ? `${opts.pct.toFixed(0)}%` : "?")}`,
  ];
  if (opts.flow !== null) segments.push(formatTokenFlow(theme, opts.flow));
  const tail = [theme.fg("muted", formatCost(opts.cost))];
  if (opts.tps !== null) {
    tail.push(theme.fg("muted", `${Math.round(opts.tps)} t/s`));
  }
  segments.push(tail.join(" "));
  return segments.join(theme.fg("muted", " │ "));
}

// --- token flow ------------------------------------------------------------

/**
 * Session totals of input/output/cache tokens and the most recent request's
 * cache hit rate (Claude Code statusline style: `↑3k ↓400 R20k W2.0k CH80%`).
 */
export type TokenFlow = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cache hit rate of the most recent request, 0-100; null when unavailable. */
  cacheHitRate: number | null;
};

/**
 * Accumulate token flow across assistant messages. R and W are session
 * totals; CH covers only the most recent request. Returns null when no
 * assistant usage is recorded.
 */
export function computeTokenFlow(entries: readonly CostEntry[]): TokenFlow | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheHitRate: number | null = null;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const u = entry.message.usage;
    if (!u) continue;
    if (typeof u.input === "number") input += u.input;
    if (typeof u.output === "number") output += u.output;
    if (typeof u.cacheRead === "number") cacheRead += u.cacheRead;
    if (typeof u.cacheWrite === "number") cacheWrite += u.cacheWrite;
    const denom = (u.cacheRead ?? 0) + (u.input ?? 0);
    if (typeof u.cacheRead === "number" && typeof u.input === "number" && denom > 0) {
      cacheHitRate = (u.cacheRead / denom) * 100;
    }
  }
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite, cacheHitRate };
}

/** `↑3k ↓400 R20k W2.0k CH80%`; R/W/CH omitted when there is no cache activity. */
export function formatTokenFlow(theme: FooterTheme, flow: TokenFlow): string {
  const parts = [
    theme.fg("text", `↑${formatCompact(flow.input)} ↓${formatCompact(flow.output)}`),
  ];
  if (flow.cacheRead > 0 || flow.cacheWrite > 0) {
    parts.push(
      theme.fg("muted", `R${formatCompact(flow.cacheRead)} W${formatCompact(flow.cacheWrite)}`),
    );
  }
  if (flow.cacheHitRate !== null) {
    parts.push(theme.fg("muted", `CH${flow.cacheHitRate.toFixed(0)}%`));
  }
  return parts.join(" ");
}

// --- git segment ------------------------------------------------------------

export function formatGitSegment(theme: FooterTheme, status: GitStatusSnapshot | null): string {
  if (status === null) return "";
  const marker = status.dirtyCount > 0 ? theme.fg("warning", "*") : "";
  const extras: string[] = [];
  if (status.ahead > 0) extras.push(theme.fg("muted", `↑${status.ahead}`));
  if (status.behind > 0) extras.push(theme.fg("muted", `↓${status.behind}`));
  if (status.dirtyCount > 0) extras.push(theme.fg("muted", `!${status.dirtyCount}`));
  const suffix = extras.length > 0 ? ` ${extras.join(" ")}` : "";
  return `${theme.fg("text", `⎇ ${status.branch}`)}${marker}${suffix}`;
}

// --- model / cwd segments ---------------------------------------------------

export function formatModel(
  theme: FooterTheme,
  providerName: string,
  modelId: string | undefined,
  thinking: string,
): string {
  const providerModel = modelId && modelId !== providerName ? `${providerName}/${modelId}` : providerName;
  return theme.fg("text", `[${providerModel}`) + theme.fg("muted", ` · think:${thinking}]`);
}

export function formatProviderOnly(
  theme: FooterTheme,
  providerName: string,
  thinking: string,
): string {
  return theme.fg("text", `[${providerName}`) + theme.fg("muted", ` · think:${thinking}]`);
}

/**
 * Working directory as a home-relative path (POSIX convention):
 * `~` for home itself, `~/x` under home, absolute path otherwise.
 * Paths longer than 30 columns collapse to `~/…/<last two segments>`
 * so the leading row stays balanced.
 */
export function formatCwd(theme: FooterTheme, cwd: string, home: string): string {
  let display = cwd === home
    ? "~"
    : cwd.startsWith(`${home}/`)
      ? `~${cwd.slice(home.length)}`
      : cwd;
  if (display.length > 30) {
    const parts = display.split("/");
    display = `${parts[0]}/…/${parts.slice(-2).join("/")}`;
  }
  return `${theme.fg("muted", "cwd:")} ${theme.fg("text", display)}`;
}

// --- cost -------------------------------------------------------------------

type CostEntry = {
  type: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
  };
};

/** Total assistant cost across the current session entries. */
export function computeSessionCost(entries: readonly CostEntry[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      cost += entry.message.usage?.cost?.total ?? 0;
    }
  }
  return cost;
}

// --- layout -----------------------------------------------------------------

export type FooterSegments = {
  model: string;
  providerOnly: string;
  cwd: string;
  /** Empty string hides the segment. */
  branch: string;
};

/** Strip ANSI SGR sequences so width measurement matches the terminal. */
function plainWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Two-row grid dashboard: left column (cwd / ctx) aligned with the right
 * column (model+branch / usage). Degrades to three rows when too narrow or
 * when usage is unavailable:
 * - >=100: cwd, model, branch
 * - 72-99: cwd, model
 * - 52-71: cwd, provider-only model
 * - <52:   cwd only, usage row omitted
 */
export function layoutFooter(
  width: number,
  segments: FooterSegments,
  tokenStats: string,
  usageLine: string | null,
  separator: string,
): string[] {
  if (usageLine !== null && width >= 72) {
    // Grid: (cwd / ctx) left, (model / usage) right, columns aligned.
    const rightTop = width >= 100 && segments.branch.length > 0
      ? `${segments.model}${separator}${segments.branch}`
      : segments.model;
    const leftWidth = Math.max(plainWidth(segments.cwd), plainWidth(tokenStats));
    const pad = (row: string) => " ".repeat(leftWidth - plainWidth(row) + 2);
    return [
      `${segments.cwd}${pad(segments.cwd)}${rightTop}`,
      `${tokenStats}${pad(tokenStats)}${usageLine}`,
    ];
  }
  // Narrow fallback: three rows.
  const lines: string[] = [];
  if (width < 52) {
    lines.push(segments.cwd);
  } else if (width < 72) {
    lines.push([segments.cwd, segments.providerOnly].join(separator));
  } else {
    const parts: string[] = [segments.cwd, segments.model];
    if (width >= 100 && segments.branch.length > 0) parts.push(segments.branch);
    lines.push(parts.join(separator));
  }
  lines.push(tokenStats);
  if (usageLine !== null && width >= 52) lines.push(usageLine);
  return lines;
}


// --- extension status lines -------------------------------------------------

/** Collect non-empty status lines from all extension statuses (unstyled). */
export function extensionStatusLines(statuses: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  for (const status of statuses.values()) {
    if (status.length === 0) continue;
    for (const line of status.split("\n")) {
      if (line.trim().length === 0) continue;
      lines.push(line);
    }
  }
  return lines;
}

// --- subscription usage (Claude Code statusline style) ----------------------

/** Usage window or prepaid balance snapshot from a provider fetcher. */
export type UsageSnapshotView =
  | { kind: "windows"; windows: UsageWindowView[] }
  | { kind: "balance"; balance: number; currency: string };

export type UsageWindowView = {
  label: string;
  usedPercent: number;
  resetsAt?: string;
};

export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const WEEKLY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Window length from its label: "3h" -> 10800, "Weekly"/"Week" -> 604800.
 * Returns null when the label carries no length (no elapsed text shown).
 */
export function windowSecondsForLabel(label: string): number | null {
  const m = /^(\d+)h$/.exec(label);
  if (m) return Number(m[1]) * 3600;
  if (label === "Weekly" || label === "Week") return WEEKLY_SECONDS;
  return null;
}

/**
 * Color ramp matching the Claude Code statusline: >=90 red, >=70 orange,
 * >=50 yellow, else green.
 */
export function usageColor(pct: number): FooterColor {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  if (pct >= 50) return "accent";
  return "success";
}

/** Discrete progress bar (Claude Code style: filled █ + empty ░). */
export function usageBar(pct: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.floor((clamped * width) / 100);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Elapsed text for the 5h window: "3h 12m" or "42m". */
export function secondsToHM(s: number): string {
  if (s <= 0) return "0m";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Elapsed text for the weekly window: "2d 5h" or "3h 12m". */
export function secondsToDHM(s: number): string {
  if (s <= 0) return "0m";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatUsageSegment(
  theme: FooterTheme,
  opts: { prefix: string; label: string; usedPercent: number; resetsAt?: string; nowMs: number },
): string {
  const pct = Math.round(opts.usedPercent);
  const color = usageColor(pct);
  const barText = `${theme.fg(color, usageBar(pct))} ${theme.fg(color, `${pct}%`)}`;
  let text = opts.prefix.length > 0
    ? `${theme.fg("muted", opts.prefix)} ${barText}`
    : barText;
  const windowSeconds = windowSecondsForLabel(opts.label);
  if (opts.resetsAt && windowSeconds !== null) {
    const resetMs = Date.parse(opts.resetsAt);
    if (Number.isFinite(resetMs)) {
      const secsLeft = Math.floor((resetMs - opts.nowMs) / 1000);
      if (secsLeft > 0) {
        const used = Math.max(0, windowSeconds - secsLeft);
        const elapsed =
          windowSeconds === FIVE_HOUR_SECONDS ? secondsToHM(used) : secondsToDHM(used);
        // Label already carries the window length ("5h", "Weekly"), so show
        // elapsed only: `5h ████░░░░ 60% (1h 59m)`.
        text += ` ${theme.fg("muted", `(${elapsed})`)}`;
      }
    }
  }
  return text;
}

/**
 * OpenCode zen billing warning segment: `⚠ opencode-go 401 (check balance)`.
 */
export function formatOpencodeWarning(theme: FooterTheme, code: number): string {
  return theme.fg("warning", `⚠ opencode-go ${code}`);
}

/**
 * The usage line shown below the main footer row, mirroring the Claude Code
 * statusline: `Usage [████░░░░] 42% (3h / 5h) │ Weekly [░░░░░░░░] 5% (1d 2h / Weekly)`.
 * Codex windows use their own labels; Kimi renders as `Kimi $12.34`.
 * Returns null when no data is available (no credentials or API failure).
 */
export function formatUsageLine(
  theme: FooterTheme,
  snapshot: UsageSnapshotView,
  nowMs: number,
): string | null {
  if (snapshot.kind === "balance") {
    const symbol = snapshot.currency === "USD" ? "$" : `${snapshot.currency} `;
    return `${theme.fg("muted", "Kimi")} ${theme.fg("text", `${symbol}${snapshot.balance.toFixed(2)}`)}`;
  }
  const parts: string[] = [];
  snapshot.windows.slice(0, 2).forEach((window, index) => {
    parts.push(
      formatUsageSegment(theme, {
        prefix: window.label,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        nowMs,
      }),
    );
  });
  if (parts.length === 0) return null;
  return parts.join(theme.fg("muted", " │ "));
}
