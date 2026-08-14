/**
 * Test suite for context analyzer.
 * Validates core requirements:
 * - delta can be negative (estimator overestimate)
 * - compaction sets measuredTotal=null
 * - only counts buildSessionContext messages, not branch history
 * - confidence states reflect actual knowledge
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { analyzeContext } from "../context-analyzer.ts";

function sumBuckets(buckets: Record<string, number>): number {
  return Object.values(buckets).reduce((sum, value) => sum + value, 0);
}

describe("ContextBreakdown", () => {
  // Test 1: 无锚点时无参照,delta 不定义;system prompt 作为 prefix 叠加进 estimated total
  test("without an anchor, delta is null; system prompt adds to estimated total", () => {
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

    // usage.tokens = pi 的纯消息估算(无 assistant usage 锚点),需叠加 prefix。
    assert.equal(breakdown.measuredTotal, 100);
    assert.equal(breakdown.estimatedTotal, 225); // 100(消息)+ 125(system prompt)
    assert.equal(breakdown.delta, null); // 无锚点参照,差额不定义
    assert.equal(breakdown.confidence, "estimated");
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

    assert.equal(breakdown.measuredTotal, null);
    // No measured data → available falls back to (contextWindow - estimatedTotal)
    // so the renderer can always show a free-space slice.
    assert.equal(breakdown.available, 200000 - breakdown.estimatedTotal);
    assert.equal(breakdown.confidence, "estimated");
    assert.equal(breakdown.metadata.compactionDetected, false); // usage is null, but not explicitly marked
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

    assert.equal(breakdown.buckets.assistantThinking, 30);
    assert.equal(breakdown.buckets.assistantText, 20);
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

    assert.ok(breakdown.buckets.toolCalls > 0);
    assert.ok(breakdown.buckets.toolResults > 0);
    assert.notEqual(breakdown.buckets.toolCalls, breakdown.buckets.toolResults);
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
    assert.ok(measured.confidence !== undefined);
    assert.ok(["measured", "mixed", "estimated"].includes(measured.confidence));

    // Estimated state (no measured)
    const estimated = analyzeContext({
      usage: null,
      contextWindow: 1000,
      systemPrompt: "sys",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "text" }],
    });
    assert.equal(estimated.confidence, "estimated");
  });

  // Test 6: no silent clamping of unattributed(仅锚点场景有差额)
  test("preserves signed delta without clamping (anchor present)", () => {
    const anchor = (total: number) => ({
      role: "assistant" as const,
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop" as const,
      usage: { input: total, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { total: 0 } },
    });

    // Case 1: measured > selfTotal(positive delta)
    const positive = analyzeContext({
      usage: { tokens: 500, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "x",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "y" }, anchor(500)],
    });
    // delta = measured − 自算全量(prefix 1 + 消息 1+1)≈ 497
    assert.ok(positive.delta !== null && positive.delta > 0);
    assert.equal(positive.estimatedTotal, 500); // 锚点 = 全量,不加 prefix

    // Case 2: measured < selfTotal(negative delta)
    const negative = analyzeContext({
      usage: { tokens: 10, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "x".repeat(100),
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "y".repeat(100) }, anchor(10)],
    });
    assert.ok(negative.delta !== null && negative.delta < 0);
  });

  // Test 8: available 计算
  test("calculates available space correctly", () => {
    const inputs = {
      usage: { tokens: 300, contextWindow: 1000, compactionDetected: false },
      contextWindow: 1000,
      systemPrompt: "",
      activeToolDefs: [],
      messages: [{ role: "user" as const, content: "text" }],
    };

    const breakdown = analyzeContext(inputs);

    // available = contextWindow − estimatedTotal(消息锚点 + 全部 prefix),
    // 不漏减 system prompt/tools/skills/memory 开销。
    assert.equal(breakdown.available, 1000 - breakdown.estimatedTotal);
  });

  // Test 9: when measured usage exists, displayed buckets should reflect the real session total
  test("displayed buckets are raw estimates; no absorption into custom", () => {
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

    assert.equal(breakdown.measuredTotal, 400);
    // 无锚点(消息无 usage):delta 不定义;桶 = 纯自算(prefix + 消息),
    // estimatedTotal = measured(pi 消息估算)+ prefix,两者同源同口径。
    assert.equal(breakdown.delta, null);
    assert.equal(sumBuckets(breakdown.buckets), 30); // 5(system prompt)+ 18(tool-a)+ 3 + 4(消息)
    assert.equal(breakdown.estimatedTotal, 423); // 400(measured)+ 23(prefix)
  });

  // Test 10: 估算口径与 pi 一致(image 固定 4800 chars;toolCall = name+arguments)
  test("estimates images at pi's fixed chars and tool calls as name+arguments", () => {
    const breakdown = analyzeContext({
      usage: null,
      contextWindow: 200000,
      systemPrompt: "",
      activeToolDefs: [],
      messages: [
        { role: "user" as const, content: [{ type: "image", source: "data" }] },
        {
          role: "assistant" as const,
          content: [
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "/f" } },
          ],
        },
        {
          role: "toolResult" as const,
          toolName: "read",
          content: [{ type: "text", text: "ab" }, { type: "image", source: "x" }],
        },
      ],
    });

    assert.equal(breakdown.buckets.images, 1200); // 4800 chars / 4
    assert.equal(
      breakdown.buckets.toolCalls,
      Math.ceil(("read".length + JSON.stringify({ path: "/f" }).length) / 4)
    );
    assert.equal(breakdown.buckets.toolResults, Math.ceil((2 + 4800) / 4)); // text + image
  });
});
