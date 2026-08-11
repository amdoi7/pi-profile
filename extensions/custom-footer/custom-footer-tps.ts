/**
 * Message-rate tracker for the custom footer.
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
 * - TTFB = 本条消息首个响应块 − 本条消息的 turn_start(pi 事件 turn_start 在
 *   每条 LLM 响应发出前触发,每条消息独立测量;turn_start 缺失时回退
 *   agent_start)。
 * - t/s = 本轮速率,双消息源:
 *   - 实时源(进行中显示):message_end 增量——每条 assistant 消息完成时
 *     累加 usage.output(含 thinking——output 是服务端实际生成的 tokens,
 *     含 reasoning,pi 的 Usage 类型注释:reasoning 是 output 的子集)。
 *   - 批量源(settled 锁定):agent_end 事件的 messages 一次累加——官方
 *     消息源,不依赖事件流完整性;失败/aborted 消息没有 message_end
 *     (agent-loop 错误路径直接 emit agent_end),增量源会漏计,批量源
 *     包含其 usage.output。
 *   分子取批量源,分母 = 本轮墙钟(首次 agent_start → agent_settled,
 *   含工具执行与思考等待——端到端速率,与官方 TPS 口径一致)。
 * Tracked per working directory.
 *
 * 渲染 hook:数据变化通过 onChange 通知(live 节流 / commit 立即),
 * 事件处理器只更新数据,渲染调度集中在 index.ts 的 hook 回调。
 */

export type TpsTrackerDeps = {
  getNowMs(): number;
};

/** 变化语义：live = 流式/等待期（节流渲染），commit = 完成态（立即渲染）。 */
export type TpsChange = "live" | "commit";

/** agent_end 批量源的消息形状:只用 role 与 usage.output。 */
export type TpsBatchMessage = {
  role?: string;
  usage?: { output?: number };
};

export type TpsTracker = {
  /** 一轮（用户消息 → 不再输出）开始：本轮起点；进行中时（continue）幂等不重置。 */
  onAgentStart(cwd: string): void;
  /** agent_end 段批量消息：累加 assistant output 到本轮批量源（锁定值用）。 */
  onAgentEnd(cwd: string, messages: TpsBatchMessage[]): void;
  /** 一轮结束：锁定本轮时长与批量源速率，实时值失效。 */
  onAgentSettled(cwd: string): void;
  /** 每条 LLM 响应发出前触发：本条消息的 TTFB 起点。 */
  onTurnStart(cwd: string): void;
  /** 本条消息首个响应块到达（幂等，后续块不重置）。 */
  onFirstChunk(cwd: string): void;
  /**
   * 一条 assistant 消息完成:output(含 thinking)累加实时源,记录 TTFB。
   */
  onMessageEnd(cwd: string, outputTokens: number): void;
  /** 最近完成轮的速率（t/s，含 thinking，墙钟口径）；进行中返回实时值。 */
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
  /** 本条消息的 TTFB 起点（turn_start，每条 LLM 响应前触发）。 */
  turnStartMs: number | null;
  /** 本条消息的首个响应块（message_end 后重置）；null = 本条消息尚无输出。 */
  messageFirstChunkMs: number | null;
  /** 实时源：message_end 增量累计（进行中显示）。 */
  roundLiveOutput: number;
  /** 批量源：agent_end 段批量累计（settled 锁定）。 */
  roundBatchOutput: number;
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
    turnStartMs: null,
    messageFirstChunkMs: null,
    roundLiveOutput: 0,
    roundBatchOutput: 0,
    lastTurnMs: previous?.lastTurnMs ?? null,
    lastTokPerSec: previous?.lastTokPerSec ?? null,
    lastTtfbMs: previous?.lastTtfbMs ?? null,
  });

  return {
    onAgentStart(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      // 已在进行中（continue 段）→ 不重置起点，无新数据变化。
      if (entry.agentStartMs === null) {
        entry.agentStartMs = getNowMs();
        entry.turnStartMs = null;
        entry.messageFirstChunkMs = null;
        // 新轮：双源归零（continue 不清零）。
        entry.roundLiveOutput = 0;
        entry.roundBatchOutput = 0;
        notify("live");
      }
      entries.set(cwd, entry);
    },
    onAgentEnd(cwd, messages) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      let batchOutput = 0;
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const output = message.usage?.output;
        if (typeof output === "number" && output > 0) batchOutput += output;
      }
      if (batchOutput > 0) {
        entry.roundBatchOutput += batchOutput;
        entries.set(cwd, entry);
        notify("commit");
      }
    },
    onAgentSettled(cwd) {
      const entry = entries.get(cwd);
      if (!entry || entry.agentStartMs === null) return;
      const nowMs = getNowMs();
      entry.lastTurnMs = nowMs - entry.agentStartMs;
      // 锁定值用批量源（官方消息源，含失败消息 output）；无批量则不覆盖。
      if (entry.roundBatchOutput > 0) {
        entry.lastTokPerSec = (entry.roundBatchOutput / (nowMs - entry.agentStartMs)) * 1000;
      }
      // 本轮结束：清空起点——实时值变 null，显示回退固定总时长。
      entry.agentStartMs = null;
      entries.set(cwd, entry);
      notify("commit");
    },
    onTurnStart(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      // 每条 LLM 响应发出前触发：本条消息的 TTFB 起点。
      entry.turnStartMs = getNowMs();
      // 新响应开始：作废旧消息的首块标记（失败/aborted 消息无 message_end
      // 重置，残留首块会污染下一条的 TTFB——此处一并清）。
      entry.messageFirstChunkMs = null;
      entries.set(cwd, entry);
    },
    onFirstChunk(cwd) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      const nowMs = getNowMs();
      // 本条消息的首块：message_end 后重置，无输出消息不污染下一条。
      if (entry.messageFirstChunkMs === null) {
        entry.messageFirstChunkMs = nowMs;
        notify("live");
      }
      entries.set(cwd, entry);
    },
    onMessageEnd(cwd, outputTokens) {
      const entry = entries.get(cwd) ?? newEntry(undefined);
      const nowMs = getNowMs();
      const firstChunkMs = entry.messageFirstChunkMs;
      entry.messageFirstChunkMs = null;
      // TTFB = 本条消息首块 − 本条消息的 turn_start（缺失时回退轮起点）。
      if (firstChunkMs !== null) {
        const startMs = entry.turnStartMs ?? entry.agentStartMs;
        if (startMs !== null) {
          entry.lastTtfbMs = firstChunkMs - startMs;
        }
      }
      // 实时源：分子含 thinking——output 是服务端实际生成的 tokens（吞吐口径）。
      if (outputTokens > 0) {
        entry.roundLiveOutput += outputTokens;
        notify("commit");
      }
      entries.set(cwd, entry);
    },
    getLast(cwd) {
      const entry = entries.get(cwd);
      if (!entry) return null;
      // 进行中：实时值 = 实时源累计 / 当前经过时间；无累计则回退上一轮锁定值。
      if (entry.agentStartMs !== null) {
        if (entry.roundLiveOutput > 0) {
          const elapsedMs = getNowMs() - entry.agentStartMs;
          if (elapsedMs > 0) return (entry.roundLiveOutput / elapsedMs) * 1000;
        }
        return entry.lastTokPerSec;
      }
      return entry.lastTokPerSec;
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
