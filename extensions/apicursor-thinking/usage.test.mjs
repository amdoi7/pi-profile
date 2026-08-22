/**
 * Usage normalisation tests. The reported numbers below are real captures from
 * apicursor.com (see usage.ts): a 100×-inflated prompt count, no cache field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateContextTokens, normalizeUsage } from "./usage.ts";

const reported = {
	input: 400450,
	output: 26,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 400476,
	cost: { input: 2.0, output: 0.00065, cacheRead: 0, cacheWrite: 0, total: 2.00065 },
};

test("input is estimated from the payload, not taken from the gateway", () => {
	const context = {
		systemPrompt: "s".repeat(400),
		tools: [],
		messages: [{ role: "user", content: "u".repeat(400), timestamp: 0 }],
	};
	const usage = normalizeUsage(context, reported, 104);
	assert.equal(usage.input, 200);
	assert.equal(usage.output, 26);
	assert.equal(usage.totalTokens, 226);
});

test("output falls back to the generated text when the gateway reports none", () => {
	const context = { messages: [] };
	const usage = normalizeUsage(context, { ...reported, output: 0 }, 400);
	assert.equal(usage.output, 100);
});

test("cache fields stay zero: the gateway sends no cache signal", () => {
	const usage = normalizeUsage({ messages: [] }, reported, 0);
	assert.equal(usage.cacheRead, 0);
	assert.equal(usage.cacheWrite, 0);
	assert.deepEqual(usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("estimate covers tools, tool calls and tool results, and skips thinking", () => {
	const context = {
		systemPrompt: "",
		tools: [{ name: "bash", description: "d", parameters: { type: "object" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "x".repeat(40) }], timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "y".repeat(40) },
					{ type: "thinking", thinking: "z".repeat(4000), thinkingSignature: "" },
					{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
				],
				timestamp: 0,
			},
			{ role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "r".repeat(40) }], isError: false },
		],
	};
	const toolChars = JSON.stringify(context.tools[0]).length;
	const callChars = "bash".length + JSON.stringify({ command: "ls" }).length;
	assert.equal(estimateContextTokens(context), Math.ceil((toolChars + callChars + 120) / 4));
});

test("images use pi's per-image char equivalent", () => {
	const context = {
		messages: [{ role: "user", content: [{ type: "image", data: "…", mimeType: "image/png" }], timestamp: 0 }],
	};
	assert.equal(estimateContextTokens(context), 1200);
});
