import { test } from "node:test";
import assert from "node:assert/strict";

import { dropThinkingFromHistory } from "./replay.ts";

const assistant = (content) => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "apicursor",
	model: "claude-opus-5",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
});

test("thinking blocks are removed, text and tool calls keep their order", () => {
	const context = {
		systemPrompt: "sys",
		messages: [
			{ role: "user", content: "q", timestamp: 0 },
			assistant([
				{ type: "thinking", thinking: "cot", thinkingSignature: "" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
			]),
			{ role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false },
		],
	};
	const out = dropThinkingFromHistory(context);
	assert.deepEqual(
		out.messages[1].content.map((b) => b.type),
		["text", "toolCall"],
	);
	assert.equal(out.messages[0], context.messages[0]);
	assert.equal(out.messages[2], context.messages[2]);
	assert.equal(out.systemPrompt, "sys");
});

test("input context is never mutated", () => {
	const message = assistant([
		{ type: "thinking", thinking: "cot", thinkingSignature: "" },
		{ type: "text", text: "answer" },
	]);
	const context = { messages: [message] };
	dropThinkingFromHistory(context);
	assert.equal(message.content.length, 2);
});

test("a history without thinking is returned unchanged", () => {
	const context = { messages: [assistant([{ type: "text", text: "answer" }])] };
	assert.equal(dropThinkingFromHistory(context), context);
});
