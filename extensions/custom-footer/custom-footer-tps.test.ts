import { describe, expect, test } from "vitest";
import { createTpsTracker } from "./custom-footer-tps.ts";

describe("custom footer tps tracker", () => {
  test("computes tokens per second from first chunk to end (aio TTFB semantics)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    // message_start 不记时：首个响应块（TTFB 点）才是速率起点。
    nowMs = 4_000;
    tracker.onFirstChunk("/repo");
    nowMs = 5_000;
    const tps = tracker.onMessageEnd("/repo", 120);

    expect(tps).toBeCloseTo(120, 5);
    expect(tracker.getLast("/repo")).toBeCloseTo(120, 5);
  });

  test("first chunk is idempotent; later chunks keep the TTFB point", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onFirstChunk("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo"); // 后续块不重置起点
    nowMs = 3_000;
    const tps = tracker.onMessageEnd("/repo", 100);

    expect(tps).toBeCloseTo(50, 5); // (3000-1000)ms 而非 (3000-2000)ms
  });

  test("tracks speeds per working directory independently", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onFirstChunk("/repo-a");
    tracker.onFirstChunk("/repo-b");
    nowMs = 2_000;
    expect(tracker.onMessageEnd("/repo-a", 100)).toBeCloseTo(100, 5);
    expect(tracker.onMessageEnd("/repo-b", 300)).toBeCloseTo(300, 5);

    expect(tracker.getLast("/repo-a")).toBeCloseTo(100, 5);
    expect(tracker.getLast("/repo-b")).toBeCloseTo(300, 5);
  });

  test("returns null for message end without a first chunk (no streamed output)", () => {
    const tracker = createTpsTracker({ getNowMs: () => 1_000 });
    expect(tracker.onMessageEnd("/repo", 50)).toBeNull();
    expect(tracker.getLast("/repo")).toBeNull();
  });

  test("returns null when the message produced no output tokens", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onFirstChunk("/repo");
    nowMs = 2_000;
    expect(tracker.onMessageEnd("/repo", 0)).toBeNull();
    expect(tracker.getLast("/repo")).toBeNull();
  });

  test("returns null when elapsed time is zero", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onFirstChunk("/repo");
    expect(tracker.onMessageEnd("/repo", 50)).toBeNull();
  });

  test("records ttfb from turn start to first chunk", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    // TTFB 起点 = turn_start（LLM 请求发出点）；message_start 在响应头到达时才触发，
    // 与首块同批毫秒级（作起点会测得恒 0）。
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onMessageStart("/repo");
    nowMs = 3_500;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 100);

    expect(tracker.getLastTtfbMs("/repo")).toBe(2_500); // 3500-1000
    expect(tracker.getLast("/repo")).toBeCloseTo(200, 5);
  });

  test("ttfb falls back to message start when the turn has no start point", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    // 极端路径：消息没有前驱 turn_start（如会话中途注入），回退 message_start。
    tracker.onMessageStart("/repo");
    nowMs = 2_500;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onMessageEnd("/repo", 100);

    expect(tracker.getLastTtfbMs("/repo")).toBe(1_500); // 2500-1000
    expect(tracker.getLast("/repo")).toBeCloseTo(200, 5);
  });

  test("ttfb survives turn end (already computed at message end)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onMessageEnd("/repo", 100);
    tracker.onTurnEnd("/repo");

    expect(tracker.getLastTtfbMs("/repo")).toBe(1_000);
    nowMs = 30_000;
    expect(tracker.getLastTtfbMs("/repo")).toBe(1_000); // 固定，不漂移
  });

  test("ttfb is null without a start point", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onFirstChunk("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100);

    expect(tracker.getLastTtfbMs("/repo")).toBeNull();
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
  });

  test("records the turn duration at turn end", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onTurnStart("/repo");
    nowMs = 5_000;
    tracker.onTurnEnd("/repo");

    expect(tracker.getLastTurnMs("/repo")).toBe(4_000);
    // 结束后实时值失效：显示回退固定总时长（不漂移）。
    expect(tracker.getCurrentElapsedMs("/repo")).toBeNull();
    nowMs = 30_000;
    expect(tracker.getLastTurnMs("/repo")).toBe(4_000); // 固定
    expect(tracker.getCurrentElapsedMs("/repo")).toBeNull();
  });

  test("live turn elapsed grows while the turn is active", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onTurnStart("/repo");
    nowMs = 5_000;
    expect(tracker.getCurrentElapsedMs("/repo")).toBe(4_000);
    nowMs = 12_000;
    expect(tracker.getCurrentElapsedMs("/repo")).toBe(11_000); // 每秒增长
  });

  test("turn duration covers the whole agent loop (multiple messages)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onTurnStart("/repo");
    // 消息 1（思考 + 文本 + 工具调用）
    tracker.onMessageStart("/repo");
    nowMs = 3_500;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 50);
    // 消息 2（工具结果后的下一轮思考 + 文本）
    tracker.onMessageStart("/repo");
    nowMs = 7_500;
    tracker.onFirstChunk("/repo");
    nowMs = 8_000;
    tracker.onMessageEnd("/repo", 60);
    tracker.onTurnEnd("/repo");

    // 本轮总时长 = turn_start → turn_end = 7000ms（覆盖整个 agent 循环）。
    expect(tracker.getLastTurnMs("/repo")).toBe(7_000);
    // 最近消息的 tps（消息 2）。
    expect(tracker.getLast("/repo")).toBeCloseTo(120, 5);
  });

  test("keeps the previous speed when a new message starts", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onFirstChunk("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100);

    // 新消息的 TTFB 点到来时保留上次速率（footer 在新消息完成前仍显示旧值）。
    nowMs = 3_000;
    tracker.onFirstChunk("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
  });
});
