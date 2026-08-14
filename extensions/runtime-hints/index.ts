/**
 * runtime-hints: triggered, once-per-session corrections appended to tool
 * results. Data-driven by the rule table in rules.ts; this module only owns
 * event normalization and the once-per-session guard.
 *
 * Channel contract: tool_result content append only. Hints never flip
 * isError, never rewrite existing content, and never block a call — the
 * result's semantics pass through untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { rules, type HintEvent } from "./rules.ts";

type ResultContent = Array<{ type: string; text?: string }>;

function normalize(event: {
	toolName: string;
	isError?: boolean;
	input: unknown;
	content: unknown;
}): HintEvent {
	const input = event.input as { command?: unknown } | undefined;
	const blocks = (Array.isArray(event.content) ? event.content : []) as ResultContent;
	const text = blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	return {
		toolName: event.toolName,
		isError: event.isError === true,
		command: typeof input?.command === "string" ? input.command : undefined,
		text,
	};
}

export default function runtimeHintsExtension(pi: ExtensionAPI) {
	const fired = new Set<string>();

	pi.on("session_start", () => {
		fired.clear();
	});

	pi.on("tool_result", (event) => {
		const hintEvent = normalize(event);
		for (const rule of rules) {
			if (fired.has(rule.name)) continue;
			const hint = rule.match(hintEvent);
			if (hint === undefined) continue;
			fired.add(rule.name);
			return { content: [...(event.content as ResultContent), { type: "text" as const, text: hint }] };
		}
		return undefined;
	});
}
