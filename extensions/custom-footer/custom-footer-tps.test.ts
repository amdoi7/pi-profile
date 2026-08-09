import { describe, expect, test } from "vitest";
import { createTpsTracker } from "./custom-footer-tps.ts";

describe("custom footer tps tracker (user-round semantics)", () => {
  test("computes round tps from first chunk to settle", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 4_000;
    tracker.onFirstChunk("/repo");
    nowMs = 8_000;
    tracker.onMessageEnd("/repo", 120);
    nowMs = 10_000;
    tracker.onAgentSettled("/repo");

    // tps = 120 / (8000-4000)ms 流式段 = 30 t/s(不含 settled 前间隙)
    expect(tracker.getLast("/repo")).toBeCloseTo(30, 5);
    // ttfb = 4000-1000 = 3000ms
    expect(tracker.getLastTtfbMs("/repo")).toBe(3_000);
    // 本轮 = 10000-1000 = 9000ms
    expect(tracker.getLastTurnMs("/repo")).toBe(9_000);
    // 结束后实时值失效
    expect(tracker.getCurrentElapsedMs("/repo")).toBeNull();
  });

  test("accumulates output and streaming time across multiple messages", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 3_000;
    tracker.onFirstChunk("/repo"); // 消息1 首块
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 300); // 消息1 流式 1000ms
    nowMs = 5_000;
    tracker.onFirstChunk("/repo"); // 消息2 首块(消息级重置后重新记录)
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 500); // 消息2 流式 1000ms
    nowMs = 8_000;
    tracker.onAgentSettled("/repo");

    // tps = (300+500) / (1000+1000)ms 流式段 = 400 t/s(消息间隙不稀释)
    expect(tracker.getLast("/repo")).toBeCloseTo(400, 5);
    // ttfb = 3000-1000 = 2000ms(本轮首个首块)
    expect(tracker.getLastTtfbMs("/repo")).toBe(2_000);
  });

  test("message without a first chunk adds no streaming time (retry/continue)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 3_000;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 100); // 流式 1000ms
    nowMs = 5_000;
    tracker.onMessageEnd("/repo", 100); // 无首块的消息:不计流式时间
    nowMs = 6_000;
    tracker.onAgentSettled("/repo");

    // 总流式 = 1000ms,totalOutput = 200
    expect(tracker.getLast("/repo")).toBeCloseTo(200, 5);
  });

  test("agent_start during an active round does not reset the start (continue)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onMessageEnd("/repo", 100); // 流式 1000ms
    nowMs = 4_000;
    tracker.onAgentStart("/repo"); // retry/compaction 后的 continue:起点不重置
    nowMs = 5_000;
    tracker.onMessageEnd("/repo", 100); // 无首块,不计流式
    nowMs = 6_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLastTtfbMs("/repo")).toBe(1_000); // 2000-1000,而非 4000-4000
    expect(tracker.getLast("/repo")).toBeCloseTo(200, 5); // 200/1000ms 流式
    expect(tracker.getLastTurnMs("/repo")).toBe(5_000); // 6000-1000
  });

  test("keeps the previous round values until the new round completes", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onMessageEnd("/repo", 100);
    nowMs = 4_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5); // 100/(3000-2000)ms 流式

    // 新轮开始:完成前仍显示上一轮的值(不漂移)
    nowMs = 5_000;
    tracker.onAgentStart("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
    expect(tracker.getLastTurnMs("/repo")).toBe(3_000);
    expect(tracker.getLastTtfbMs("/repo")).toBe(1_000);
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

  test("records round duration even without output; tps/ttfb stay null", () => {
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
    nowMs = 3_000;
    tracker.onFirstChunk("/repo-a");
    tracker.onFirstChunk("/repo-b");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo-a", 100);
    tracker.onMessageEnd("/repo-b", 300);
    nowMs = 5_000;
    tracker.onAgentSettled("/repo-a");
    tracker.onAgentSettled("/repo-b");

    expect(tracker.getLast("/repo-a")).toBeCloseTo(100, 5); // 100/(4000-3000)ms 流式
    expect(tracker.getLast("/repo-b")).toBeCloseTo(300, 5); // 300/(4000-3000)ms 流式
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
    tracker.onMessageEnd("/repo", 100); // 消息完成(flow/cost 更新):立即
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
