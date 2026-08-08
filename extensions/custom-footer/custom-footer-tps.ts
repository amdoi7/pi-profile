/**
 * Tokens-per-second tracker for assistant message generation.
 *
 * 对齐 aio-coding-hub 的速率语义：分母剔除 TTFB（首字节等待）——
 * generation_ms = duration_ms − ttfb_ms，只算流式输出阶段的吞吐。
 * TTFB 点 = 首个响应块到达（message_update 首次触发）；TTFB 起点 = turn_start
 * （pi 的 message_start 在响应头到达时才触发，与首块同批毫秒级，作起点测得恒 0；
 * turn_start 在每个 LLM 请求发出前同步触发，是请求发出点的最佳代理）。
 * 无 TTFB 点（非流式/无输出）时退化为不计算（null）。
 * 分子 output_tokens 含 reasoning（与 aio 一致：reasoning 是 output 的子集）。
 *
 * 时长维度只记录一轮（turn）的总时长：turn_start → turn_end。
 * 不做 thinking 段级跟踪（React 模式一轮多次 thinking 无需拆分——
 * 用户体感就是"这轮花了多久"）。Tracked per working directory.
 */

export type TpsTrackerDeps = {
  getNowMs(): number;
};

export type TpsTracker = {
  /** 一轮（turn）开始：本轮经过时间的起点。 */
  onTurnStart(cwd: string): void;
  /** 一轮（turn）结束：快照本轮总时长。 */
  onTurnEnd(cwd: string): void;
  /** Called when an assistant message starts streaming (response head arrived; TTFB fallback start). */
  onMessageStart(cwd: string): void;
  /**
   * Called when the first response chunk arrives (TTFB 点).
   * Idempotent per message: later chunks keep the first timestamp.
   */
  onFirstChunk(cwd: string): void;
  /**
   * Called when an assistant message completes. Returns the message's
   * streaming-phase speed in tokens per second, or null when the message
   * cannot be measured (no first chunk, zero tokens, or zero elapsed time).
   */
  onMessageEnd(cwd: string, outputTokens: number): number | null;
  /** Speed of the most recently completed assistant message, or null. */
  getLast(cwd: string): number | null;
  /** 最近完成消息的首字时间（TTFB，毫秒）；无起点或未完成消息为 null。 */
  getLastTtfbMs(cwd: string): number | null;
  /** 最近一轮的总时长（毫秒，turn_end − turn_start）；无记录为 null。 */
  getLastTurnMs(cwd: string): number | null;
  /**
   * 进行中一轮的经过时间（毫秒，now − turn_start），每秒增长；
   * 无进行中的轮为 null。
   */
  getCurrentElapsedMs(cwd: string): number | null;
};

type TpsEntry = {
  /** 当前轮开始时刻（turn_start，TTFB 起点）。 */
  turnStartMs: number | null;
  /** 当前消息响应流开始时刻（message_start；TTFB 起点的回退值）。 */
  messageStartMs: number | null;
  /** TTFB 点：当前消息首个响应块到达时刻（aio 语义的 ttfb_ms）。 */
  firstChunkMs: number | null;
  lastTurnMs: number | null;
  lastTokPerSec: number | null;
  lastTtfbMs: number | null;
};

export function createTpsTracker(deps: TpsTrackerDeps = {}): TpsTracker {
  const getNowMs = deps.getNowMs ?? (() => Date.now());
  const entries = new Map<string, TpsEntry>();

  const newEntry = (previous: TpsEntry | undefined): TpsEntry => ({
    turnStartMs: null,
    messageStartMs: null,
    firstChunkMs: null,
    lastTurnMs: previous?.lastTurnMs ?? null,
    lastTokPerSec: previous?.lastTokPerSec ?? null,
    lastTtfbMs: previous?.lastTtfbMs ?? null,
  });

  return {
    onTurnStart(cwd) {
      const previous = entries.get(cwd);
      const entry = newEntry(previous);
      entry.turnStartMs = getNowMs();
      entries.set(cwd, entry);
    },
    onTurnEnd(cwd) {
      const entry = entries.get(cwd);
      if (!entry || entry.turnStartMs === null) return;
      entry.lastTurnMs = getNowMs() - entry.turnStartMs;
      // 本轮结束：清实时起点——getCurrentElapsedMs 变 null，显示回退固定总时长
      // （否则实时值继续漂移，伪装成总时长）。
      entry.turnStartMs = null;
    },
    onMessageStart(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      entry.messageStartMs = getNowMs();
      entry.firstChunkMs = null;
      entries.set(cwd, entry);
    },
    onFirstChunk(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      // 已有 TTFB 点则幂等返回（后续块不重置）。
      if (entry.firstChunkMs === null) entry.firstChunkMs = getNowMs();
      entries.set(cwd, entry);
    },
    onMessageEnd(cwd, outputTokens) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      entries.set(cwd, entry);
      // 无 TTFB 点（消息从未流式输出）→ 无法测量，退化不计算。
      if (entry.firstChunkMs === null) return null;
      const elapsedMs = getNowMs() - entry.firstChunkMs;
      if (elapsedMs <= 0 || outputTokens <= 0) return null;
      // 首字时间：首个响应块 − 请求发出（aio 的 ttfb_ms）。请求发出点取
      // turn_start；极端路径（消息无前驱 turn_start）回退 message_start。
      const startMs = entry.turnStartMs ?? entry.messageStartMs;
      if (startMs !== null) {
        entry.lastTtfbMs = entry.firstChunkMs - startMs;
      }
      const tokPerSec = (outputTokens / elapsedMs) * 1000;
      entry.lastTokPerSec = tokPerSec;
      return tokPerSec;
    },
    getLast(cwd) {
      return entries.get(cwd)?.lastTokPerSec ?? null;
    },
    getLastTtfbMs(cwd) {
      return entries.get(cwd)?.lastTtfbMs ?? null;
    },
    getLastTurnMs(cwd) {
      return entries.get(cwd)?.lastTurnMs ?? null;
    },
    getCurrentElapsedMs(cwd) {
      const entry = entries.get(cwd);
      if (!entry || entry.turnStartMs === null) return null;
      return getNowMs() - entry.turnStartMs;
    },
  };
}
