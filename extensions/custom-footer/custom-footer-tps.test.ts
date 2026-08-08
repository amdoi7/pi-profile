import { describe, expect, test } from "vitest";
import { createTpsTracker } from "./custom-footer-tps.ts";

describe("custom footer tps tracker", () => {
  test("computes tokens per second from message start to end", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onMessageStart("/repo");
    nowMs = 5_000;
    const tps = tracker.onMessageEnd("/repo", 120);

    expect(tps).toBeCloseTo(30, 5);
    expect(tracker.getLast("/repo")).toBeCloseTo(30, 5);
  });

  test("tracks speeds per working directory independently", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onMessageStart("/repo-a");
    tracker.onMessageStart("/repo-b");
    nowMs = 2_000;
    expect(tracker.onMessageEnd("/repo-a", 100)).toBeCloseTo(100, 5);
    expect(tracker.onMessageEnd("/repo-b", 300)).toBeCloseTo(300, 5);

    expect(tracker.getLast("/repo-a")).toBeCloseTo(100, 5);
    expect(tracker.getLast("/repo-b")).toBeCloseTo(300, 5);
  });

  test("returns null for message end without a matching start", () => {
    const tracker = createTpsTracker({ getNowMs: () => 1_000 });
    expect(tracker.onMessageEnd("/repo", 50)).toBeNull();
    expect(tracker.getLast("/repo")).toBeNull();
  });

  test("returns null when the message produced no output tokens", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onMessageStart("/repo");
    nowMs = 2_000;
    expect(tracker.onMessageEnd("/repo", 0)).toBeNull();
    expect(tracker.getLast("/repo")).toBeNull();
  });

  test("returns null when elapsed time is zero", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onMessageStart("/repo");
    expect(tracker.onMessageEnd("/repo", 50)).toBeNull();
  });

  test("keeps the previous speed when a new message starts", () => {
    let nowMs = 1_000;
    const tracker = createTpsTracker({ getNowMs: () => nowMs });

    tracker.onMessageStart("/repo");
    nowMs = 2_000;
    tracker.onMessageEnd("/repo", 100);

    tracker.onMessageStart("/repo");
    expect(tracker.getLast("/repo")).toBeCloseTo(100, 5);
  });
});
