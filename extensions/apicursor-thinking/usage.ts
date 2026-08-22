/**
 * Usage accounting for apicursor.com.
 *
 * The gateway's `usage` block cannot be used as reported. Measured with curl
 * (system prompt of N filler words, `say ok` user turn, claude-opus-5):
 *
 *   N=10   → prompt_tokens 400450      N=1200 → prompt_tokens 7174
 *   N=50   → prompt_tokens 404449      N=1500 → prompt_tokens 7474
 *   N=800  → prompt_tokens 479450      N=1800 → prompt_tokens 7774
 *   N=1000 → prompt_tokens 499449
 *
 * i.e. below a size threshold the count is `399450 + 100·N` (a constant offset
 * plus a 100× multiplier) and above it `≈5974 + N` (real tokens plus the
 * hidden Cursor agent prompt). The same request repeated returns the same
 * number, so it is deterministic — but neither prefix-proportional nor
 * monotonic across turns.
 *
 * That matters beyond cosmetics: pi derives context fill, auto-compaction and
 * cost from `usage` (`calculateContextTokens` = totalTokens), so a 100×
 * inflated input turns the context bar and the cost readout into noise and can
 * trip compaction on a nearly empty session. Input is therefore estimated
 * locally with the same chars/4 heuristic pi uses for its own estimates, while
 * `completion_tokens` — which matched the generated text in every capture — is
 * kept when present.
 *
 * cacheRead/cacheWrite are reported as 0 because the gateway never sends a
 * cache field (no `prompt_tokens_details`): the upstream Cursor protocol does
 * carry `cacheReadTokens`/`cacheWriteTokens` in its `turnEnded` frame, but the
 * OpenAI-compat layer drops them, so on this provider cache is unobservable
 * rather than absent. 0 is the honest value, not a measurement.
 */

import type { Context, Usage } from "@earendil-works/pi-ai";

/** pi's own estimation heuristic (see compaction/estimateTokens). */
const CHARS_PER_TOKEN = 4;
/** pi's per-image char equivalent (see compaction ESTIMATED_IMAGE_CHARS). */
const IMAGE_CHARS = 4800;

const ZERO_COST: Usage["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/**
 * Estimated prompt tokens for what pi actually sends. Thinking blocks are
 * excluded: they carry no signature on this provider, so the OpenAI-completions
 * replay drops them. The hidden Cursor agent prompt is excluded as well — the
 * estimate measures pi's own context against the model window.
 */
export function estimateContextTokens(context: Context): number {
	let chars = context.systemPrompt?.length ?? 0;
	for (const tool of context.tools ?? []) chars += JSON.stringify(tool).length;
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			continue;
		}
		const content = message.content;
		if (typeof content === "string") {
			chars += content.length;
			continue;
		}
		for (const block of content) {
			chars += block.type === "text" ? block.text.length : IMAGE_CHARS;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Replace the gateway's prompt accounting with a local estimate, keep its
 * output count when it reported one, and zero the cache fields. Cost is left
 * at zero for the caller to fill with the model's price table.
 */
export function normalizeUsage(context: Context, reported: Usage | undefined, producedChars: number): Usage {
	const input = estimateContextTokens(context);
	const output = reported && reported.output > 0 ? reported.output : Math.ceil(producedChars / CHARS_PER_TOKEN);
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { ...ZERO_COST },
	};
}
