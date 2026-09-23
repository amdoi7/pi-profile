import { describe, expect, test } from "vitest";
import {
	cacheHitRate,
	contextColor,
	extensionStatusLines,
	formatCacheHit,
	formatCacheWaste,
	formatCompact,
	formatDuration,
	formatGitSegment,
	formatModel,
	formatSessionRow,
	hashString,
	hslToRgb,
	layoutFooter,
	sessionAnchorHue,
	sessionAnchorRgb,
	thinkingLevelColor,
	usageBar,
	usageColor,
	type CacheWaste,
	type FooterTheme,
} from "./custom-footer-format.ts";
import { addUsageToTotals, createUsageTotals, getUsageCostBreakdown } from "./vendor/usage-totals.ts";

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

describe("contextColor (四档双阈值,借鉴 omp)", () => {
	test("muted without any measurement", () => {
		expect(contextColor(undefined, undefined, 1_000_000)).toBe("muted");
	});
	test("success below the first (absolute-token-derived) tripwire", () => {
		// 1M 窗口:150k token = 15%,15% 以下皆 success。
		expect(contextColor(10, undefined, 1_000_000)).toBe("success");
		expect(contextColor(undefined, 100_000, 1_000_000)).toBe("success");
	});
	test("warning at the 150k-token equivalent (1M 窗口 = 15%)", () => {
		expect(contextColor(15, undefined, 1_000_000)).toBe("warning");
	});
	test("小窗口 percent 先到,不用绝对 token 换算", () => {
		// 128k 窗口:150k 超出窗口(117%);warning 由 percent 50 触发。
		expect(contextColor(55, undefined, 128_000)).toBe("warning");
	});
	test("accent (purple→accent) at 270k-token equivalent (1M = 27%)", () => {
		expect(contextColor(30, undefined, 1_000_000)).toBe("accent");
		expect(contextColor(undefined, 300_000, 1_000_000)).toBe("accent");
	});
	test("error at 500k-token equivalent (1M = 50%)", () => {
		expect(contextColor(55, undefined, 1_000_000)).toBe("error");
		expect(contextColor(undefined, 500_000, 1_000_000)).toBe("error");
		expect(contextColor(60, 600_000, 1_000_000)).toBe("error");
	});
});

describe("cacheHitRate / formatCacheHit (omp cache_hit 口径)", () => {
	test("rate = cacheRead / (cacheRead + cacheWrite + input)", () => {
		expect(cacheHitRate({ cacheRead: 90, cacheWrite: 5, input: 5 })).toBeCloseTo(90, 5);
	});
	test("null without cache activity", () => {
		expect(cacheHitRate({ cacheRead: 0, cacheWrite: 0, input: 100 })).toBeNull();
	});
	test("hit/(hit+miss) 对 DeepSeek 型(cacheWrite=0)成立", () => {
		// miss 记在 input：命中 80 / 全部 100。
		expect(cacheHitRate({ cacheRead: 80, cacheWrite: 0, input: 20 })).toBeCloseTo(80, 5);
	});
	test("formatCacheHit 显示两位小数(clamped 0..100，与 omp cache_hit 对齐)", () => {
		expect(formatCacheHit(theme, 94.2)).toContain("94.20%");
		expect(formatCacheHit(theme, 150)).toContain("100.00%");
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
	const roundFlow = { input: 3_000, output: 400, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
	const roundFlowThinking = { input: 3_000, output: 400, reasoning: 276, cacheRead: 0, cacheWrite: 0 };
	const roundFlowZero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
	const base = {
		used: 12_000,
		pct: 52.3,
		contextWindow: 1_000_000,
		subscription: false,
		tps: null,
		ttfbMs: null,
		currentElapsedMs: null,
		turnMs: null,
		waste: null,
	};

	test("renders context, session cost, round flow and tps", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1234, roundFlow, tps: 42.4 }),
		).toBe("ctx: 12k/1M 52% $0.12 │ ↑3k ↓400 │ 42 t/s");
	});
	test("shows first-token time (ttfb) next to the tps", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1234, roundFlow: roundFlowZero, tps: 42.4, ttfbMs: 1_200 }),
		).toBe("ctx: 12k/1M 52% $0.12 │ 42 t/s ttfb1.2s");
	});
	test("shows turn duration in the completed dynamic group", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1, roundFlow: roundFlowThinking, tps: 42.4, turnMs: 65_000 }),
		).toBe("ctx: 12k/1M 52% $0.10 │ ↑3k ↓400 (τ69%) │ 42 t/s 本轮1m5s");
	});
	test("live round shows same-round tps/ttfb once a message completed", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1, roundFlow: roundFlowZero, tps: 42.4, ttfbMs: 1_200, currentElapsedMs: 12_000 }),
		).toBe("ctx: 12k/1M 52% $0.10 │ 42 t/s ttfb1.2s 本轮12s");
	});
	test("live round omits tps/ttfb until the first chunk arrives", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1, roundFlow: roundFlowZero, currentElapsedMs: 5_000 }),
		).toBe("ctx: 12k/1M 52% $0.10 │ 本轮5s");
	});
	test("renders zero cost when the model has no price table", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0, roundFlow: roundFlowZero }),
		).toBe("ctx: 12k/1M 52% $0.00");
	});
	test("omits cache counters (waste signal lives in the miss segment)", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1, roundFlow }),
		).toBe("ctx: 12k/1M 52% $0.10 │ ↑3k ↓400");
	});
	test("omits cache and flow segments when unavailable", () => {
		expect(
			formatSessionRow(theme, { ...base, sessionCost: 0.1234, roundFlow }),
		).toBe("ctx: 12k/1M 52% $0.12 │ ↑3k ↓400");
	});
	test("renders placeholders and omits tps when unavailable", () => {
		expect(
			formatSessionRow(theme, { ...base, used: undefined, pct: undefined, sessionCost: 0, roundFlow: null }),
		).toBe("ctx: ? ? $0.00");
	});

	test("miss segment hides below cost threshold (噪音不占行,2026-08-27 过载修复)", () => {
		const flow = { input: 523_000, output: 166_000, reasoning: 58_000, cacheRead: 52_900_000, cacheWrite: 0 };
		const opts = { ...base, used: 317_000, pct: 32, contextWindow: 1_000_000, sessionCost: 0.13, roundFlow: flow };
		// 97× 失效但仅 2 分钱：整段不显示。
		expect(formatSessionRow(theme, { ...opts, waste: { missedTokens: 293_000, missedCost: 0.02, missCount: 97 } })).not.toContain("miss");
		expect(formatSessionRow(theme, { ...opts, waste: { missedTokens: 293_000, missedCost: 0.02, missCount: 97 } })).not.toContain("R52.9M"); // R/W 段已裁
		// 真浪费（≥5 分）才显示。
		const loud = formatSessionRow(theme, { ...opts, waste: { missedTokens: 293_000, missedCost: 0.51, missCount: 97 } });
		expect(loud).toContain("miss 293k (97×) (+$0.51)");
		expect(loud).toContain("ℂ99.02%");
	});
	test("subscription shows S-prefixed cost (omp spend)", () => {
		const row = formatSessionRow(theme, { ...base, used: 100, pct: 10, contextWindow: 200_000, subscription: true, sessionCost: 0.75, roundFlow: null });
		expect(row).toContain("S0.75");
		expect(row).not.toContain("$0.75");
	});

});

describe("addUsageToTotals (vendored official usage-totals)", () => {
	test("accumulates five buckets and cost across entries", () => {
		const totals = createUsageTotals();
		addUsageToTotals(totals, { input: 1_000, output: 100, cacheRead: 500, cacheWrite: 50, cost: { total: 0.1 } });
		addUsageToTotals(totals, { input: 2_000, output: 300, cacheRead: 700, cacheWrite: 0, cost: { total: 0.2 } });
		expect(totals.input).toBe(3_000);
		expect(totals.output).toBe(400);
		expect(totals.cacheRead).toBe(1_200);
		expect(totals.cacheWrite).toBe(50);
		expect(totals.cost).toBeCloseTo(0.3, 10); // 官方原样浮点加法：0.1+0.2=0.30000000000000004
	});
	test("getUsageCostBreakdown groups by model and Tools/summaries", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", provider: "p1", model: "m1", usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } },
			{ type: "compaction", usage: { input: 2_000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
		];
		expect(getUsageCostBreakdown(entries as never)).toEqual([
			{ key: "p1/m1", cost: 0.5, tokens: 1_100 },
			{ key: "Tools/summaries", cost: 0.25, tokens: 2_200 },
		]);
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
	test("round-less session row stays left-aligned in the grid (空态不崩)", () => {
		// 会话起始无轮级数据：sessionRow 只有 session 段，网格退化为左对齐单列，
		// 不允许把空段拼成 `ctx ... │  │ `。
		const [top, bottom] = layoutFooter(120, segments, "ctx: 53k 20% $0.00", null, " │ ");
		expect(bottom).toBe("ctx: 53k 20% $0.00");
		expect(top).toContain("│ ⎇ main");
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
	test("collapsed cwd keeps separators aligned on wide terminals (… = 1 col, regression)", () => {
		// 折叠路径的全角省略号在等宽终端按 1 列渲染(与 displayWidth 同口径);
		// 若未来误将 … 算 2 列,pad 少 1,行1 第一个 │ 与行2 错位,此测试转红。
		const folded = "cwd: ~/…/ai4x/safety-supervision-agent";
		const [top, bottom] = layoutFooter(160, { ...segments, cwd: folded }, sessionRow, usageLine, " │ ");
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

describe("sessionAnchorRgb (真哈希色, omp session-color 思路)", () => {
	test("same id always maps to the same color", () => {
		expect(sessionAnchorRgb("sess-abc123")).toEqual(sessionAnchorRgb("sess-abc123"));
		expect(sessionAnchorRgb("abcdefgh")).toEqual(sessionAnchorRgb("abcdefgh"));
	});
	test("different ids spread across hues (not all the same)", () => {
		const ids = ["sess-a", "sess-b", "sess-c", "sess-d", "sess-e", "sess-f", "sess-g", "sess-h"];
		const hues = new Set(ids.map((id) => sessionAnchorHue(id)));
		expect(hues.size).toBeGreaterThan(1);
	});
	test("empty or missing id falls back to hue 0 (red)", () => {
		expect(sessionAnchorHue(undefined)).toBe(0);
		expect(sessionAnchorHue("")).toBe(0);
	});
	test("hashString is deterministic and unsigned", () => {
		expect(hashString("sess-abc123")).toBe(hashString("sess-abc123"));
		expect(hashString("x")).toBeGreaterThanOrEqual(0);
	});
	test("hslToRgb converts known values (red/cyan/green)", () => {
		expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
		expect(hslToRgb(180, 1, 0.5)).toEqual([0, 255, 255]);
		expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
	});
	test("sessionAnchorRgb outputs are in 0..255 range", () => {
		for (const id of ["a", "b", "c", "sess-xyz"]) {
			const [r, g, b] = sessionAnchorRgb(id);
			expect(r).toBeGreaterThanOrEqual(0);
			expect(r).toBeLessThanOrEqual(255);
			expect(g).toBeGreaterThanOrEqual(0);
			expect(g).toBeLessThanOrEqual(255);
			expect(b).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThanOrEqual(255);
		}
	});
});
