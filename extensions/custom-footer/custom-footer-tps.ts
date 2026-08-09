/**
 * User-round performance tracker for the custom footer.
 *
 * "本轮" = 用户发送消息 → agent 不再输出:pi 的 agent_start → agent_settled
 * (settled 在 retry / compaction / 队列消息全部耗尽后触发,agent-session.js
 * `_runAgentPrompt`)。pi 的 turn_start/turn_end 事件是每条 LLM 响应一个
 * (turnIndex 递增),不是用户轮,不能用作本轮边界。
 *
 * 一轮内 agent_start 可能多次(prompt + retry/compaction 后的 continue):
 * 只有第一个作为本轮起点,continue 只累计不重置。
 *
 * - 本轮时长 = agent_settled − 首次 agent_start
 * - TTFB = 本轮首个响应块(firstChunk,幂等)− 首次 agent_start
 * - tps = 本轮累计 output(含 reasoning)/ 本轮累计流式时间(每条消息
 *   firstChunk → message_end 之和);工具执行与消息间隙不稀释速率。
 * 无首个响应块(无输出)时 tps/ttfb 退化 null。Tracked per working directory.
 *
 * 渲染 hook:数据变化通过 onChange 通知(live 节流 / commit 立即),
 * 事件处理器只更新数据,渲染调度集中在 index.ts 的 hook 回调。
 */

export type TpsTrackerDeps = {
  getNowMs(): number;
};

/** 变化语义：live = 流式/等待期（节流渲染），commit = 完成态（立即渲染）。 */
export type TpsChange = "live" | "commit";

export type TpsTracker = {
  /** 一轮（用户消息 → 不再输出）开始：本轮起点；进行中时（continue）幂等不重置。 */
  onAgentStart(cwd: string): void;
  /** 一轮结束：锁定本轮时长/ttfb/tps，实时值失效。 */
  onAgentSettled(cwd: string): void;
  /** 本轮首个响应块到达（TTFB 点）；幂等，后续块不重置。 */
  onFirstChunk(cwd: string): void;
  /** 一条 assistant 消息完成：累计本轮输出 tokens。 */
  onMessageEnd(cwd: string, outputTokens: number): void;
  /** 最近完成一轮的 tps，或 null。 */
  getLast(cwd: string): number | null;
  /** 最近完成一轮的首字时间（TTFB，毫秒），或 null。 */
  getLastTtfbMs(cwd: string): number | null;
  /** 最近完成一轮的总时长（毫秒，settled − start），或 null。 */
  getLastTurnMs(cwd: string): number | null;
  /** 进行中一轮的经过时间（毫秒，每秒增长）；无进行中的轮为 null。 */
  getCurrentElapsedMs(cwd: string): number | null;
  /** 订阅数据变化（渲染 hook）：live 节流、commit 立即。返回退订。 */
  onChange(callback: (change: TpsChange) => void): () => void;
};

type TpsEntry = {
  /** 当前轮起点（首次 agent_start）；null = 无进行中的轮。 */
  agentStartMs: number | null;
  /** 当前轮首个响应块；null = 本轮尚无输出。 */
  firstChunkMs: number | null;
  /** 本条消息的首个响应块（message_end 后重置）；null = 本条消息尚无输出。 */
  messageFirstChunkMs: number | null;
  /** 本轮累计输出 tokens。 */
  totalOutput: number;
  /** 本轮累计流式时间（各消息 firstChunk → message_end 之和，毫秒）。 */
  streamMs: number;
  lastTurnMs: number | null;
  lastTokPerSec: number | null;
  lastTtfbMs: number | null;
};

export function createTpsTracker(deps: TpsTrackerDeps = {}): TpsTracker {
  const getNowMs = deps.getNowMs ?? (() => Date.now());
  const entries = new Map<string, TpsEntry>();
  const changeCallbacks = new Set<(change: TpsChange) => void>();
  const notify = (change: TpsChange) => {
    for (const callback of changeCallbacks) callback(change);
  };

  const newEntry = (previous: TpsEntry | undefined): TpsEntry => ({
    agentStartMs: null,
    firstChunkMs: null,
    messageFirstChunkMs: null,
    totalOutput: 0,
    streamMs: 0,
    lastTurnMs: previous?.lastTurnMs ?? null,
    lastTokPerSec: previous?.lastTokPerSec ?? null,
    lastTtfbMs: previous?.lastTtfbMs ?? null,
  });

  return {
    onAgentStart(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      // 已在进行中（continue 段）→ 不重置起点，继续累计，无新数据变化。
      if (entry.agentStartMs === null) {
        entry.agentStartMs = getNowMs();
        entry.firstChunkMs = null;
        entry.messageFirstChunkMs = null;
        entry.totalOutput = 0;
        entry.streamMs = 0;
        notify("live");
      }
      entries.set(cwd, entry);
    },
    onAgentSettled(cwd) {
      const entry = entries.get(cwd);
      if (!entry || entry.agentStartMs === null) return;
      const nowMs = getNowMs();
      entry.lastTurnMs = nowMs - entry.agentStartMs;
      if (entry.firstChunkMs !== null) {
        entry.lastTtfbMs = entry.firstChunkMs - entry.agentStartMs;
      }
      if (entry.streamMs > 0 && entry.totalOutput > 0) {
        entry.lastTokPerSec = (entry.totalOutput / entry.streamMs) * 1000;
      }
      // 本轮结束：清空起点——实时值变 null，显示回退固定总时长。
      entry.agentStartMs = null;
      entries.set(cwd, entry);
      notify("commit");
    },
    onFirstChunk(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      const nowMs = getNowMs();
      // 本轮首个首块（TTFB 点）：幂等，后续块不重置。
      const firstRoundChunk = entry.firstChunkMs === null;
      // 本条消息的首块：message_end 后重置，无输出消息不污染下一条。
      const firstMessageChunk = entry.messageFirstChunkMs === null;
      if (firstRoundChunk) entry.firstChunkMs = nowMs;
      if (firstMessageChunk) entry.messageFirstChunkMs = nowMs;
      entries.set(cwd, entry);
      if (firstRoundChunk || firstMessageChunk) notify("live");
    },
    onMessageEnd(cwd, outputTokens) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      const nowMs = getNowMs();
      // 本条消息的流式时间（首块 → 结束）；无首块的消息不计。
      if (entry.messageFirstChunkMs !== null) {
        entry.streamMs += nowMs - entry.messageFirstChunkMs;
        entry.messageFirstChunkMs = null;
      }
      if (outputTokens > 0) {
        entry.totalOutput += outputTokens;
        notify("commit");
      }
      entries.set(cwd, entry);
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
      if (!entry || entry.agentStartMs === null) return null;
      return getNowMs() - entry.agentStartMs;
    },
    onChange(callback) {
      changeCallbacks.add(callback);
      return () => {
        changeCallbacks.delete(callback);
      };
    },
  };
}
