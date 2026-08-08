import { describe, expect, test } from "vitest";
import {
	computeSessionCost,
	computeTokenFlow,
	contextColor,
	extensionStatusLines,
	formatCompact,
	formatGitSegment,
	formatModel,
	formatTokenStats,
	layoutFooter,
	type FooterTheme,
} from "./custom-footer-format.ts";

const theme: FooterTheme = {
	fg: (_name, text) => text,
};

describe("formatCompact", () => {
	test("formats thousands and millions", () => {
		expect(formatCompact(0)).toBe("0");
		expect(formatCompact(999)).toBe("999");
		expect(formatCompact(1_000)).toBe("1k");
		expect(formatCompact(1_499)).toBe("1k");
		expect(formatCompact(1_500)).toBe("2k");
		expect(formatCompact(999_999)).toBe("1000k");
		expect(formatCompact(1_000_000)).toBe("1M");
		expect(formatCompact(1_500_000)).toBe("1.5M");
		expect(formatCompact(2_000_000)).toBe("2M");
	});
});

describe("contextColor", () => {
	test("muted without any measurement", () => {
		expect(contextColor(undefined, undefined)).toBe("muted");
	});
	test("success below tripwires", () => {
		expect(contextColor(50, undefined)).toBe("success");
		expect(contextColor(69, undefined)).toBe("success");
		expect(contextColor(undefined, 100_000)).toBe("success");
		expect(contextColor(undefined, 399_999)).toBe("success");
	});
	test("warning between 70 and 84", () => {
		expect(contextColor(70, undefined)).toBe("warning");
		expect(contextColor(84, undefined)).toBe("warning");
	});
	test("error at or above tripwires", () => {
		expect(contextColor(85, undefined)).toBe("error");
		expect(contextColor(undefined, 400_000)).toBe("error");
		expect(contextColor(90, 500_000)).toBe("error");
	});
});

describe("formatTokenStats", () => {
	test("renders context, token flow, cost and tps", () => {
		expect(
			formatTokenStats(theme, {
				used: 12_000,
				pct: 52.3,
				cost: 0.1234,
				tps: 42.4,
				flow: { input: 3_000, output: 400, cacheRead: 20_000, cacheWrite: 2_000, cacheHitRate: 80.2 },
			}),
		).toBe("ctx: 12k 52% │ ↑3k ↓400 R20k W2k CH80% │ $0.12 42 t/s");
	});
	test("omits cache and flow segments when unavailable", () => {
		expect(
			formatTokenStats(theme, {
				used: 12_000,
				pct: 52.3,
				cost: 0.1234,
				tps: null,
				flow: { input: 3_000, output: 400, cacheRead: 0, cacheWrite: 0, cacheHitRate: null },
			}),
		).toBe("ctx: 12k 52% │ ↑3k ↓400 │ $0.12");
	});
	test("renders placeholders and omits tps when unavailable", () => {
		expect(
			formatTokenStats(theme, { used: undefined, pct: undefined, cost: 0, tps: null, flow: null }),
		).toBe("ctx: ? ? │ $0.00");
	});
});

describe("computeTokenFlow", () => {
	test("accumulates session totals and takes CH from the latest request", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 1_000, output: 100, cacheRead: 500, cacheWrite: 200, cost: { total: 0.1 } } } },
			{ type: "message", message: { role: "assistant", usage: { input: 2_000, output: 300, cacheRead: 4_500, cacheWrite: 1_800, cost: { total: 0.2 } } } },
			{ type: "message", message: { role: "user", usage: { input: 9_999, output: 9_999, cacheRead: 9_999, cacheWrite: 9_999 } } },
		];
		expect(computeTokenFlow(entries)).toEqual({
			input: 3_000,
			output: 400,
			cacheRead: 5_000,
			cacheWrite: 2_000,
			cacheHitRate: (4_500 / (4_500 + 2_000)) * 100,
		});
	});
	test("returns null without assistant usage", () => {
		expect(computeTokenFlow([])).toBeNull();
		expect(computeTokenFlow([{ type: "message", message: { role: "user" } }])).toBeNull();
	});
});

describe("formatGitSegment", () => {
	test("renders branch, dirty marker and ahead/behind", () => {
		expect(
			formatGitSegment(theme, { branch: "main", dirtyCount: 2, ahead: 1, behind: 3 }),
		).toBe("⎇ main* ↑1 ↓3 !2");
	});
	test("renders clean branch without extras", () => {
		expect(formatGitSegment(theme, { branch: "main", dirtyCount: 0, ahead: 0, behind: 0 })).toBe(
			"⎇ main",
		);
	});
	test("returns empty string for null status", () => {
		expect(formatGitSegment(theme, null)).toBe("");
	});
});

describe("formatModel", () => {
	test("joins provider and model when they differ", () => {
		expect(formatModel(theme, "anthropic", "claude-sonnet", "low")).toBe(
			"[anthropic/claude-sonnet · think:low]",
		);
	});
	test("keeps provider only when model matches", () => {
		expect(formatModel(theme, "local", "local", "high")).toBe("[local · think:high]");
	});
});

describe("computeSessionCost", () => {
	test("sums assistant message costs and skips other entries", () => {
		const entries = [
			{ type: "message", message: { role: "user", usage: { cost: { total: 5 } } } },
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
			{ type: "other", message: { role: "assistant", usage: { cost: { total: 99 } } } },
		];
		expect(computeSessionCost(entries)).toBeCloseTo(0.75, 5);
	});
});

describe("layoutFooter", () => {
	const segments = {
		model: "[provider/model · think:low]",
		providerOnly: "[provider · think:low]",
		cwd: "cwd: ~/repo",
		branch: "⎇ main",
	};
	const tokenStats = "ctx";
	const usageLine = "5h ████░░░░ 42% (1h 2m)";

	test("grid layout at wide widths aligns left and right columns", () => {
		expect(layoutFooter(120, segments, tokenStats, usageLine, " │ ")).toEqual([
			"cwd: ~/repo  [provider/model · think:low] │ ⎇ main",
			"ctx          5h ████░░░░ 42% (1h 2m)",
		]);
	});
	test("grid left column widens when ctx is the longest row", () => {
		const long = "ctx: 12k 52% $0.12";
		expect(layoutFooter(120, segments, long, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(long.length - segments.cwd.length + 2)}[provider/model · think:low] │ ⎇ main`,
			`${long}  ${usageLine}`,
		]);
	});
	test("grid omits branch between 72 and 99", () => {
		expect(layoutFooter(90, segments, tokenStats, usageLine, " │ ")).toEqual([
			"cwd: ~/repo  [provider/model · think:low]",
			"ctx          5h ████░░░░ 42% (1h 2m)",
		]);
	});
	test("three rows between 52 and 71", () => {
		expect(layoutFooter(60, segments, tokenStats, usageLine, " │ ")).toEqual([
			"cwd: ~/repo │ [provider · think:low]",
			tokenStats,
			usageLine,
		]);
	});
	test("keeps only cwd below 52 and omits usage row", () => {
		expect(layoutFooter(40, segments, tokenStats, usageLine, " │ ")).toEqual([
			"cwd: ~/repo",
			tokenStats,
		]);
	});
	test("grid omits branch segment when empty", () => {
		expect(layoutFooter(120, { ...segments, branch: "" }, tokenStats, usageLine, " │ ")).toEqual([
			"cwd: ~/repo  [provider/model · think:low]",
			"ctx          5h ████░░░░ 42% (1h 2m)",
		]);
	});
	test("falls back to rows when usage is unavailable", () => {
		expect(layoutFooter(120, segments, tokenStats, null, " │ ")).toEqual([
			"cwd: ~/repo │ [provider/model · think:low] │ ⎇ main",
			tokenStats,
		]);
	});
});

describe("extensionStatusLines", () => {
	test("collects non-empty lines across statuses", () => {
		const statuses = new Map([
			["pi-sub", "review running\nimpl queued"],
			["other", ""],
			["multi", "  \nline with spaces  "],
		]);
		expect(extensionStatusLines(statuses)).toEqual([
			"review running",
			"impl queued",
			"line with spaces  ",
		]);
	});
});
