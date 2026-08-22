/**
 * Prefix-stability measurement — the only cache lever a client owns.
 *
 * First principles: a prompt-cache hit needs two things, and exactly one of them
 * is ours. (1) The server must keep a prefix cache and be told where to cut —
 * unknowable here, since this gateway reports no cache field whatever it does
 * with the breakpoints we send. (2) The bytes we send must repeat a previous
 * request's prefix verbatim — entirely under our control, and measurable without
 * any cooperation from the provider: serialise what this turn sends, diff it
 * against what the last turn sent, and report where the two stop agreeing.
 *
 * That makes "is the prefix cacheable" a local, falsifiable measurement instead
 * of a provider feature request. A stable prefix is a necessary condition for
 * caching on every provider, so the same number explains cache misses on links
 * that do cache (Anthropic-style) as well as on this one, which cannot.
 *
 * The serialisation mirrors what the gateway concatenates — tool schemas, system
 * prompt, then messages in order — rather than the exact wire bytes: divergence
 * position, not byte identity, is what identifies the breaker.
 */

import type { Context } from "@earendil-works/pi-ai";

export interface PayloadSegment {
	/** Stable identity of the segment: divergence is only meaningful per position. */
	label: string;
	text: string;
}

export interface PrefixReport {
	/** Segment count of the current request. */
	segments: number;
	/** Leading segments that are byte-identical to the previous request. */
	stableSegments: number;
	/** Chars reproduced verbatim from the previous request, including a partial segment. */
	stableChars: number;
	totalChars: number;
	/** stableChars / totalChars, 0 when there is nothing to compare against. */
	ratio: number;
	/** Where the two requests stopped agreeing; undefined when the prefix is fully reused. */
	firstDiverged?: string;
	/**
	 * True when divergence hits a position the previous request already occupied,
	 * i.e. history was rewritten rather than appended to. An append is normal and
	 * costs only the new tail; a rewrite destroys every downstream cache block and
	 * is always a client-side defect.
	 */
	rewrite: boolean;
	/** True for the first request of a session: no previous payload to compare. */
	cold: boolean;
}

/** Canonical, wire-ordered segments of what this request sends. */
export function describeContext(context: Context): PayloadSegment[] {
	const segments: PayloadSegment[] = [];
	if (context.tools && context.tools.length > 0) {
		segments.push({ label: "tools", text: JSON.stringify(context.tools) });
	}
	if (context.systemPrompt) segments.push({ label: "system", text: context.systemPrompt });
	context.messages.forEach((message, index) => {
		segments.push({ label: `${message.role}#${index}`, text: serializeMessage(message) });
	});
	return segments;
}

function serializeMessage(message: Context["messages"][number]): string {
	if (message.role === "assistant") {
		return message.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments)})`;
				return "";
			})
			.join("");
	}
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : `image:${block.data.length}`)).join("");
}

/** Longest common prefix length of two strings. */
function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

/**
 * How much of this request repeats the previous one verbatim. Appending a turn
 * keeps every earlier segment stable (ratio < 1 only because the tail is new);
 * rewriting an earlier message collapses the ratio and names the segment.
 */
export function comparePrefix(previous: PayloadSegment[] | undefined, current: PayloadSegment[]): PrefixReport {
	const totalChars = current.reduce((sum, segment) => sum + segment.text.length, 0);
	if (!previous) {
		return {
			segments: current.length,
			stableSegments: 0,
			stableChars: 0,
			totalChars,
			ratio: 0,
			rewrite: false,
			cold: true,
			...(current.length > 0 ? { firstDiverged: current[0].label } : {}),
		};
	}
	let stableSegments = 0;
	let stableChars = 0;
	let firstDiverged: string | undefined;
	let rewrite = false;
	const shared = Math.min(previous.length, current.length);
	for (let i = 0; i < shared; i++) {
		const before = previous[i];
		const after = current[i];
		if (before.label === after.label && before.text === after.text) {
			stableSegments++;
			stableChars += after.text.length;
			continue;
		}
		firstDiverged = after.label === before.label ? after.label : `${before.label}→${after.label}`;
		rewrite = true;
		if (before.label === after.label) stableChars += commonPrefixLength(before.text, after.text);
		break;
	}
	if (firstDiverged === undefined && current.length > previous.length) {
		firstDiverged = current[previous.length].label;
	}
	// Dropped history (compaction) is a rewrite too: the reused prefix shrank.
	if (!rewrite && current.length < previous.length) rewrite = true;
	return {
		segments: current.length,
		stableSegments,
		stableChars,
		totalChars,
		ratio: totalChars === 0 ? 0 : stableChars / totalChars,
		rewrite,
		cold: false,
		...(firstDiverged === undefined ? {} : { firstDiverged }),
	};
}
