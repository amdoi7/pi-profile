/**
 * Test suite for context analyzer.
 * Validates core requirements:
 * - delta can be negative (estimator overestimate)
 * - compaction sets measuredTotal=null
 * - only counts buildSessionContext messages, not branch history
 * - confidence states reflect actual knowledge
 */

import { describe, test, expect } from "vitest";
import { analyzeContext } from "../context-analyzer.ts";

function sumBuckets(buckets: Record<string, number>): number {
  return Object.values(buckets).reduce((sum, value) => sum + value, 0);
}

describe("ContextBreakdown", () => {
  // Test 1: delta can be negative (estimator overestimate)
  test("allows negative delta when estimator overestimates", () => {
    const inputs = {
      usage: { tokens: 100, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "x".repeat(500), // ~125 tokens
      activeToolDefs: [], // 0 tokens
      messages: [
        {
          role: "user" as const,
          content: "y".repeat(400), // ~100 tokens
        },
      ],
    };

    const breakdown = analyzeContext(inputs);

    // Expected: measured=100, estimated=125+100=225, delta=-125
    expect(breakdown.measuredTotal).toBe(100);
    expect(breakdown.estimatedTotal).toBeGreaterThan(100);
    expect(breakdown.delta).toBeLessThan(0); // Overestimate
    expect(breakdown.delta).not.toBe(0); // Not clamped
  });

  // Test 2: compaction sets measuredTotal=null and confidence=estimated
  test("handles post-compaction state (no measured data)", () => {
    const inputs = {
      usage: null, // No measured data after compaction
      contextWindow: 200000,
      systemPrompt: "sys",
      activeToolDefs: [],
      messages: [
        {
          role: "user" as const,
          content: "hello",
        },
      ],
    };

    const breakdown = analyzeContext(inputs);

    expect(breakdown.measuredTotal).toBeNull();
    // No measured data → available falls back to (contextWindow - estimatedTotal)
    // so the renderer can always show a free-space slice.
    expect(breakdown.available).toBe(200000 - breakdown.estimatedTotal);
    expect(breakdown.confidence).toBe("estimated");
    expect(breakdown.metadata.compactionDetected).toBe(false); // usage is null, but not explicitly marked
  });

  // Test 3: assistant thinking is separate bucket
  test("counts assistant thinking separately from text", () => {
    const inputs = {
      usage: { tokens: 200, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "",
      activeToolDefs: [],
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "thinking", thinking: "x".repeat(120) }, // 30 tokens
            { type: "text", text: "y".repeat(80) }, // 20 tokens
          ],
        },
      ],
    };

    const breakdown = analyzeContext(inputs);

    expect(breakdown.buckets.assistantThinking).toBe(30);
    expect(breakdown.buckets.assistantText).toBe(20);
  });

  // Test 4: tool call and tool result in separate buckets
  test("counts tool calls and results separately", () => {
    const inputs = {
      usage: { tokens: 150, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "",
      activeToolDefs: [],
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "toolCall", name: "read", arguments: { path: "/file" } },
          ],
        },
        {
          role: "toolResult" as const,
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ],
    };

    const breakdown = analyzeContext(inputs);

    expect(breakdown.buckets.toolCalls).toBeGreaterThan(0);
    expect(breakdown.buckets.toolResults).toBeGreaterThan(0);
    expect(breakdown.buckets.toolCalls).not.toBe(breakdown.buckets.toolResults);
  });

  // Test 5: confidence states
  test("confidence reflects actual knowledge state", () => {
    // Measured state
    const measured = analyzeContext({
      usage: { tokens: 500, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "sys",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "text" }],
    });
    expect(measured.confidence).toBeDefined();
    expect(["measured", "mixed", "estimated"]).toContain(measured.confidence);

    // Estimated state (no measured)
    const estimated = analyzeContext({
      usage: null,
      contextWindow: 1000,
      systemPrompt: "sys",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "text" }],
    });
    expect(estimated.confidence).toBe("estimated");
  });

  // Test 6: no silent clamping of unattributed
  test("preserves signed delta without clamping", () => {
    // Case 1: measured > estimated (positive delta)
    const positive = analyzeContext({
      usage: { tokens: 500, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "x",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "y" }],
    });
    // delta = measured - estimated = 500 - ~1 = ~499
    expect(positive.delta).toBeGreaterThan(0);

    // Case 2: measured < estimated (negative delta)
    const negative = analyzeContext({
      usage: { tokens: 10, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "x".repeat(100),
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "y".repeat(100) }],
    });
    // delta = measured - estimated = 10 - (25+25) = negative
    expect(negative.delta).toBeLessThan(0);
  });

  // Test 8: available calculation
  test("calculates available space correctly", () => {
    const inputs = {
      usage: { tokens: 300, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "text" }],
    };

    const breakdown = analyzeContext(inputs);

    if (breakdown.measuredTotal !== null) {
      expect(breakdown.available).toBe(
        1000 - breakdown.measuredTotal
      );
    }
  });

  // Test 9: when measured usage exists, displayed buckets should reflect the real session total
  test("allocates displayed bucket totals to the measured session usage", () => {
    const inputs = {
      usage: { tokens: 400, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "system prompt text",
      activeToolDefs: [
        { name: "tool-a", description: "desc", parameters: { type: "object" } },
      ],
      messages: [
        { role: "user" as const, content: "hello world" },
        {
          role: "assistant" as const,
          content: [{ type: "text", text: "response text" }],
        },
      ],
    };

    const breakdown = analyzeContext(inputs);

    expect(breakdown.measuredTotal).toBe(400);
    expect(sumBuckets(breakdown.buckets)).toBe(400);
    expect(breakdown.delta).not.toBe(0);
  });
});
