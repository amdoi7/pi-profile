import { describe, expect, test } from "vitest";
import {
	computeSessionCost,
	computeTokenFlow,
	contextColor,
	extensionStatusLines,
	formatCacheWaste,
	formatCompact,
	formatGitSegment,
	formatModel,
	formatSessionRow,
	layoutFooter,
	thinkingLevelColor,
	usageBar,
	usageColor,
	type CacheWaste,
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

describe("formatCacheWaste", () => {
	const waste: CacheWaste = { missedTokens: 122_330, missedCost: 0.0084, missCount: 2 };
	test("renders count and tokens", () => {
		expect(formatCacheWaste(theme, waste, false)).toBe("miss 122k (2×)");
	});
	test("appends cost when shown and material", () => {
		expect(formatCacheWaste(theme, { ...waste, missedCost: 0.012 }, true)).toBe("miss 122k (2×) (+$0.01)");
	});
	test("omits cost below a cent", () => {
		expect(formatCacheWaste(theme, { ...waste, missedCost: 0.004 }, true)).toBe("miss 122k (2×)");
	});
	test("renders single miss without plural marker", () => {
		expect(formatCacheWaste(theme, { ...waste, missCount: 1 }, false)).toBe("miss 122k (1×)");
	});
});

describe("formatSessionRow", () => {
	test("renders context, token flow, cost and tps", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				cost: 0.1234,
				tps: 42.4,
				flow: { input: 3_000, output: 400, cacheRead: 20_000, cacheWrite: 2_000 },
				waste: null,
				showMissCost: false,
			}),
		).toBe("ctx: 12k 52% │ ↑3k ↓400 R20k W2k │ $0.12 42 t/s");
	});
	test("hides cost when null (subscription providers)", () => {
		expect(
			formatSessionRow(theme, { used: 12_000, pct: 52.3, cost: null, tps: null, flow: null, waste: null, showMissCost: false }),
		).toBe("ctx: 12k 52%");
	});
	test("keeps zero cache counters visible as diagnostics", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				cost: 0.1,
				tps: null,
				flow: { input: 3_000, output: 400, cacheRead: 20_000, cacheWrite: 0 },
				waste: null,
				showMissCost: false,
			}),
		).toBe("ctx: 12k 52% │ ↑3k ↓400 R20k W0 │ $0.10");
	});
	test("omits cache and flow segments when unavailable", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				cost: 0.1234,
				tps: null,
				flow: { input: 3_000, output: 400, cacheRead: 0, cacheWrite: 0 },
				waste: null,
				showMissCost: false,
			}),
		).toBe("ctx: 12k 52% │ ↑3k ↓400 │ $0.12");
	});
	test("renders placeholders and omits tps when unavailable", () => {
		expect(
			formatSessionRow(theme, { used: undefined, pct: undefined, cost: 0, tps: null, flow: null, waste: null, showMissCost: false }),
		).toBe("ctx: ? ? │ $0.00");
	});
});

describe("computeTokenFlow", () => {
	test("accumulates session totals across assistant messages", () => {
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
			"anthropic/claude-sonnet · think:low",
		);
	});
	test("keeps provider only when model matches", () => {
		expect(formatModel(theme, "local", "local", "high")).toBe("local · think:high");
	});
});

describe("usageColor", () => {
	test("success in the healthy zone", () => {
		expect(usageColor(0)).toBe("success");
		expect(usageColor(49)).toBe("success");
	});
	test("neutral text once past half", () => {
		expect(usageColor(50)).toBe("text");
		expect(usageColor(69)).toBe("text");
	});
	test("warning from 70 to 89", () => {
		expect(usageColor(70)).toBe("warning");
		expect(usageColor(89)).toBe("warning");
	});
	test("error at 90 and above", () => {
		expect(usageColor(90)).toBe("error");
		expect(usageColor(100)).toBe("error");
	});
});

describe("thinkingLevelColor", () => {
	test("maps every level to its thinking token", () => {
		expect(thinkingLevelColor("off")).toBe("thinkingOff");
		expect(thinkingLevelColor("minimal")).toBe("thinkingMinimal");
		expect(thinkingLevelColor("low")).toBe("thinkingLow");
		expect(thinkingLevelColor("medium")).toBe("thinkingMedium");
		expect(thinkingLevelColor("high")).toBe("thinkingHigh");
		expect(thinkingLevelColor("xhigh")).toBe("thinkingXhigh");
		expect(thinkingLevelColor("max")).toBe("thinkingMax");
	});
	test("unknown levels stay muted", () => {
		expect(thinkingLevelColor("ultra")).toBe("muted");
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

describe("usageBar", () => {
	test("renders full and empty cells", () => {
		expect(usageBar(0)).toBe("░░░░░░░░");
		expect(usageBar(50)).toBe("████░░░░");
		expect(usageBar(100)).toBe("████████");
	});
	test("keeps low percentages visible with eighth-block cells", () => {
		expect(usageBar(3)).toBe("▎░░░░░░░");
		expect(usageBar(7)).toBe("▋░░░░░░░");
		expect(usageBar(13)).toBe("█▏░░░░░░");
		expect(usageBar(99)).toBe("███████▉");
	});
});

describe("layoutFooter", () => {
	const segments = {
		model: "provider/model · think:low",
		providerOnly: "provider · think:low",
		cwd: "cwd: ~/repo",
		branch: "⎇ main",
	};
	const sessionRow = "ctx";
	const usageLine = "5h ████░░░░ 42% (1h 2m)";
	const rightTop = "provider/model · think:low │ ⎇ main";

	test("wide layout pads the left column to the designed band", () => {
		expect(layoutFooter(120, segments, sessionRow, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(33)}${rightTop}`,
			`ctx${" ".repeat(41)}${usageLine}`,
		]);
	});
	test("left content longer than the band extends the grid", () => {
		const long = "ctx: 12k 52% $0.12";
		expect(layoutFooter(120, segments, long, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(33)}${rightTop}`,
			`${long}${" ".repeat(44 - long.length)}${usageLine}`,
		]);
	});
	test("below 100 the grid follows content without the band", () => {
		expect(layoutFooter(90, segments, sessionRow, usageLine, " │ ")).toEqual([
			`cwd: ~/repo    ${segments.model}`,
			`ctx${" ".repeat(12)}${usageLine}`,
		]);
	});
	test("three rows between 52 and 71", () => {
		expect(layoutFooter(60, segments, sessionRow, usageLine, " │ ")).toEqual([
			"cwd: ~/repo │ provider · think:low",
			sessionRow,
			usageLine,
		]);
	});
	test("keeps only cwd below 52 and omits usage row", () => {
		expect(layoutFooter(40, segments, sessionRow, usageLine, " │ ")).toEqual([
			"cwd: ~/repo",
			sessionRow,
		]);
	});
	test("grid omits branch segment when empty", () => {
		expect(layoutFooter(120, { ...segments, branch: "" }, sessionRow, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(33)}${segments.model}`,
			`ctx${" ".repeat(41)}${usageLine}`,
		]);
	});
	test("grid persists without usage, right column empty", () => {
		expect(layoutFooter(120, segments, sessionRow, null, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(33)}${rightTop}`,
			"ctx",
		]);
	});
	test("CJK content keeps the shared right column (上次 = 2 终端列)", () => {
		const cjk = "ctx: 5k 2% │ ↑5k ↓1k R26k W0 上次CH97%";
		// JS 长度 36，终端宽度 38（上次 占 4 列）；右列仍与 ASCII 行同一起点 44
		expect(layoutFooter(120, segments, cjk, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(33)}${rightTop}`,
			`${cjk}${" ".repeat(6)}${usageLine}`,
		]);
	});
	test("ANSI-wrapped content does not inflate the grid (regression)", () => {
		const ansi = (s: string) => `\x1b[38;2;1;2;3m${s}\x1b[0m`;
		const cjk = ansi("ctx: 5k 2% │ ↑5k ↓1k R26k W0 上次CH97%");
		const cwd = ansi("cwd: ~/repo");
		// truecolor 转义每条 16 字符：若不剥 ANSI，行 1 右列会被推到 ~100 列外
		expect(layoutFooter(120, { ...segments, cwd }, cjk, usageLine, " │ ")).toEqual([
			`${cwd}${" ".repeat(33)}${rightTop}`,
			`${cjk}${" ".repeat(6)}${usageLine}`,
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
