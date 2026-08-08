import { describe, expect, test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { computeCacheWaste } from "./custom-footer-cache.ts";
import { computeSessionCost, computeTokenFlow } from "./custom-footer-format.ts";
import { createSessionStats } from "./custom-footer-stats.ts";

const models = { find: () => undefined };

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
  test("rebuild equals the full-scan functions (flow / cost / waste)", () => {
    const messages = [
      assistantMessage(usage({ input: 5000, output: 200, reasoning: 50, cacheRead: 0, cacheWrite: 0 })),
      assistantMessage(usage({ input: 1000, output: 300, cacheRead: 4000, cacheWrite: 0 })),
    ];
    const entries = messages.map(entryFor);

    const stats = createSessionStats();
    stats.rebuild(entries, models);
    const snapshot = stats.getSnapshot();

    expect(snapshot.flow).toEqual(computeTokenFlow(entries));
    expect(snapshot.cost).toBe(computeSessionCost(entries));
    expect(snapshot.waste).toEqual(computeCacheWaste(entries, models));
  });

  test("incremental addMessage equals full scan for a message sequence", () => {
    const messages = [
      // 第一条：大量 input 无缓存 → 建立 prev 基线（5000 prompt tokens）。
      assistantMessage(usage({ input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 })),
      // 第二条：应缓存读却被重新计费（cacheRead=0）→ miss = min(5000,4000)-0 = 4000。
      assistantMessage(usage({ input: 4000, output: 300, cacheRead: 0, cacheWrite: 0 })),
      // 第三条：正常缓存命中 → 无 miss。
      assistantMessage(usage({ input: 1000, output: 150, reasoning: 40, cacheRead: 4000, cacheWrite: 0 })),
    ];
    const entries = messages.map(entryFor);

    const stats = createSessionStats();
    stats.rebuild([], models);
    for (const m of messages) {
      stats.addMessage(m, models);
    }
    const snapshot = stats.getSnapshot();

    expect(snapshot.flow).toEqual(computeTokenFlow(entries));
    expect(snapshot.cost).toBe(computeSessionCost(entries));
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

  test("increment continues the prev baseline after rebuild", () => {
    const first = assistantMessage(usage({ input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 }));
    const second = assistantMessage(usage({ input: 4000, output: 300, cacheRead: 0, cacheWrite: 0 }));
    const entries = [entryFor(first), entryFor(second)];

    const stats = createSessionStats();
    stats.rebuild([entryFor(first)], models);
    stats.addMessage(second, models);

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

  test("addMessage ignores non-usage and zero-usage messages like the full scan", () => {
    const stats = createSessionStats();
    stats.rebuild([], models);
    stats.addMessage(assistantMessage(undefined), models);
    stats.addMessage(assistantMessage(usage({ input: 0, output: 0 })), models);

    expect(stats.getSnapshot().flow).toBeNull();
    expect(stats.getSnapshot().cost).toBe(0);
  });
});
