// Account model catalog: fetch :fetchAvailableModels and collapse the
// effort-tier wire ids into logical models, mirroring the omp fork's models.json.
// Pure functions — no I/O except fetchAvailableModels.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRouting } from "./types.ts";
import { API, DISCOVERY_PATH, ENDPOINTS, PROVIDER, UA } from "./types.ts";

interface ApiModelEntry {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	isInternal?: boolean;
}

const WIRE_EFFORTS = ["extra-low", "low", "medium", "high"] as const;
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Google thinking levels for google-level models, mirroring mapEffortToGoogleThinkingLevel.
// Pro routes minimal to LOW (its effort routing merges minimal into low); flash keeps MINIMAL.
const LEVEL_BY_EFFORT: Record<string, "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"> = {
	minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH",
};

// Budgets for budget-mode (Gemini 2.x / Claude), mirroring GOOGLE_THINKING.
const BUDGET_BY_EFFORT: Record<string, number> = {
	minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 24575, max: 32768,
};

export const FALLBACK_MODELS: Model<Api>[] = [
	wireModel("gemini-3.8-flash-low", "Gemini 3.8 Flash", { supportsThinking: true }),
	wireModel("claude-opus-4-6-thinking", "Claude Opus 4.6", { supportsThinking: true }),
];

function wireModel(id: string, name: string, m: ApiModelEntry): Model<Api> {
	return {
		id, name, api: API, provider: PROVIDER, baseUrl: ENDPOINTS[0],
		reasoning: m.supportsThinking === true,
		input: m.supportsImages ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.maxTokens ?? 200_000,
		maxTokens: m.maxOutputTokens ?? 64_000,
	} as Model<Api>;
}

/** Fetch the account catalog from the discovery endpoint. Returns null on failure. */
export async function fetchCatalog(access: string, signal?: AbortSignal): Promise<Model<Api>[] | null> {
	for (const ep of ENDPOINTS) {
		try {
			const r = await fetch(`${ep}${DISCOVERY_PATH}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "User-Agent": UA },
				body: "{}", signal,
			});
			if (!r.ok) continue;
			const payload = (await r.json()) as { models?: Record<string, ApiModelEntry> };
			const entries: Array<{ id: string; name: string; reasoning: boolean; maxTokens: number; contextWindow: number; input: ("text" | "image")[]; baseUrl: string }> = [];
			for (const id in payload.models ?? {}) {
				const m = payload.models![id];
				if (m.isInternal) continue;
				if (id.startsWith("chat_") || id.startsWith("tab_")) continue;
				entries.push({
					id, name: m.displayName ?? id, reasoning: m.supportsThinking === true,
					maxTokens: m.maxOutputTokens ?? 64_000, contextWindow: m.maxTokens ?? 200_000,
					input: m.supportsImages ? ["text", "image"] : ["text"], baseUrl: ep,
				});
			}
			if (entries.length) return collapse(entries);
		} catch {
			// try the next endpoint
		}
	}
	return null;
}

/** Map a wire id to its logical id + effort ("" when the id is not tiered). */
function logicalOf(wireId: string): { logical: string; effort: string } {
	if (/^gemini-3/.test(wireId)) {
		for (const t of WIRE_EFFORTS) {
			if (wireId.endsWith(`-${t}`)) return { logical: wireId.slice(0, -(t.length + 1)), effort: t };
		}
	}
	if (/^claude-/.test(wireId) && wireId.endsWith("-thinking")) {
		return { logical: wireId.slice(0, -"-thinking".length), effort: "thinking" };
	}
	return { logical: wireId, effort: "" };
}

interface WireEntry {
	id: string; name: string; reasoning: boolean; maxTokens: number; contextWindow: number; input: ("text" | "image")[]; baseUrl: string;
}

/** Group wire ids by logical id and build the routing table + thinking metadata. */
export function collapse(entries: WireEntry[]): Model<Api>[] {
	const groups = new Map<string, WireEntry[]>();
	for (const e of entries) {
		const { logical } = logicalOf(e.id);
		const g = groups.get(logical) ?? [];
		g.push(e);
		groups.set(logical, g);
	}

	const out: Model<Api>[] = [];
	for (const [logical, group] of groups) {
		const base = group[0];
		const best = group.reduce((a, b) => (b.maxTokens > a.maxTokens ? b : a));
		const isGemini3 = /^gemini-3/.test(logical);
		const isClaude = /^claude-/.test(logical);

		const routing: ModelRouting = {
			wire: {},
			googleLevel: isGemini3,
		};
		if (isGemini3) {
			const pick = (t: string) => group.find((e) => e.id.endsWith(`-${t}`))?.id ?? base.id;
			// minimal routes to the low tier (mirrors omp's effortRouting).
			routing.wire.off = pick("low");
			routing.wire.minimal = pick("low");
			routing.wire.low = pick("low");
			routing.wire.medium = pick("medium");
			routing.wire.high = pick("high");
			routing.wire.xhigh = pick("high");
			routing.wire.max = pick("high");
		} else if (isClaude) {
			const wire = group.find((e) => e.id.endsWith("-thinking"))?.id ?? base.id;
			for (const e of EFFORTS) routing.wire[e] = wire;
		} else {
			for (const e of EFFORTS) routing.wire[e] = base.id;
		}

		out.push({
			id: logical,
			name: base.name.replace(/\s*\([^)]*\)\s*$/, ""),
			api: API, provider: PROVIDER, baseUrl: best.baseUrl,
			reasoning: base.reasoning, input: best.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: best.contextWindow, maxTokens: best.maxTokens,
			thinkingLevelMap: buildThinkingLevelMap(routing),
			samplingParams: { antigravity: routing },
		} as Model<Api>);
	}
	out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return out;
}

/** pi levels -> provider values, so the level UI reflects what the model supports. */
export function buildThinkingLevelMap(routing: ModelRouting): Record<string, string | null> {
	const map: Record<string, string | null> = {};
	if (routing.googleLevel) {
		for (const [effort, level] of Object.entries(LEVEL_BY_EFFORT)) {
			map[effort] = level;
		}
		map.off = "MINIMAL"; // google-level models cannot fully disable
	} else {
		for (const [effort, budget] of Object.entries(BUDGET_BY_EFFORT)) {
			map[effort] = String(budget);
		}
		map.off = "0";
	}
	return map;
}

export { BUDGET_BY_EFFORT, LEVEL_BY_EFFORT };
