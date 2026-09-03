/**
 * Session-level aggregate stats (token flow, cost, cache waste).
 *
 * 架构对齐官方：只有一个更新路径 = `rebuild(entries)`，内部全部走官方算法
 * （computeCacheWaste 全量 + 五桶累加）。message_end / session_start /
 * session_tree / session_compact 都触发 rebuild；render 只读快照（O(1)）。
 *
 * 不保留自造增量：官方 interactive-mode 本身就是每次需要时 computeCacheWaste
 * 全量（O(n)），本地 O(1) 增量是对官方语义的平行复刻——复刻即漂移源
 * （2026-08-27 本地复刻丢了 idleMs/modelChanged 归因的真实教训）。
 */

import {
  computeCacheWaste,
  type CacheWasteTotals,
  type ModelPriceSource,
} from "./vendor/cache-stats.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "./vendor/usage-totals.ts";

/**
 * 官方 cache-stats 的价格源形状是 { getModel(provider, modelId) }；调用方
 * （index.ts）手里是 modelRegistry（其 find 即 runtime.getModel 的包装），
 * 适配器只转字段名，不改变语义。
 */
export type CacheWasteModels = ModelPriceSource;
/** 缓存浪费汇总 = 官方 CacheWasteTotals（missedTokens/missedCost/missCount）。 */
export type CacheWaste = CacheWasteTotals;

export type RebuildEntries = import("@earendil-works/pi-coding-agent").SessionEntry[];

export type SessionStats = {
  /** 会话累计 token 流（官方 usage-totals 五桶，无 reasoning——官方无此桶）。 */
  flow: UsageTotals | null;
  cost: number;
  waste: CacheWaste;
};

export type SessionStatsHandle = {
  /** entries 被替换/新增（message_end / session_start / session_tree / session_compact）：O(n) 官方全量。 */
  rebuild(entries: RebuildEntries, models: CacheWasteModels): void;
  /** 当前快照（O(1) 读）。 */
  getSnapshot(): SessionStats;
  /** 订阅快照变化（渲染 hook，commit 语义）。返回退订。 */
  onChange(callback: () => void): () => void;
};

function emptyWaste(): CacheWaste {
  return { missedTokens: 0, missedCost: 0, missCount: 0 };
}

export function createSessionStats(): SessionStatsHandle {
  let flow: UsageTotals = createUsageTotals();
  let cost = 0;
  let waste = emptyWaste();
  const changeCallbacks = new Set<() => void>();
  const notify = () => {
    for (const callback of changeCallbacks) callback();
  };

  return {
    rebuild(entries: RebuildEntries, models) {
      // 官方全量：与官方 footer.js 完全同构——遍历全部条目，assistant 消息 +
      // 带 usage 的 toolResult 消息 + branch_summary/compaction 条目（usage 挂在
      // entry 上）都入官方五桶；compaction 摘要调用也有 token/cost，漏计是低估。
      // 不维护自研加法：官方 usage-totals 即加法本身（vendor/usage-totals.ts）。
      const totals = createUsageTotals();
      for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          addUsageToTotals(totals, entry.message.usage);
        } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
          addUsageToTotals(totals, entry.message.usage);
        } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
          addUsageToTotals(totals, entry.usage);
        }
      }
      flow = totals;
      cost = totals.cost;
      waste = computeCacheWaste(entries, models);
      notify();
    },
    getSnapshot() {
      return {
        flow:
          flow.input === 0 && flow.output === 0
            && flow.cacheRead === 0 && flow.cacheWrite === 0
            ? null
            : flow,
        cost,
        waste,
      };
    },
    onChange(callback) {
      changeCallbacks.add(callback);
      return () => {
        changeCallbacks.delete(callback);
      };
    },
  };
}

// 供等价性测试使用：官方口径的直接入口（cache-waste 与五桶加法均官方 vendored）。
export { computeCacheWaste } from "./vendor/cache-stats.ts";
// 官方常量：TTL（测试/诊断引用；NOISE_FLOOR 未由官方导出）。
export { CACHE_TTL_MS } from "./vendor/cache-stats.ts";
export { createUsageTotals, addUsageToTotals, type UsageTotals } from "./vendor/usage-totals.ts";