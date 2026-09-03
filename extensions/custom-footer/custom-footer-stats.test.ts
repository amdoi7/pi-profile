import { describe, expect, test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { computeCacheWaste } from "./vendor/cache-stats.ts";
import { addUsageToTotals, createUsageTotals } from "./vendor/usage-totals.ts";
import { createSessionStats } from "./custom-footer-stats.ts";

const models = { getModel: () => undefined };

/** 官方 vendored 五桶加法：测试期望值直接由官方实现算出（不复制逻辑）。 */
function officialTotals(entries: ReturnType<typeof entryFor>[]) {
  const totals = createUsageTotals();
  for (const entry of entries) {
    if (entry.message?.usage) addUsageToTotals(totals, entry.message.usage);
  }
  return totals;
}

function assistantMessage(usage: AssistantMessage["usage"]): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    provider: "test-provider",
    model: "test-model",
    api: "anthropic-messages",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function usage(overrides: Partial<NonNullable<AssistantMessage["usage"]>> = {}): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function entryFor(message: AssistantMessage) {
  return {
    type: "message" as const,
    message: {
      role: message.role,
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
      usage: message.usage,
    },
  };
}

describe("custom footer session stats", () => {
  test("rebuild carries cacheRead/cacheWrite into flow and equals the official totals scan", () => {
    const messages = [
      assistantMessage(usage({ input: 5000, output: 200, reasoning: 50, cacheRead: 0, cacheWrite: 0 })),
      assistantMessage(usage({ input: 1000, output: 300, cacheRead: 44000, cacheWrite: 3000 })),
    ];
    const entries = messages.map(entryFor);

    const stats = createSessionStats();
    stats.rebuild(entries, models);
    const snapshot = stats.getSnapshot();

    expect(snapshot.flow).toEqual(officialTotals(entries));
    expect(snapshot.cost).toBe(officialTotals(entries).cost);
    expect(snapshot.waste).toEqual(computeCacheWaste(entries, models));
    expect(snapshot.flow?.cacheRead).toBe(44000);
    expect(snapshot.flow?.cacheWrite).toBe(3000);
  });

  test("message_end rebuild equals full scan for a message sequence", () => {
    // 官方全量语义：message_end 触发 rebuild；逐条递进的最终快照应等于一次全量。
    const messages = [
      // 第一条：大量 input 无缓存 → 建立 prev 基线（5000 prompt tokens）。
      assistantMessage(usage({ input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 })),
      // 第二条：应缓存读却被重新计费（cacheRead=0）→ miss（官方口径）。
      assistantMessage(usage({ input: 4000, output: 300, cacheRead: 0, cacheWrite: 0 })),
      // 第三条：正常缓存命中 → 无 miss。
      assistantMessage(usage({ input: 1000, output: 150, reasoning: 40, cacheRead: 4000, cacheWrite: 0 })),
    ];
    const entries = messages.map(entryFor);

    const stats = createSessionStats();
    stats.rebuild([], models);
    for (const m of messages) {
      stats.rebuild(entries.slice(0, messages.indexOf(m) + 1), models);
    }
    const snapshot = stats.getSnapshot();

    expect(snapshot.flow).toEqual(officialTotals(entries));
    expect(snapshot.cost).toBe(officialTotals(entries).cost);
    expect(snapshot.waste).toEqual(computeCacheWaste(entries, models));
  });

  test("rebuild resets the cache-waste baseline on compaction/branch_summary", () => {
    const messages = [
      assistantMessage(usage({ input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 })),
      assistantMessage(usage({ input: 4000, output: 300, cacheRead: 0, cacheWrite: 0 })),
    ];
    const entries = [
      ...messages.map(entryFor),
      { type: "compaction" as const },
      { type: "message" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "" }] } },
      ...messages.map(entryFor),
    ];

    const stats = createSessionStats();
    stats.rebuild(entries, models);

    // compaction 后基线重置：后半段第一条 message 无 prev → 无 miss；
    // 后半段第二条 miss = min(5000,4000)-0 = 4000（与前半段相同）。
    expect(stats.getSnapshot().waste).toEqual(computeCacheWaste(entries, models));
    expect(stats.getSnapshot().waste.missCount).toBe(2);
  });

  test("rebuild continues the prev baseline across entries", () => {
    const first = assistantMessage(usage({ input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 }));
    const second = assistantMessage(usage({ input: 4000, output: 300, cacheRead: 0, cacheWrite: 0 }));
    const entries = [entryFor(first), entryFor(second)];

    const stats = createSessionStats();
    stats.rebuild(entries, models);

    expect(stats.getSnapshot().waste).toEqual(computeCacheWaste(entries, models));
    expect(stats.getSnapshot().waste.missCount).toBe(1);
  });

  test("empty state yields null flow and zero cost/waste", () => {
    const stats = createSessionStats();
    stats.rebuild([], models);
    expect(stats.getSnapshot()).toEqual({
      flow: null,
      cost: 0,
      waste: { missedTokens: 0, missedCost: 0, missCount: 0 },
    });
  });

  test("rebuild ignores zero-usage messages like the full scan", () => {
    const stats = createSessionStats();
    stats.rebuild([], models);
    stats.rebuild(
      [
        { type: "message" as const, message: { role: "assistant" as const, usage: usage({ input: 0, output: 0 }) } },
        { type: "message" as const, message: { role: "user" as const, content: [] } },
      ],
      models,
    );

    expect(stats.getSnapshot().flow).toBeNull();
    expect(stats.getSnapshot().cost).toBe(0);
  });

  test("change hook fires on rebuild (commit semantics)", () => {
    let changes = 0;
    const stats = createSessionStats();
    stats.onChange(() => {
      changes += 1;
    });

    stats.rebuild([], models);
    expect(changes).toBe(1);
    stats.rebuild([], models);
    expect(changes).toBe(2);
    // 只读不触发
    stats.getSnapshot();
    expect(changes).toBe(2);
  });

  test("change hook unsubscribes", () => {
    let changes = 0;
    const stats = createSessionStats();
    const off = stats.onChange(() => {
      changes += 1;
    });
    off();

    stats.rebuild([], models);
    stats.rebuild([], models);
    expect(changes).toBe(0);
  });
});
