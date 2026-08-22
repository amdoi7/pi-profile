/**
 * History replay shaping for apicursor.com.
 *
 * The gateway flattens every request into one Cursor `userMessage`, so anything
 * kept in the replayed history is re-sent — and re-prefilled — on every single
 * turn, with no cache to amortise it (see index.ts). Chain of thought is pure
 * waste there: Cursor has no channel that consumes it, and the model already
 * produced its answer from it.
 *
 * pi's OpenAI-completions adapter happens to drop thinking blocks whose
 * `thinkingSignature` is empty, which is the shape ThinkingSplitter produces.
 * That is an emergent property of another module's compat logic, not a
 * guarantee: `requiresThinkingAsText` or a non-empty signature would put the
 * chain of thought back on the wire. Dropping it here makes it this provider's
 * own contract, verified by wire-replay.test.mjs.
 */

import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";

/**
 * Context with every assistant thinking block removed. Text blocks, tool calls
 * and message order are preserved; the input context is not mutated.
 */
export function dropThinkingFromHistory(context: Context): Context {
	let changed = false;
	const messages: Message[] = context.messages.map((message) => {
		if (message.role !== "assistant") return message;
		const kept = message.content.filter((block) => block.type !== "thinking");
		if (kept.length === message.content.length) return message;
		changed = true;
		return { ...message, content: kept } satisfies AssistantMessage;
	});
	return changed ? { ...context, messages } : context;
}
