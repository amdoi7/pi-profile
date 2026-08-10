/**
 * Pure formatting and layout helpers for the custom footer.
 *
 * All functions are theme-injected (no imports from pi) so they can be unit
 * tested with a mock theme. `index.ts` owns lifecycle and data access; this
 * module owns presentation.
 */

import type { GitStatusSnapshot } from "./custom-footer-git.ts";
export type { CacheWaste } from "./custom-footer-cache.ts";

/** Foreground color names actually used by the footer (subset of pi theme). */
export type FooterColor =
  | "text"
  | "muted"
  | "warning"
  | "error"
  | "success"
  | "customMessageLabel"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax";

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

// --- cache waste ------------------------------------------------------------

/**
 * 缓存失效汇总：`miss 143k (2×)` — 主指标是本应命中却被重新计费的
 * token 总量，括号内为失效次数；额外成本 ≥1 分时追加金额。
 * 词汇与 pi 内部 computeCacheWaste / Cache miss 对齐。
 */
export function formatCacheWaste(theme: FooterTheme, waste: CacheWaste): string {
  let text = theme.fg("warning", `miss ${formatCompact(waste.missedTokens)} (${waste.missCount}×)`);
  if (waste.missedCost >= 0.01) {
    text += theme.fg("warning", ` (+$${waste.missedCost.toFixed(2)})`);
  }
  return text;
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

/**
 * Session row: context usage, token flow, cache waste, cost and throughput.
 * This is the left column of the footer's second row (`ctx: 153k 15% │ ↑950k
 * ↓487k R201.9M W0 │ miss2× 236k │ $0.87`).
 */
export function formatSessionRow(
  theme: FooterTheme,
  opts: {
    used: number | undefined;
    pct: number | undefined;
    /** 上下文窗口容量：`443k/1M`（用量/容量），compact 决策直接可读。 */
    contextWindow: number;
    cost: number;
    /** 最近完成一轮（用户消息 → 不再输出）的平均吞吐；进行中为 null。 */
    tps: number | null;
    /** 进行中一轮的经过时间（毫秒）：`本轮12s`，每秒增长。 */
    currentElapsedMs: number | null;
    /** 最近一轮的总时长（毫秒）：`本轮1m5s`（完成态）。 */
    turnMs: number | null;
    /** 最近一轮的首字时间（TTFB，毫秒）：`ttfb1.2s`。 */
    ttfbMs: number | null;
    flow: TokenFlow | null;
    waste: CacheWaste | null;
  },
): string {
  const hasPct = typeof opts.pct === "number";
  const hasUsed = typeof opts.used === "number";
  const color = contextColor(opts.pct, opts.used);
  const usedText = hasUsed
    ? `${formatCompact(opts.used)}/${formatCompact(opts.contextWindow)}`
    : "?";
  const rows = [
    `${theme.fg("muted", "ctx:")} ${theme.fg("text", usedText)} ${theme.fg(color, hasPct ? `${opts.pct.toFixed(0)}%` : "?")}`,
  ];
  // 会话累计段：token 流 + τ 占比 + miss（浪费）+ 账单——都是会话级，同段。
  const sessionParts: string[] = [];
  if (opts.flow !== null) sessionParts.push(formatTokenFlow(theme, opts.flow));
  if (opts.waste !== null && opts.waste.missCount > 0) {
    sessionParts.push(formatCacheWaste(theme, opts.waste));
  }
  sessionParts.push(theme.fg("muted", formatCost(opts.cost)));
  rows.push(sessionParts.join(" "));
  // 本轮动态段：tps/ttfb/本轮时长——同一轮（用户消息 → 不再输出）内同源同构。
  // 进行中：只显示实时经过时间（tps/ttfb 是最近完成消息的值，混搭会自相矛盾
  // ——如 ttfb 大于进行中轮长）；完成态：同轮完整一组。
  const tail: string[] = [];
  if (opts.currentElapsedMs != null) {
    tail.push(theme.fg("muted", `本轮${formatDuration(opts.currentElapsedMs)}`));
  } else {
    if (opts.tps != null) {
      tail.push(theme.fg("muted", `${Math.round(opts.tps)} t/s`));
    }
    if (opts.ttfbMs != null && opts.tps != null) {
      tail.push(theme.fg("muted", `ttfb${(opts.ttfbMs / 1000).toFixed(1)}s`));
    }
    if (opts.turnMs != null) {
      tail.push(theme.fg("muted", `本轮${formatDuration(opts.turnMs)}`));
    }
  }
  if (tail.length > 0) rows.push(tail.join(" "));
  return rows.join(theme.fg("muted", " │ "));
}

// --- token flow ------------------------------------------------------------

/**
 * 会话累计的输入/输出 tokens 与 thinking 占比。
 * R/W（缓存读写累计）已移除：绝对值无参照系（每轮重复读缓存是常态），
 * 缓存浪费信号由 formatCacheWaste（miss）承载。
 */
export type TokenFlow = {
  input: number;
  output: number;
  /** 输出中 thinking（reasoning）token 累计；reasoning 是 output 的子集。 */
  reasoning: number;
};

/**
 * Accumulate token flow across assistant messages. Returns null when no
 * assistant usage is recorded.
 */
export function computeTokenFlow(entries: readonly SessionEntry[]): TokenFlow | null {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const u = entry.message.usage;
    if (!u) continue;
    if (typeof u.input === "number") input += u.input;
    if (typeof u.output === "number") output += u.output;
    if (typeof u.reasoning === "number") reasoning += u.reasoning;
  }
  if (input === 0 && output === 0 && reasoning === 0) return null;
  return { input, output, reasoning };
}

/**
 * `↑3k ↓400 (τ69%)`；输出含 thinking（reasoning > 0）时显示占比
 * （τ = thinking，reasoning 是 output 的子集）。单轮动态字段（tps/ttfb/
 * 思考时长）统一在尾部动态组，不在此处。
 */
export function formatTokenFlow(theme: FooterTheme, flow: TokenFlow): string {
  const parts = [
    theme.fg("text", `↑${formatCompact(flow.input)} ↓${formatCompact(flow.output)}`),
  ];
  if (flow.reasoning > 0) {
    const thinkingPct = (flow.reasoning / flow.output) * 100;
    parts[0] = theme.fg("text", `↑${formatCompact(flow.input)} ↓${formatCompact(flow.output)} (τ${thinkingPct.toFixed(0)}%)`);
  }
  return parts.join(" ");
}

/** 思考时长显示：`42s` / `1m5s`（毫秒输入）。 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

// --- git segment ------------------------------------------------------------

export function formatGitSegment(theme: FooterTheme, status: GitStatusSnapshot | null): string {
  if (status === null) return "";
  const marker = status.dirtyCount > 0 ? theme.fg("warning", "*") : "";
  // zentui diverged form：计数紧贴各自箭头，无分隔符，歧义为零。
  let aheadBehind = "";
  if (status.ahead > 0 && status.behind > 0) aheadBehind = `↑${status.ahead}↓${status.behind}`;
  else if (status.ahead > 0) aheadBehind = `↑${status.ahead}`;
  else if (status.behind > 0) aheadBehind = `↓${status.behind}`;
  const extras: string[] = [];
  if (aheadBehind) extras.push(theme.fg("muted", aheadBehind));
  if (status.dirtyCount > 0) extras.push(theme.fg("muted", `!${status.dirtyCount}`));
  if (status.gitStateLabel) extras.push(theme.fg("warning", status.gitStateLabel));
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
  return (
    theme.fg("text", providerModel) +
    theme.fg("muted", " · think:") +
    theme.fg(thinkingLevelColor(thinking), thinking)
  );
}

/**
 * Thinking level -> theme token, so the footer label echoes the editor
 * border color for the same level. Unknown levels stay muted.
 */
export function thinkingLevelColor(level: string): FooterColor {
  switch (level) {
    case "off": return "thinkingOff";
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    case "max": return "thinkingMax";
    default: return "muted";
  }
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

/** Narrow view of one session entry used for cost and token-flow aggregation. */
type SessionEntry = {
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
export function computeSessionCost(entries: readonly SessionEntry[]): number {
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

/**
 * 终端显示宽度：先剥 ANSI SGR 码（truecolor 每条 10-20 字符，不剥会把
 * 列宽膨胀几十上百列），CJK 等宽字符按 2 列计（JS .length 只算 1）。
 */
function displayWidth(text: string): number {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    w += isWideCode(code) ? 2 : 1;
  }
  return w;
}

function isWideCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首/康熙/假名/汉字区
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) // CJK 扩展 B+
  );
}

/**
 * Two-row dashboard on a designed grid. Left column is the session environment
 * (cwd + git branch), right column the runtime config (model, usage). Column
 * positions stay stable: right column starts at max(content, regime band
 * minimum) + COLUMN_GAP, never stretching to the terminal edge.
 *
 * Git branch joins the cwd segment (semantic grouping: repo state is a
 * property of the working directory), so branch changes (commit / dirty count /
 * switch) move the right column — accepted trade-off for left-column
 * continuity, kept to ≥100 columns to protect narrow terminals.
 * One formula in both grid regimes: column start = max(content, regime
 * band minimum) + COLUMN_GAP. The band minimum applies at >=100 columns
 * (where the branch segment also appears); below it the minimum is zero
 * and the grid follows content. The grid applies at >=72 columns; the
 * right column of row 2 stays empty when usage is unavailable, so the
 * label alignment (cwd:/ctx:) persists across providers. Narrow fallback:
 * - 52-71: cwd, provider-only model | ctx | usage
 * - <52:   cwd only, usage row omitted
 */
const LEFT_BAND = 40;
const COLUMN_GAP = 4;

export function layoutFooter(
  width: number,
  segments: FooterSegments,
  sessionRow: string,
  usageLine: string | null,
  separator: string,
): string[] {
  if (width >= 72) {
    const leftTop =
      width >= 100 && segments.branch.length > 0
        ? `${segments.cwd}${separator}${segments.branch}`
        : segments.cwd;
    const rightTop = segments.model;
    const leftWidth = Math.max(displayWidth(leftTop), displayWidth(sessionRow));
    const start = Math.max(leftWidth, width >= 100 ? LEFT_BAND : 0) + COLUMN_GAP;
    const place = (left: string, right: string): string => {
      if (right.length === 0) return left;
      const gap = Math.max(2, start - displayWidth(left));
      return `${left}${" ".repeat(gap)}${right}`;
    };
    return [
      place(leftTop, rightTop),
      place(sessionRow, usageLine ?? ""),
    ];
  }
  // Narrow fallback: three rows.
  const lines: string[] = [];
  if (width < 52) {
    lines.push(segments.cwd);
  } else {
    lines.push([segments.cwd, segments.providerOnly].join(separator));
  }
  lines.push(sessionRow);
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
 * Meter color by action semantics, not raw percent: green in the healthy
 * zone, neutral text once past half (no alarm yet), amber at 70+, red at
 * 90+. `accent` is deliberately unused — it is the theme's brand anchor,
 * not a meter color.
 */
export function usageColor(pct: number): FooterColor {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  if (pct >= 50) return "text";
  return "success";
}

/**
 * Discrete progress bar with eighth-block resolution (▏▎▍▌▋▊▉█): partial
 * cells keep low percentages visible (3% -> `▎░░░░░░░` instead of a blank
 * bar). Empty cells use ░.
 */
export function usageBar(pct: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const exact = (clamped / 100) * width;
  const full = Math.floor(exact);
  const frac = exact - full;
  const partials = "▏▎▍▌▋▊▉";
  const partial = frac > 0 ? partials[Math.min(6, Math.floor(frac * 8))] : "";
  return "█".repeat(full) + partial + "░".repeat(width - full - partial.length);
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
  opts: { label: string; usedPercent: number; resetsAt?: string; nowMs: number },
): string {
  const pct = Math.round(opts.usedPercent);
  const color = usageColor(pct);
  const barText = `${theme.fg(color, usageBar(pct))} ${theme.fg(color, `${pct}%`)}`;
  let text = `${theme.fg("muted", opts.label)} ${barText}`;
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
  snapshot.windows.slice(0, 2).forEach((window) => {
    parts.push(
      formatUsageSegment(theme, {
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
