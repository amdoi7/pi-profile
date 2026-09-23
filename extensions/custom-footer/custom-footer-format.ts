/**
 * Pure formatting and layout helpers for the custom footer.
 *
 * All functions are theme-injected (no imports from pi) so they can be unit
 * tested with a mock theme. `index.ts` owns lifecycle and data access; this
 * module owns presentation.
 */

import type { GitStatusSnapshot } from "./custom-footer-git.ts";
import type { CacheWaste } from "./custom-footer-stats.ts";
import type { RoundFlow } from "./custom-footer-tps.ts";

/** Foreground color names actually used by the footer (subset of pi theme). */
export type FooterColor =
  | "text"
  | "muted"
  | "warning"
  | "error"
  | "success"
  | "accent"
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

// --- session 哈希色 ---------------------------------------------------------

/** djb2 哈希（omp session-color 同款），32 位无符号。 */
export function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}

/** 会话锚色相（0-360）：同一 id 恒同色、不同会话大概率异色（omp 同思路）。 */
export function sessionAnchorHue(sessionId: string | undefined): number {
  if (!sessionId || sessionId.length === 0) return 0;
  return hashString(sessionId) % 360;
}

/** HSL → RGB（h 0-360，s/l 0-1），纯函数可单测。 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * 会话锚真彩色 RGB：哈希决定色相，固定 S=75% / L=60%（深色终端可读的折中）。
 * 不经过主题 token——真哈希色是 omp 思路（djb2 → 色相），主题注入只保留
 * 在 fg() 抽象层，本函数输出裸 RGB 由 index.ts 拼 ANSI。
 */
export function sessionAnchorRgb(sessionId: string | undefined): [number, number, number] {
  return hslToRgb(sessionAnchorHue(sessionId), 0.75, 0.6);
}

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

/** 订阅前缀形式（omp spend）：`S12.34`——订阅账单与按量 `$` 区分。 */
export function formatSubscriptionCost(cost: number): string {
  return `S${cost.toFixed(2)}`;
}

// --- cache waste ------------------------------------------------------------

/**
 * 缓存浪费段的最低展示成本（美元）：低于此金额不值得占底栏空间。
 * 2026-08-27 实测过载示例 `miss 293k (97×) (+$0.02)`——97 次失效只花 2 分钱，
 * 是低频噪音而非信号；5 分以上才是需要人留意的真浪费。
 */
export const MISS_COST_DISPLAY_THRESHOLD = 0.05;

/** `miss 143k (2×)` — 缓存浪费汇总（omp/官方 cache-stats 口径）。 */
export function formatCacheWaste(theme: FooterTheme, waste: CacheWaste): string {
  let text = theme.fg("warning", `miss ${formatCompact(waste.missedTokens)} (${waste.missCount}×)`);
  if (waste.missedCost >= 0.01) {
    text += theme.fg("warning", ` (+$${waste.missedCost.toFixed(2)})`);
  }
  return text;
}

// --- context usage ----------------------------------------------------------

/**
 * Context-usage 四档阈值（借鉴 omp status-line context-thresholds，2026-08-27）:
 * percent 阈值与绝对 token 阈值取严格者——小窗口模型（128k）在 150k 绝对阈值
 * 下提前一档告警,而不是印象式百分比。
 *
 * editorial:normal<50%（或 150k token;两者取先到者）→ warning;
 * warning→accent(purple,pi 主题无 purple,映射 accent);accent→error。
 *
 * 无窗口信息时(used 未知/窗口 0)退化为 percent-only;无上下文数据返回 muted。
 */
export type ContextUsageLevel = "normal" | "warning" | "accent" | "error";

const CONTEXT_WARNING_PERCENT = 50;
const CONTEXT_WARNING_TOKENS = 150_000;
const CONTEXT_ACCENT_PERCENT = 70;
const CONTEXT_ACCENT_TOKENS = 270_000;
const CONTEXT_ERROR_PERCENT = 90;
const CONTEXT_ERROR_TOKENS = 500_000;

function reachesThreshold(
  pct: number,
  window: number,
  pctThreshold: number,
  tokenThreshold: number,
): boolean {
  if (window > 0) {
    // 双阈值取严格：绝对 token 阈值换算成 percent 后与 percent 阈值比小。
    const tokenPctThreshold = (tokenThreshold / window) * 100;
    return pct >= Math.min(pctThreshold, tokenPctThreshold);
  }
  return pct >= pctThreshold;
}

export function getContextUsageLevel(pct: number | undefined, window: number): ContextUsageLevel {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0) return "normal";
  if (reachesThreshold(pct, window, CONTEXT_ERROR_PERCENT, CONTEXT_ERROR_TOKENS)) return "error";
  if (reachesThreshold(pct, window, CONTEXT_ACCENT_PERCENT, CONTEXT_ACCENT_TOKENS)) return "accent";
  if (reachesThreshold(pct, window, CONTEXT_WARNING_PERCENT, CONTEXT_WARNING_TOKENS)) return "warning";
  return "normal";
}

export function contextColor(pct: number | undefined, used: number | undefined, contextWindow: number): FooterColor {
  if (typeof pct !== "number" && typeof used !== "number") return "muted";
  // pct 缺失但有 used(绝对 token)时,折算成窗口百分比参与同一双阈值判定。
  let effective = pct;
  if (typeof pct !== "number" && typeof used === "number" && contextWindow > 0) {
    effective = (used / contextWindow) * 100;
  }
  const level = getContextUsageLevel(effective, contextWindow);
  return level === "error" ? "error" : level === "accent" ? "accent" : level === "warning" ? "warning" : "success";
}

/**
 * Session row: context usage, token flow, cache hit, cache waste, cost and
 * throughput. 视角分离（2026-09 用户拍板）：前端是 session 级（ctx 用量、
 * 累计成本 $、缓存浪费 miss——官方 getContextUsage / usageTotals.cost /
 * computeCacheWaste 口径），中段是最近一轮的 token 流（↑↓ τ ℂ——与 tps
 * tracker 同轮同源，进行中实时 / settled 锁定），尾部是同一轮的动态指标
 * （t/s ttfb 本轮时长）。不混搭——官方 footer 把 session 累计的 ↑↓ 和最后
 * 一条消息的 CH 并排，正是视角漂移的来源。
 */
export function formatSessionRow(
  theme: FooterTheme,
  opts: {
    used: number | undefined;
    pct: number | undefined;
    /** 上下文窗口容量：`443k/1M`（用量/容量），compact 决策直接可读。 */
    contextWindow: number;
    /** 会话累计成本（官方 usageTotals.cost 口径，含 toolResult/compaction 条目）。 */
    sessionCost: number;
    /** 订阅模型（claude/codex/kimi）：cost 前缀 S（see omp spend）。 */
    subscription: boolean;
    /** 最近一轮的 token flow：`↑3k ↓400 (τ69%) ℂ99%`，进行中实时、完成态锁定。 */
    roundFlow: RoundFlow | null;
    /** 最近完成一轮（用户消息 → 不再输出）的平均吞吐；进行中为 null。 */
    tps: number | null;
    /** 进行中一轮的经过时间（毫秒）：`本轮12s`，每秒增长。 */
    currentElapsedMs: number | null;
    /** 最近一轮的总时长（毫秒）：`本轮1m5s` / `本轮1h30m51s`（完成态，≥60m 进位到 h）。 */
    turnMs: number | null;
    /** 最近一轮的首字时间（TTFB，毫秒）：`ttfb1.2s`。 */
    ttfbMs: number | null;
    /** 会话累计缓存浪费（session 级）。 */
    waste: CacheWaste | null;
  },
): string {
  const hasPct = typeof opts.pct === "number";
  const hasUsed = typeof opts.used === "number";
  const color = contextColor(opts.pct, opts.used, opts.contextWindow);
  const usedText = hasUsed
    ? `${formatCompact(opts.used as number)}/${formatCompact(opts.contextWindow)}`
    : "?";
  const pctText = hasPct ? `${(opts.pct as number).toFixed(0)}%` : "?";
  // 会话级段（前端）：ctx 用量 + 累计成本 + miss——都是 session 累计，同段同源。
  const sessionParts = [
    `${theme.fg("muted", "ctx:")} ${theme.fg("text", usedText)} ${theme.fg(color, pctText)}`,
  ];
  if (opts.waste !== null && opts.waste.missCount > 0 && opts.waste.missedCost >= MISS_COST_DISPLAY_THRESHOLD) {
    sessionParts.push(formatCacheWaste(theme, opts.waste));
  }
  sessionParts.push(
    theme.fg("muted", opts.subscription ? formatSubscriptionCost(opts.sessionCost) : formatCost(opts.sessionCost)),
  );
  const rows = [sessionParts.join(" ")];
  // 轮级段（中）：↑↓ (τ%) ℂ——最近一轮的聚合（不是最后一条消息，也不是 session 累计）。
  const roundParts: string[] = [];
  if (opts.roundFlow !== null && hasFlowTokens(opts.roundFlow)) {
    roundParts.push(formatTokenFlow(theme, opts.roundFlow));
    // 缓存命中率（官方 latestCacheHitRate 口径的轮级化）：rate = cacheRead /
    // (cacheRead + cacheWrite + input)，分母含 uncached input。
    const hitRate = cacheHitRate(opts.roundFlow);
    if (hitRate !== null) roundParts.push(formatCacheHit(theme, hitRate));
  }
  if (roundParts.length > 0) rows.push(roundParts.join(" "));
  // 轮动态段（尾）：tps/ttfb/本轮时长（与 ↑↓τℂ 同一轮）。tps/ttfb 恒为最近
  // 完成消息的值（跨轮保留，新消息完成时替换）；本轮进行中显示实时经过，
  // 完成态显示锁定总时长。
  const tail: string[] = [];
  if (opts.tps != null) {
    tail.push(theme.fg("muted", `${Math.round(opts.tps)} t/s`));
  }
  if (opts.ttfbMs != null && opts.tps != null) {
    tail.push(theme.fg("muted", `ttfb${(opts.ttfbMs / 1000).toFixed(1)}s`));
  }
  if (opts.currentElapsedMs != null) {
    tail.push(theme.fg("muted", `本轮${formatDuration(opts.currentElapsedMs)}`));
  } else if (opts.turnMs != null) {
    tail.push(theme.fg("muted", `本轮${formatDuration(opts.turnMs)}`));
  }
  if (tail.length > 0) rows.push(tail.join(" "));
  return rows.join(theme.fg("muted", " │ "));
}

/** 轮级 flow 是否有可显示的 token（全零轮不占底栏空间，与 session flow 同规则）。 */
function hasFlowTokens(flow: RoundFlow): boolean {
  return flow.input > 0 || flow.output > 0 || flow.reasoning > 0 || flow.cacheRead > 0 || flow.cacheWrite > 0;
}

// --- token flow ------------------------------------------------------------

/**
 * `↑3k ↓400 (τ69%)`；输出含 thinking（reasoning > 0）时显示占比
 * （τ = thinking，reasoning 是 output 的子集）。
 *
 * R/W 不在此展示：缓存效率由 `ℂ命中率` 承担（见 cacheHitRate）；R/W 绝对值
 * 无参照系（每轮读缓存是常态），且与命中率重叠。2026-08-27 实测过载示例
 * `↑523k ↓166k (τ35%) R52.9M W0 ℂ99.0%`——W0 恒零、R 与 ℂ 重复，裁掉后
 * 底栏短一半且信息不丢。
 */
export function formatTokenFlow(theme: FooterTheme, flow: RoundFlow): string {
  const parts = [
    theme.fg("text", `↑${formatCompact(flow.input)} ↓${formatCompact(flow.output)}`),
  ];
  if (flow.reasoning > 0) {
    const thinkingPct = (flow.reasoning / flow.output) * 100;
    parts[0] = theme.fg("text", `↑${formatCompact(flow.input)} ↓${formatCompact(flow.output)} (τ${thinkingPct.toFixed(0)}%)`);
  }
  return parts.join(" ");
}

/**
 * 缓存命中率（官方 latestCacheHitRate 的轮级化）：命中 token 占全部 prompt
 * token 的比例。返回 0..100；无缓存活动（cacheRead=0）或总 prompt 为 0 时
 * 返回 null（不显示）。
 */
export function cacheHitRate(flow: Pick<RoundFlow, "cacheRead" | "cacheWrite" | "input">): number | null {
  const total = flow.cacheRead + flow.cacheWrite + flow.input;
  if (!(flow.cacheRead > 0) || total <= 0) return null;
  return (flow.cacheRead / total) * 100;
}

/** `ℂ94.2%` —— 缓存命中率（omp: `cache hit` 图标 + percent）。 */
export function formatCacheHit(theme: FooterTheme, rate: number): string {
  const clamped = Math.min(100, Math.max(0, rate));
  const color: FooterColor = clamped >= 90 ? "success" : clamped >= 70 ? "text" : "warning";
  return theme.fg(color, `ℂ${clamped.toFixed(2)}%`);
}

/** 思考时长显示：`42s` / `1m5s` / `1h30m51s`（毫秒输入，≥60m 进位到 h）。 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
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
 * Two-row dashboard on a shared column grid. With a git branch present
 * (>=100 columns) both rows render as `col1 │ col2 │ col3`: row 1
 * `cwd │ branch │ model`, row 2 `ctx+$+miss │ ↑↓τℂ │ 动态段`. Each "│" column
 * is the max display width of the same-position segment across the two rows
 * (padding lands before the "│", row starts stay at column 0), so the
 * separators line up vertically — one formula for both rows (isomorphic),
 * applied to the front (col1|col2) and back (col2|col3) boundaries alike.
 * Column 1 keeps a design minimum (LEFT_BAND) so short paths don't crowd
 * the grid; column 2 is content-driven (branch vs flow).
 *
 * Without a branch (or below 100 columns) the layout falls back to a shared
 * right column: right column starts at max(content, band minimum) +
 * COLUMN_GAP, never stretching to the terminal edge. The right side of row 2
 * (usage) stays empty when unavailable, so the label alignment (cwd:/ctx:)
 * persists across providers. Narrow fallback:
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
    // 三列网格(≥100 且有 branch):行1 `cwd │ branch │ model`、行2
    // `ctx+$+miss │ ↑↓τℂ │ 动态段`(sessionRow 按分隔符拆段)。"│" 列两行共享:
    // 每列宽度 = 两行同段 display width 的最大值,短列在 "│" 前补空格。
    const grid = width >= 100 && segments.branch.length > 0;
    if (grid) {
      const top = [segments.cwd, segments.branch, segments.model];
      const bottom = sessionRow.split(separator);
      const col1 = Math.max(LEFT_BAND, displayWidth(top[0]), displayWidth(bottom[0] ?? ""));
      const col2 = Math.max(displayWidth(top[1]), displayWidth(bottom[1] ?? ""));
      const pad = (s: string, target: number): string =>
        displayWidth(s) >= target ? s : `${s}${" ".repeat(target - displayWidth(s))}`;
      const topLine = [pad(top[0], col1), pad(top[1], col2), top[2]].join(separator);
      const bottomLine =
        bottom.length >= 2
          ? [pad(bottom[0], col1), pad(bottom[1], col2), ...bottom.slice(2)].join(separator)
          : bottom.join(separator);
      return usageLine !== null
        ? [topLine, `${bottomLine}${" ".repeat(COLUMN_GAP)}${usageLine}`]
        : [topLine, bottomLine];
    }
    // 无 branch 档位:右列起点 = max(内容, 档宽下限) + COLUMN_GAP,两行共享。
    const leftTop = segments.cwd;
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
