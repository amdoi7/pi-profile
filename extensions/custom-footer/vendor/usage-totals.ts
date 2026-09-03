/**
 * Vendored from pi upstream, unmodified except for import paths and this header.
 *
 * Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/usage-totals.ts
 * Commit:  matches installed @earendil-works/pi-coding-agent 0.84.x dist
 * Version: @earendil-works/pi-coding-agent (installed dist matches this source)
 *
 * Why vendored: the package exports map only exposes the top-level entry, so a
 * bare-specifier deep import (`@earendil-works/pi-coding-agent/dist/core/usage-totals.js`)
 * fails with ERR_MODULE_NOT_FOUND (same reason as vendor/cache-stats.ts). The
 * footer must not maintain a parallel reimplementation of the five-bucket
 * addition — copy the official algorithm unchanged and reuse it.
 *
 * Import rewrite: `Usage` comes from the pi-ai top-level export
 * (`./types.ts` is re-exported at the top level), `SessionEntry` from the
 * official package exports (`./core/session-manager.ts` types are re-exported
 * at the top level); the original relative imports are resolved through the
 * same public surfaces.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();
	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;
		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}
	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
