import { describe, expect, test } from "vitest";
import { createTpsTracker } from "./custom-footer-tps.ts";

describe("custom footer tps tracker (message rate + per-message ttfb)", () => {
  test("computes rate from the latest completed message stream phase", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 4_000;
    tracker.onFirstChunk("/repo");
    nowMs = 8_000;
    tracker.onMessageEnd("/repo", 120);
    nowMs = 10_000;
    tracker.onAgentSettled("/repo");

    // tps = 120 / (8000-4000)ms 流式段 = 30 t/s
    expect(tracker.getLast("/repo")).toBeCloseTo(30, 5);
    // ttfb = 4000-1000 = 3000ms(本条消息的 turn_start → 首块)
    expect(tracker.getLastTtfbMs("/repo")).toBe(3_000);
    // 本轮 = 10000-1000 = 9000ms(agent_start → agent_settled)
    expect(tracker.getLastTurnMs("/repo")).toBe(9_000);
    // 结束后实时值失效
    expect(tracker.getCurrentElapsedMs("/repo")).toBeNull();
  });

  test("ttfb is per message: each message uses its own turn_start", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    // 消息1:turn_start 1000,首块 3000,end 4000
    tracker.onTurnStart("/repo");
    nowMs = 3_000;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 300);
    expect(tracker.getLastTtfbMs("/repo")).toBe(2_000); // 3000-1000

    // 消息2:turn_start 5000,首块 5500,end 6000
    nowMs = 5_000;
    tracker.onTurnStart("/repo");
    nowMs = 5_500;
    tracker.onFirstChunk("/repo");
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 500);
    expect(tracker.getLastTtfbMs("/repo")).toBe(500); // 5500-5000,非轮起点
  });

  test("rate counts full output (reasoning included)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    // output 1000(含 reasoning 800):1000 / 2000ms = 500 t/s
    tracker.onMessageEnd("/repo", 1_000);
    nowMs = 5_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLast("/repo")).toBeCloseTo(500, 5);
  });

  test("the latest completed message replaces the previous rate", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 100); // 50 t/s
    nowMs = 5_000;
    tracker.onTurnStart("/repo"); // 消息2
    nowMs = 5_100;
    tracker.onFirstChunk("/repo"); // 消息级首块重新记录
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 300); // 300/(6000-5100)ms ≈ 333 t/s

    expect(tracker.getLast("/repo")).toBeCloseTo(300 / 900 * 1000, 5);
  });

  test("message without a first chunk does not update the rate", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 3_000;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 100); // 100 t/s
    nowMs = 5_000;
    tracker.onTurnStart("/repo");
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 100); // 无首块:不更新

    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
  });

  test("agent_start during an active round does not reset the start (continue)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onMessageEnd("/repo", 100); // 100 t/s
    nowMs = 4_000;
    tracker.onAgentStart("/repo"); // continue:轮起点不重置
    nowMs = 5_000;
    tracker.onTurnStart("/repo"); // 消息2 自己的请求点
    nowMs = 5_500;
    tracker.onFirstChunk("/repo");
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 100); // 100/(6000-5500)ms = 200 t/s
    nowMs = 7_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLastTtfbMs("/repo")).toBe(500); // 5500-5000(消息2 自己的)
    expect(tracker.getLast("/repo")).toBeCloseTo(200, 5);
    expect(tracker.getLastTurnMs("/repo")).toBe(6_000); // 7000-1000
  });

  test("keeps the previous values until the new round completes", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onMessageEnd("/repo", 100);
    nowMs = 4_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);

    // 新轮开始:完成前仍显示上一轮的值(显示层进行中不渲染 tps)
    nowMs = 5_000;
    tracker.onAgentStart("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
    expect(tracker.getLastTurnMs("/repo")).toBe(3_000);
  });

  test("live round elapsed grows while the round is active", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 5_000;
    expect(tracker.getCurrentElapsedMs("/repo")).toBe(4_000);
    nowMs = 12_000;
    expect(tracker.getCurrentElapsedMs("/repo")).toBe(11_000); // 每秒增长
  });

  test("records round duration even without output; tps stays null", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 0);
    nowMs = 3_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLast("/repo")).toBeNull();
    expect(tracker.getLastTtfbMs("/repo")).toBeNull();
    expect(tracker.getLastTurnMs("/repo")).toBe(2_000);
  });

  test("returns null for tps/ttfb without a first chunk", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 50);
    nowMs = 3_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLast("/repo")).toBeNull();
    expect(tracker.getLastTtfbMs("/repo")).toBeNull();
    expect(tracker.getLastTurnMs("/repo")).toBe(2_000);
  });

  test("tracks rounds per working directory independently", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo-a");
    tracker.onAgentStart("/repo-b");
    tracker.onTurnStart("/repo-a");
    tracker.onTurnStart("/repo-b");
    nowMs = 3_000;
    tracker.onFirstChunk("/repo-a");
    tracker.onFirstChunk("/repo-b");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo-a", 100);
    tracker.onMessageEnd("/repo-b", 300);
    nowMs = 5_000;
    tracker.onAgentSettled("/repo-a");
    tracker.onAgentSettled("/repo-b");

    expect(tracker.getLast("/repo-a")).toBeCloseTo(100, 5); // 100/(4000-3000)ms
    expect(tracker.getLast("/repo-b")).toBeCloseTo(300, 5);
  });

  test("round duration fixes at settle (no drift afterwards)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 5_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLastTurnMs("/repo")).toBe(4_000);

    nowMs = 30_000;
    expect(tracker.getLastTurnMs("/repo")).toBe(4_000); // 固定
    expect(tracker.getCurrentElapsedMs("/repo")).toBeNull();
  });

  test("notifies the change hook: live events throttle, commits flush", () => {
    const changes: string[] = [];
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });
    tracker.onChange((change) => changes.push(change));

    tracker.onAgentStart("/repo"); // 流式/等待期:节流
    expect(changes).toEqual(["live"]);
    tracker.onFirstChunk("/repo"); // 流式:节流
    expect(changes).toEqual(["live", "live"]);
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100); // 消息完成:立即
    expect(changes).toEqual(["live", "live", "commit"]);
    tracker.onAgentSettled("/repo"); // 本轮完成:立即
    expect(changes).toEqual(["live", "live", "commit", "commit"]);
  });

  test("change hook stays silent when a round event changes nothing", () => {
    const changes: string[] = [];
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });
    tracker.onChange((change) => changes.push(change));

    tracker.onAgentSettled("/repo"); // 无进行中的轮:无变化
    expect(changes).toEqual([]);
    tracker.onFirstChunk("/repo");
    expect(changes).toEqual(["live"]);
    tracker.onFirstChunk("/repo"); // 幂等:无变化
    expect(changes).toEqual(["live"]);
  });

  test("change hook unsubscribes", () => {
    const changes: string[] = [];
    const tracker = createTpsTracker({ getNowMs: () => 1_000 });
    const off = tracker.onChange((change) => changes.push(change));
    off();

    tracker.onAgentStart("/repo");
    tracker.onAgentSettled("/repo");
    expect(changes).toEqual([]);
  });
});
