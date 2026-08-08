/**
 * Session-level aggregate stats (token flow, cost, cache waste) with
 * event-driven incremental updates.
 *
 * 架构：render 不再全量扫 entries（getEntries 本身是 O(n) filter + 三次 O(n)
 * 遍历，流式期间每秒 render 只有"本轮时长"在变）。改为：
 * - `message_end`（assistant）→ addMessage：O(1) 增量（含 cache-waste 的
 *   相邻消息对基线 prev）。
 * - entries 被替换（session_start / session_tree / session_compact，三个
 *   事件在 pi 中均在 entries 更新后触发）→ rebuild：O(n) 全量，唯一 O(n) 点。
 * - render → getSnapshot：O(1) 读。
 *
 * 增量与全量共用 format.ts 的 detectMiss/asPreviousRequest 纯函数，算法
 * 逐条等价（见 custom-footer-stats.test.ts 的等价性用例）。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  asPreviousRequest,
  computeCacheWaste,
  detectMiss,
  type CacheEntry,
  type CacheWaste,
  type CacheWasteModels,
  type PrevRequest,
} from "./custom-footer-cache.ts";
import {
	computeSessionCost,
	computeTokenFlow,
	type TokenFlow,
} from "./custom-footer-format.ts";

/** 宽 usage 形状：pi-ai Usage 与 cache-waste 的 CacheEntry 共用子集。 */
type UsageLike = NonNullable<NonNullable<CacheEntry["message"]>["usage"]>;

export type SessionStats = {
  flow: TokenFlow | null;
  cost: number;
  waste: CacheWaste;
};

export type SessionStatsHandle = {
  /** assistant 消息完成（message_end）：O(1) 增量。 */
  addMessage(message: AssistantMessage, models: CacheWasteModels): void;
  /** entries 被替换（session_start / session_tree / session_compact）：O(n) 全量重建。 */
  rebuild(entries: readonly CacheEntry[], models: CacheWasteModels): void;
  /** 当前快照（O(1) 读）。 */
  getSnapshot(): SessionStats;
};

function emptyWaste(): CacheWaste {
  return { missedTokens: 0, missedCost: 0, missCount: 0 };
}

export function createSessionStats(): SessionStatsHandle {
  let flow: TokenFlow = { input: 0, output: 0, reasoning: 0 };
  let cost = 0;
  let waste = emptyWaste();
  /** cache-waste 相邻消息对基线；compaction/branch_summary 时重置。 */
  let prev: PrevRequest | undefined;

  return {
    addMessage(message, models) {
      const usage = message.usage;
      if (usage) {
        accumulateUsage(usage);
      }
      const entry = toCacheEntry(message);
      const miss = detectMiss(prev, entry, models);
      if (miss) {
        waste.missedTokens += miss.missedTokens;
        waste.missedCost += miss.missedCost;
        waste.missCount += 1;
      }
      prev = asPreviousRequest(entry, prev?.reportedCache ?? false) ?? prev;
    },
    rebuild(entries, models) {
      flow = { input: 0, output: 0, reasoning: 0 };
      cost = 0;
      waste = emptyWaste();
      // 循环内使用局部 prev 链，结束再同步到闭包变量
      // （TS 对捕获变量在循环内的自引用赋值会推断为 never）。
      let localPrev: PrevRequest | undefined;
      for (const entry of entries) {
        if (entry.type === "compaction" || entry.type === "branch_summary") {
          localPrev = undefined;
          continue;
        }
        if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
        const usage = entry.message.usage;
        if (usage) {
          accumulateUsage(usage);
        }
        const miss = detectMiss(localPrev, entry, models);
        if (miss) {
          waste.missedTokens += miss.missedTokens;
          waste.missedCost += miss.missedCost;
          waste.missCount += 1;
        }
        localPrev = asPreviousRequest(entry, localPrev?.reportedCache ?? false) ?? localPrev;
      }
      prev = localPrev;
    },
    getSnapshot() {
      return {
        flow:
          flow.input === 0 && flow.output === 0 && flow.reasoning === 0 ? null : flow,
        cost,
        waste,
      };
    },
  };

  function accumulateUsage(usage: UsageLike): void {
    if (typeof usage.input === "number") flow.input += usage.input;
    if (typeof usage.output === "number") flow.output += usage.output;
    if (typeof usage.reasoning === "number") flow.reasoning += usage.reasoning;
    cost += usage.cost?.total ?? 0;
  }
}

/** message_end 的 assistant 消息 → cache-waste 全量算法的 entry 形状。 */
function toCacheEntry(message: AssistantMessage): CacheEntry {
  return {
    type: "message",
    message: {
      role: message.role,
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
      usage: message.usage,
    },
  };
}

// 供等价性测试使用：全量结果与增量结果对齐的口径。
export { computeCacheWaste, computeSessionCost, computeTokenFlow };
