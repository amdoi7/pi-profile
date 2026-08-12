import { describe, expect, test } from "vitest";
import {
	computeSessionCost,
	computeTokenFlow,
	contextColor,
	extensionStatusLines,
	formatCacheWaste,
	formatCompact,
	formatDuration,
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

describe("formatDuration", () => {
	test("seconds under a minute stay bare", () => {
		expect(formatDuration(45_000)).toBe("45s");
	});
	test("minutes below an hour stay compact", () => {
		expect(formatDuration(65_000)).toBe("1m5s");
	});
	test("minutes carry into hours", () => {
		expect(formatDuration(90 * 60_000 + 51_000)).toBe("1h30m51s");
	});
	test("exact hour boundary", () => {
		expect(formatDuration(3_600_000)).toBe("1h0m0s");
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
		expect(formatCacheWaste(theme, waste)).toBe("miss 122k (2×)");
	});
	test("appends cost when material", () => {
		expect(formatCacheWaste(theme, { ...waste, missedCost: 0.012 })).toBe("miss 122k (2×) (+$0.01)");
	});
	test("omits cost below a cent", () => {
		expect(formatCacheWaste(theme, { ...waste, missedCost: 0.004 })).toBe("miss 122k (2×)");
	});
	test("renders single miss without plural marker", () => {
		expect(formatCacheWaste(theme, { ...waste, missCount: 1 })).toBe("miss 122k (1×)");
	});
});

describe("formatSessionRow", () => {
	test("renders context, token flow, cost and tps", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1234,
				tps: 42.4,
				ttfbMs: null,
				currentElapsedMs: null,
				flow: { input: 3_000, output: 400, reasoning: 0 },
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ ↑3k ↓400 $0.12 │ 42 t/s");
	});
	test("shows first-token time (ttfb) next to the tps", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1234,
				tps: 42.4,
				ttfbMs: 1_200,
				currentElapsedMs: null,
				turnMs: null,
				flow: null,
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ $0.12 │ 42 t/s ttfb1.2s");
	});
	test("shows turn duration in the completed dynamic group", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1,
				tps: 42.4,
				ttfbMs: null,
				currentElapsedMs: null,
				turnMs: 65_000,
				flow: { input: 3_000, output: 400, reasoning: 276 },
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ ↑3k ↓400 (τ69%) $0.10 │ 42 t/s 本轮1m5s");
	});
	test("live round shows same-round tps/ttfb once a message completed", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1,
				tps: 42.4,
				ttfbMs: 1_200,
				currentElapsedMs: 12_000,
				turnMs: null,
				flow: null,
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ $0.10 │ 42 t/s ttfb1.2s 本轮12s");
	});
	test("live round omits tps/ttfb until the first chunk arrives", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1,
				tps: null,
				ttfbMs: null,
				currentElapsedMs: 5_000,
				turnMs: null,
				flow: null,
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ $0.10 │ 本轮5s");
	});
	test("renders zero cost when the model has no price table", () => {
		expect(
			formatSessionRow(theme, { used: 12_000, pct: 52.3, contextWindow: 1_000_000, cost: 0, tps: null, ttfbMs: null, currentElapsedMs: null, turnMs: null, flow: null, waste: null }),
		).toBe("ctx: 12k/1M 52% │ $0.00");
	});
	test("omits cache counters (waste signal lives in the miss segment)", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1,
				tps: null,
				ttfbMs: null,
				currentElapsedMs: null,
				turnMs: null,
				flow: { input: 3_000, output: 400, reasoning: 0 },
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ ↑3k ↓400 $0.10");
	});
	test("omits cache and flow segments when unavailable", () => {
		expect(
			formatSessionRow(theme, {
				used: 12_000,
				pct: 52.3,
				contextWindow: 1_000_000,
				cost: 0.1234,
				tps: null,
				ttfbMs: null,
				currentElapsedMs: null,
				turnMs: null,
				flow: { input: 3_000, output: 400, reasoning: 0 },
				waste: null,
			}),
		).toBe("ctx: 12k/1M 52% │ ↑3k ↓400 $0.12");
	});
	test("renders placeholders and omits tps when unavailable", () => {
		expect(
			formatSessionRow(theme, { used: undefined, pct: undefined, contextWindow: 1_000_000, cost: 0, tps: null, ttfbMs: null, currentElapsedMs: null, turnMs: null, flow: null, waste: null }),
		).toBe("ctx: ? ? │ $0.00");
	});
});

describe("computeTokenFlow", () => {
	test("accumulates session totals across assistant messages", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 1_000, output: 100, reasoning: 10, cost: { total: 0.1 } } } },
			{ type: "message", message: { role: "assistant", usage: { input: 2_000, output: 300, reasoning: 30, cost: { total: 0.2 } } } },
			{ type: "message", message: { role: "user", usage: { input: 9_999, output: 9_999, reasoning: 9_999 } } },
		];
		expect(computeTokenFlow(entries)).toEqual({
			input: 3_000,
			output: 400,
			reasoning: 40,
		});
	});
	test("accumulates reasoning tokens as a subset of output", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 1_000, output: 400, reasoning: 276 } } },
		];
		expect(computeTokenFlow(entries)).toEqual({
			input: 1_000,
			output: 400,
			reasoning: 276,
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
		).toBe("⎇ main* ↑1↓3 !2");
	});
	test("renders clean branch without extras", () => {
		expect(formatGitSegment(theme, { branch: "main", dirtyCount: 0, ahead: 0, behind: 0 })).toBe(
			"⎇ main",
		);
	});
	test("renders in-flight git operation state label", () => {
		expect(
			formatGitSegment(theme, {
				branch: "main",
				dirtyCount: 5,
				ahead: 3,
				behind: 2,
				gitStateLabel: "REBASING 3/5",
			}),
		).toBe("⎇ main* ↑3↓2 !5 REBASING 3/5");
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
	const sessionRow = "ctx: 53k 20% │ ↑69k ↓29k │ 11 t/s";
	const usageLine = "5h ████░░░░ 42% (1h 2m)";
	// │ 的显示列(与 displayWidth 同口径:先剥 ANSI,CJK 双宽;
	// UTF-16 索引在 CJK 前会偏:上次 2 字符占 4 列)。
	const isWide = (c: number) =>
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) ||
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe4f) ||
		(c >= 0xff00 && c <= 0xff60) ||
		(c >= 0xffe0 && c <= 0xffe6) ||
		(c >= 0x20000 && c <= 0x2fffd);
	const pipeCols = (s: string) => {
		const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
		const cols: number[] = [];
		let col = 0;
		for (const ch of clean) {
			if (ch === "│") cols.push(col);
			col += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
		}
		return cols;
	};

	test("grid shares both separator columns across rows (cwd|branch ↔ ctx|flow)", () => {
		const [top, bottom] = layoutFooter(120, segments, sessionRow, usageLine, " │ ");
		expect(top).toBe(
			`cwd: ~/repo${" ".repeat(29)} │ ⎇ main${" ".repeat(3)} │ ${segments.model}`,
		);
		expect(bottom).toBe(
			`ctx: 53k 20%${" ".repeat(28)} │ ↑69k ↓29k │ 11 t/s${" ".repeat(4)}${usageLine}`,
		);
		// 前后两处 │ 列上下同列
		expect(pipeCols(top)).toEqual(pipeCols(bottom));
	});
	test("grid persists without usage, row 2 right side empty", () => {
		const [top, bottom] = layoutFooter(120, segments, sessionRow, null, " │ ");
		expect(bottom).toBe(`ctx: 53k 20%${" ".repeat(28)} │ ↑69k ↓29k │ 11 t/s`);
		expect(pipeCols(top)).toEqual(pipeCols(bottom));
	});
	test("left content longer than the band extends the grid", () => {
		const long = "cwd: ~/abcdefghijklmnopqrstuvwxyz-0123456789";
		const [top, bottom] = layoutFooter(120, { ...segments, cwd: long }, sessionRow, usageLine, " │ ");
		expect(top).toBe(`${long} │ ⎇ main${" ".repeat(3)} │ ${segments.model}`);
		expect(bottom).toBe(
			`ctx: 53k 20%${" ".repeat(32)} │ ↑69k ↓29k │ 11 t/s${" ".repeat(4)}${usageLine}`,
		);
		expect(pipeCols(top)).toEqual(pipeCols(bottom));
	});
	test("CJK keeps both separator columns aligned (上次 = 2 终端列)", () => {
		const cjk = "ctx: 5k 2% │ ↑5k ↓1k R26k W0 上次CH97% │ 11 t/s";
		const [top, bottom] = layoutFooter(120, segments, cjk, usageLine, " │ ");
		expect(top).toBe(
			`cwd: ~/repo${" ".repeat(29)} │ ⎇ main${" ".repeat(19)} │ ${segments.model}`,
		);
		expect(bottom).toBe(
			`ctx: 5k 2%${" ".repeat(30)} │ ↑5k ↓1k R26k W0 上次CH97% │ 11 t/s${" ".repeat(4)}${usageLine}`,
		);
		expect(pipeCols(top)).toEqual(pipeCols(bottom));
	});
	test("ANSI-wrapped segments do not inflate the grid (regression)", () => {
		const ansi = (s: string) => `\x1b[38;2;1;2;3m${s}\x1b[0m`;
		const cjk = `${ansi("ctx: 5k 2%")} │ ${ansi("↑5k ↓1k R26k W0 上次CH97%")} │ 11 t/s`;
		const cwd = ansi("cwd: ~/repo");
		const [top, bottom] = layoutFooter(120, { ...segments, cwd }, cjk, usageLine, " │ ");
		expect(top).toBe(
			`${cwd}${" ".repeat(29)} │ ⎇ main${" ".repeat(19)} │ ${segments.model}`,
		);
		expect(bottom).toBe(
			`${ansi("ctx: 5k 2%")}${" ".repeat(30)} │ ${ansi("↑5k ↓1k R26k W0 上次CH97%")} │ 11 t/s${" ".repeat(4)}${usageLine}`,
		);
		expect(pipeCols(top)).toEqual(pipeCols(bottom));
	});
	test("without branch the right column aligns instead of the grid", () => {
		expect(layoutFooter(120, { ...segments, branch: "" }, sessionRow, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(33)}${segments.model}`,
			`${sessionRow}${" ".repeat(11)}${usageLine}`,
		]);
	});
	test("below 100 the grid follows content without the band", () => {
		expect(layoutFooter(90, segments, sessionRow, usageLine, " │ ")).toEqual([
			`cwd: ~/repo${" ".repeat(26)}${segments.model}`,
			`${sessionRow}${" ".repeat(4)}${usageLine}`,
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
});

describe("extensionStatusLines", () => {
	test("collects non-empty lines across statuses", () => {
		const statuses = new Map([
			["build", "review running\nimpl queued"],
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
