/**
 * Cache-miss detection for the custom footer.
 *
 * 算法语义与 pi 内部 cache-stats 对齐（pi 未导出该模块，这里按同口径复刻）：
 * miss = 上一次请求的 prompt 中本应 cache-read、实际被重新计费
 * （input / cacheWrite 桶）的 token；compaction/分支摘要重置基线；
 * 噪声底线 1024 token；从未上报过缓存的提供商不计。
 *
 * 额外成本 = miss token × (实际付费单价 − 缓存读单价)。
 */

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const NOISE_FLOOR_TOKENS = 1024;

export type CacheWasteModel = { cost?: { cacheRead?: number } } | undefined;
export type CacheWasteModels = { find(provider: string, modelId: string): CacheWasteModel };

export type CacheWaste = {
  /** 本应命中缓存却被重新计费的 token 总数。 */
  missedTokens: number;
  /** 上述 token 按实际单价与缓存读单价之差计算的额外成本。 */
  missedCost: number;
  /** 检测到的缓存失效次数。 */
  missCount: number;
};

type CacheEntry = {
  type: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    timestamp?: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
    };
  };
};

type PrevRequest = {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
};

function detectMiss(
  prev: PrevRequest | undefined,
  entry: CacheEntry,
  models: CacheWasteModels,
): { missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean } | undefined {
  const u = entry.message?.usage;
  if (!u) return undefined;
  const input = u.input ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  // 首次请求、无 prompt、或从未上报缓存时的零缓存轮次不算 miss
  // （纯缓存读提供商零缓存 = 全 miss；不报缓存的提供商 = 无意义）。
  if (!prev || promptTokens <= 0 || (cacheRead + cacheWrite === 0 && !prev.reportedCache)) {
    return undefined;
  }
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  // 额外成本 = miss token × (实际付费单价 − 缓存读单价)。miss 只会落在
  // input/cacheWrite 桶，付费单价直接取自本条消息自己的成本拆分。
  const paidTokens = input + cacheWrite;
  const cost = u.cost;
  const paidPerToken = paidTokens > 0 && cost ? ((cost.input ?? 0) + (cost.cacheWrite ?? 0)) / paidTokens : 0;
  const readPerToken =
    cacheRead > 0 && cost && cost.cacheRead !== undefined
      ? cost.cacheRead / cacheRead
      : ((models.find(entry.message?.provider ?? "", entry.message?.model ?? "")?.cost?.cacheRead ?? 0) / 1_000_000);

  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, (entry.message?.timestamp ?? 0) - prev.timestamp),
    modelChanged:
      `${entry.message?.provider}/${entry.message?.model}` !== prev.modelKey,
  };
}

function asPreviousRequest(entry: CacheEntry, reportedCache: boolean): PrevRequest | undefined {
  const u = entry.message?.usage;
  if (!u) return undefined;
  const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: `${entry.message?.provider ?? ""}/${entry.message?.model ?? ""}`,
    timestamp: entry.message?.timestamp ?? 0,
    reportedCache: reportedCache || (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0,
  };
}

/**
 * 会话级缓存浪费汇总：应为缓存读却被重新计费的 prompt token。
 * compaction / 分支摘要使上下文合法变化，重置基线（换模型不豁免）。
 */
export function computeCacheWaste(entries: readonly CacheEntry[], models: CacheWasteModels): CacheWaste {
  let prev: PrevRequest | undefined;
  const totals: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const miss = detectMiss(prev, entry, models);
    if (miss) {
      totals.missedTokens += miss.missedTokens;
      totals.missedCost += miss.missedCost;
      totals.missCount += 1;
    }
    prev = asPreviousRequest(entry, prev?.reportedCache ?? false) ?? prev;
  }
  return totals;
}
