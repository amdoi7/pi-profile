/**
 * Tokens-per-second tracker for assistant message generation.
 *
 * Measures the wall-clock time between message_start and message_end of an
 * assistant message and divides the message's output token count by it.
 * Tracked per working directory so parallel sessions don't leak speeds.
 */

export type TpsTrackerDeps = {
  getNowMs(): number;
};

export type TpsTracker = {
  /** Called when an assistant message starts streaming. */
  onMessageStart(cwd: string): void;
  /**
   * Called when an assistant message completes. Returns the message's
   * generation speed in tokens per second, or null when the message cannot
   * be measured (no matching start, zero tokens, or zero elapsed time).
   */
  onMessageEnd(cwd: string, outputTokens: number): number | null;
  /** Speed of the most recently completed assistant message, or null. */
  getLast(cwd: string): number | null;
};

type TpsEntry = {
  startMs: number;
  lastTokPerSec: number | null;
};

export function createTpsTracker(deps: TpsTrackerDeps = {}): TpsTracker {
  const getNowMs = deps.getNowMs ?? (() => Date.now());
  const entries = new Map<string, TpsEntry>();

  return {
    onMessageStart(cwd) {
      const previous = entries.get(cwd);
      entries.set(cwd, {
        startMs: getNowMs(),
        lastTokPerSec: previous?.lastTokPerSec ?? null,
      });
    },
    onMessageEnd(cwd, outputTokens) {
      const entry = entries.get(cwd);
      if (!entry) return null;
      const elapsedMs = getNowMs() - entry.startMs;
      if (elapsedMs <= 0 || outputTokens <= 0) return null;
      const tokPerSec = (outputTokens / elapsedMs) * 1000;
      entry.lastTokPerSec = tokPerSec;
      return tokPerSec;
    },
    getLast(cwd) {
      return entries.get(cwd)?.lastTokPerSec ?? null;
    },
  };
}
