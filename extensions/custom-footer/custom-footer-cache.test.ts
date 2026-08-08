/**
 * Cache-miss detection tests.
 *
 * 语义与 pi 内部 cache-stats 对齐：miss = 上一次请求的 prompt 里本应
 * cache-read、实际被重新计费（input/cacheWrite）的 token；compaction
 * 重置基线；噪声底线 1024 token。
 */
import { describe, expect, test } from "vitest";
import { computeCacheWaste, NOISE_FLOOR_TOKENS } from "./custom-footer-cache.ts";

const noCostModel = { find: () => undefined };
const t = (n: number) => 1_700_000_000_000 + n * 60_000;

function msg(over: Record<string, unknown> = {}) {
	return {
		type: "message",
		message: {
			role: "assistant",
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			timestamp: t(0),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			...over,
		},
	};
}

describe("computeCacheWaste", () => {
	test("steady cache growth produces no miss", () => {
		const entries = [
			msg({ timestamp: t(0), usage: { input: 1_000, output: 100, cacheRead: 50_000, cacheWrite: 0 } }),
			msg({ timestamp: t(1), usage: { input: 2_000, output: 100, cacheRead: 52_000, cacheWrite: 0 } }),
			msg({ timestamp: t(2), usage: { input: 500, output: 100, cacheRead: 54_000, cacheWrite: 0 } }),
		];
		expect(computeCacheWaste(entries, noCostModel)).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 });
	});

	test("cache flush re-bills the previous prompt as a miss", () => {
		const entries = [
			msg({ timestamp: t(0), usage: { input: 4_570, output: 100, cacheRead: 120_832, cacheWrite: 0 } }),
			// 缓存整体失效：12.5 万 prompt 重新计费，仅 3072 命中缓存
			msg({ timestamp: t(1), usage: { input: 124_994, output: 200, cacheRead: 3_072, cacheWrite: 0 } }),
		];
		const missed = Math.min(4_570 + 120_832, 124_994 + 3_072) - 3_072;
		const waste = computeCacheWaste(entries, noCostModel);
		expect(waste.missCount).toBe(1);
		expect(waste.missedTokens).toBe(missed);
	});

	test("missedCost uses the paid rate minus the cache-read rate", () => {
		const entries = [
			msg({ timestamp: t(0), usage: { input: 4_570, output: 100, cacheRead: 120_832, cacheWrite: 0 } }),
			msg({
				timestamp: t(1),
				usage: {
					input: 124_994,
					output: 200,
					cacheRead: 3_072,
					cacheWrite: 0,
					cost: { input: 0.00874958, cacheRead: 4.3008e-6, total: 0.0087538808 },
				},
			}),
		];
		const missed = Math.min(4_570 + 120_832, 124_994 + 3_072) - 3_072;
		const paidPerToken = 0.00874958 / 124_994;
		const readPerToken = 4.3008e-6 / 3_072;
		const waste = computeCacheWaste(entries, noCostModel);
		expect(waste.missedCost).toBeCloseTo(missed * Math.max(0, paidPerToken - readPerToken), 6);
	});

	test("first message and zero-cache providers never count", () => {
		expect(computeCacheWaste([msg()], noCostModel)).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 });
		const entries = [
			msg({ usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } }),
			msg({ usage: { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 } }),
		];
		expect(computeCacheWaste(entries, noCostModel)).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 });
	});

	test("noise floor suppresses small gaps", () => {
		const entries = [
			msg({ timestamp: t(0), usage: { input: 500, output: 10, cacheRead: 50_000, cacheWrite: 0 } }),
			msg({
				timestamp: t(1),
				usage: { input: NOISE_FLOOR_TOKENS - 100, output: 10, cacheRead: 50_100, cacheWrite: 0 },
			}),
		];
		expect(computeCacheWaste(entries, noCostModel).missCount).toBe(0);
	});

	test("compaction resets the baseline so the next turn is not a miss", () => {
		const entries = [
			msg({ timestamp: t(0), usage: { input: 4_570, output: 100, cacheRead: 120_832, cacheWrite: 0 } }),
			{ type: "compaction", data: {} },
			msg({ timestamp: t(1), usage: { input: 60_000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
		];
		expect(computeCacheWaste(entries, noCostModel).missCount).toBe(0);
	});

	test("records idle gap and model switch as miss metadata", () => {
		const entries = [
			msg({ timestamp: t(0), usage: { input: 1_000, output: 10, cacheRead: 50_000, cacheWrite: 0 } }),
			msg({
				timestamp: t(10),
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 60_000, output: 10, cacheRead: 500, cacheWrite: 0 },
			}),
		];
		const waste = computeCacheWaste(entries, noCostModel);
		expect(waste.missCount).toBe(1);
		expect(waste.missedTokens).toBe(50_500);
	});

	test("returns zero totals for empty input", () => {
		expect(computeCacheWaste([], noCostModel)).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 });
	});
});
