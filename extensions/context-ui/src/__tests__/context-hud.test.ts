import { describe, test, expect } from "vitest";
import { renderContextHud } from "../context-hud.ts";
import type { ContextBreakdown, HistoryMetrics } from "../types.ts";

describe("renderContextHud", () => {
  test("shows measured usage whenever the session has a real measured total", () => {
    const breakdown: ContextBreakdown = {
      measuredTotal: 400,
      contextWindow: 1000,
      available: 600,
      estimatedTotal: 250,
      buckets: {
        systemPrompt: 60,
        systemTools: 40,
        skills: 0,
        memory: 0,
        userText: 100,
        assistantText: 100,
        assistantThinking: 50,
        toolCalls: 25,
        toolResults: 25,
        images: 0,
        summaries: 0,
        custom: 0,
      },
      categoryBreakdown: {
        systemPrompt: 60,
        systemTools: 40,
        skills: 0,
        memoryFiles: 0,
        messages: 300,
        freeSpace: 500,
        autocompactBuffer: 100,
        extensionOverhead: 0,
      },
      delta: 150,
      confidence: "mixed",
      metadata: {
        compactionDetected: false,
        hasPostCompactionData: true,
        buildSessionContextMessageCount: 3,
      },
    };

    const history: HistoryMetrics = {
      branchDepth: 3,
      tagDistance: 2,
      nearestTag: "task-start",
      summaryCount: 0,
      compactionCount: 0,
    };

    const hud = renderContextHud(breakdown, history);

    expect(hud).toContain("400/1000");
    expect(hud).toContain("40.0%");
    expect(hud).not.toContain("250/1000");
  });
});
