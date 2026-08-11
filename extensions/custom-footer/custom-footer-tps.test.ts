import { describe, expect, test } from "vitest";
import { createTpsTracker } from "./custom-footer-tps.ts";

describe("custom footer tps tracker (round rate + per-message ttfb)", () => {
  test("settled rate uses the agent_end batch source (official message source)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100); // 实时源增量
    nowMs = 3_000;
    // 批量源:120 ≠ 增量 100(模拟 message_end 丢失/失败消息)→ 锁定值用批量源
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 120 } }]);
    nowMs = 4_000;
    tracker.onAgentSettled("/repo");

    // 锁定 tps = 120 / (4000-1000)ms 墙钟 = 40 t/s
    expect(tracker.getLast("/repo")).toBeCloseTo(40, 5);
    // 本轮 = 3000ms
    expect(tracker.getLastTurnMs("/repo")).toBe(3_000);
    // 结束后实时值失效
    expect(tracker.getCurrentElapsedMs("/repo")).toBeNull();
  });

  test("batch source accumulates across continue segments", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 3_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 100 } }]);
    nowMs = 5_000;
    // continue 段:第二次 agent_end,output 继续累加
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 50 } }]);
    nowMs = 6_000;
    tracker.onAgentSettled("/repo");

    // 锁定 tps = 150 / 5000ms = 30 t/s
    expect(tracker.getLast("/repo")).toBeCloseTo(30, 5);
  });

  test("aborted/failed message output is counted via the batch source", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 3_000;
    // 失败消息无 message_end(agent-loop 错误路径直接 agent_end),增量源漏计;
    // 批量源包含其 usage.output。
    tracker.onAgentEnd("/repo", [
      { role: "assistant", usage: { output: 200 } },
      { role: "assistant", usage: { output: 80 } },
      { role: "toolResult", content: [] }, // 非 assistant 不计
    ]);
    nowMs = 4_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLast("/repo")).toBeCloseTo(280 / 3 * 1000 / 1000, 5);
  });

  test("live rate while the round is active uses the incremental source", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100);
    // 实时 tps = 100 / (2000-1000)ms = 100 t/s
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);

    nowMs = 3_000;
    // 时间推进(工具间隙):output 不变,速率下降
    expect(tracker.getLast("/repo")).toBeCloseTo(100 / 2, 5);
  });

  test("live rate counts output even without a first chunk", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100); // 无首块:分母是墙钟,仍累计
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
  });

  test("settled without agent_end keeps the previous rate", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    // 轮 1:有批量源
    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 100 } }]);
    nowMs = 3_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100 / 2, 5);

    // 轮 2:无 agent_end(异常),不覆盖锁定值
    nowMs = 4_000;
    tracker.onAgentStart("/repo");
    nowMs = 5_000;
    tracker.onMessageEnd("/repo", 50);
    nowMs = 6_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(50, 5); // 上轮值保留
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
    nowMs = 4_000;
    // output 1000(含 reasoning 800):1000 / 3000ms = 333.3 t/s
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 1_000 } }]);
    nowMs = 5_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLast("/repo")).toBeCloseTo(1_000 / 4, 5);
  });

  test("message without a first chunk does not update ttfb", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 3_000;
    tracker.onFirstChunk("/repo");
    nowMs = 4_000;
    tracker.onMessageEnd("/repo", 100);
    expect(tracker.getLastTtfbMs("/repo")).toBe(2_000);

    nowMs = 5_000;
    tracker.onTurnStart("/repo");
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 100); // 无首块:ttfb 不更新
    expect(tracker.getLastTtfbMs("/repo")).toBe(2_000);
  });

  test("agent_start during an active round does not reset the start (continue)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    tracker.onTurnStart("/repo");
    nowMs = 2_000;
    tracker.onFirstChunk("/repo");
    nowMs = 3_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 100 } }]);
    nowMs = 4_000;
    tracker.onAgentStart("/repo"); // continue:轮起点不重置
    nowMs = 5_000;
    tracker.onTurnStart("/repo"); // 消息2 自己的请求点
    nowMs = 5_500;
    tracker.onFirstChunk("/repo");
    nowMs = 6_000;
    tracker.onMessageEnd("/repo", 100);
    nowMs = 7_000;
    tracker.onAgentSettled("/repo");

    expect(tracker.getLastTtfbMs("/repo")).toBe(500); // 5500-5000(消息2 自己的)
    expect(tracker.getLast("/repo")).toBeCloseTo(100 / 6, 5); // 100/(7000-1000)ms
    expect(tracker.getLastTurnMs("/repo")).toBe(6_000); // 7000-1000
  });

  test("new round keeps the previous rate; turn duration stays until it completes", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 100 } }]);
    nowMs = 3_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(50, 5);

    // 新轮开始:保留上一轮的值,本轮时长保留(完成态显示用)
    nowMs = 5_000;
    tracker.onAgentStart("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(50, 5);
    expect(tracker.getLastTurnMs("/repo")).toBe(2_000);
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

  test("returns null for tps/ttfb without any output or first chunk", () => {
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
    nowMs = 3_000;
    tracker.onAgentEnd("/repo-a", [{ role: "assistant", usage: { output: 100 } }]);
    tracker.onAgentEnd("/repo-b", [{ role: "assistant", usage: { output: 300 } }]);
    nowMs = 5_000;
    tracker.onAgentSettled("/repo-a");
    tracker.onAgentSettled("/repo-b");

    expect(tracker.getLast("/repo-a")).toBeCloseTo(100 / 4, 5); // 100/4000ms
    expect(tracker.getLast("/repo-b")).toBeCloseTo(300 / 4, 5);
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

  test("keeps the previous rate/ttfb across rounds (no clearing)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 100 } }]);
    nowMs = 3_000;
    tracker.onAgentSettled("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(50, 5);

    nowMs = 5_000;
    tracker.onAgentStart("/repo"); // 新轮:保留上一轮的值(不清空)
    expect(tracker.getLast("/repo")).toBeCloseTo(50, 5);

    nowMs = 6_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 200 } }]);
    nowMs = 7_000;
    tracker.onAgentSettled("/repo"); // 新轮完成:替换为它的值
    expect(tracker.getLast("/repo")).toBeCloseTo(200 / 2, 5); // 200/2000ms
  });

  test("in-round values survive continue (same round keeps its values)", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onAgentStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100);
    nowMs = 3_000;
    tracker.onAgentStart("/repo"); // continue:不重置轮内值
    expect(tracker.getLast("/repo")).toBeCloseTo(50, 5);
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
    nowMs = 3_000;
    tracker.onAgentEnd("/repo", [{ role: "assistant", usage: { output: 100 } }]); // 段批量:立即
    expect(changes).toEqual(["live", "live", "commit", "commit"]);
    tracker.onAgentSettled("/repo"); // 本轮完成:立即
    expect(changes).toEqual(["live", "live", "commit", "commit", "commit"]);
  });

  test("change hook stays silent when a round event changes nothing", () => {
    const changes: string[] = [];
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });
    tracker.onChange((change) => changes.push(change));

    tracker.onAgentSettled("/repo"); // 无进行中的轮:无变化
    expect(changes).toEqual([]);
    tracker.onAgentEnd("/repo", []); // 空批量:无变化
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
