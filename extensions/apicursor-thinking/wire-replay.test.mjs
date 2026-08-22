/**
 * Wire-level contract: what this provider actually sends on the second turn.
 *
 * Drives the stock OpenAI-completions adapter (the one index.ts delegates to)
 * with a fake fetch, so the assertion is on the real serialised request body —
 * no network, no cost. Guards two properties this gateway depends on:
 *   1. replayed assistant history carries no chain of thought;
 *   2. the instruction message keeps `role: "system"`, which is the only role the
 *      Cursor flattener wraps in `<system>…</system>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePiPackageDir } from "../test-helpers/runtime-paths.mjs";
import { dropThinkingFromHistory } from "./replay.ts";

function resolveOpenAICompletions() {
	const candidates = [
		path.join(resolvePiPackageDir("@earendil-works/pi-coding-agent"), "node_modules", "@earendil-works", "pi-ai"),
		path.join(path.resolve(import.meta.dirname, "..", ".."), "node_modules", "@earendil-works", "pi-ai"),
	];
	for (const dir of candidates) {
		const entry = path.join(dir, "dist", "api", "openai-completions.js");
		if (fs.existsSync(entry)) return pathToFileURL(entry).href;
	}
	throw new Error("Unable to resolve @earendil-works/pi-ai openai-completions entry");
}

const { streamSimple } = await import(resolveOpenAICompletions());

const COT = "SECRET_CHAIN_OF_THOUGHT_MARKER";

const MODEL = {
	id: "claude-opus-5",
	name: "Claude Opus 5 (Global)",
	provider: "apicursor",
	api: "openai-completions",
	baseUrl: "https://apicursor.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	compat: { supportsDeveloperRole: false },
};

function secondTurnContext() {
	return {
		systemPrompt: "sys",
		tools: [],
		messages: [
			{ role: "user", content: "q1", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: COT, thinkingSignature: "" },
					{ type: "text", text: "ANSWER_ONE" },
				],
				api: "openai-completions",
				provider: "apicursor",
				model: "claude-opus-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: "q2", timestamp: 0 },
		],
	};
}

/** Minimal apicursor-shaped SSE reply: one content delta, then finish + usage. */
function sseResponse() {
	const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
	const body = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(
				encoder.encode(
					chunk({
						id: "1",
						object: "chat.completion.chunk",
						created: 1,
						model: "claude-opus-5",
						choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
					}),
				),
			);
			controller.enqueue(
				encoder.encode(
					chunk({
						id: "1",
						object: "chat.completion.chunk",
						created: 1,
						model: "claude-opus-5",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 400450, completion_tokens: 1, total_tokens: 400451 },
					}),
				),
			);
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function capturePayload(context) {
	let captured;
	const stream = streamSimple(MODEL, context, {
		apiKey: "sk-test",
		fetch: async (_url, init) => {
			captured = JSON.parse(init.body);
			return sseResponse();
		},
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

test("second turn replays the answer without the chain of thought", async () => {
	const payload = await capturePayload(dropThinkingFromHistory(secondTurnContext()));
	const wire = JSON.stringify(payload.messages);
	assert.equal(wire.includes(COT), false, `chain of thought leaked onto the wire: ${wire}`);
	assert.equal(wire.includes("ANSWER_ONE"), true);
	assert.deepEqual(
		payload.messages.map((m) => m.role),
		["system", "user", "assistant", "user"],
	);
});

test("instruction message stays `system`, the only role the gateway wraps", async () => {
	const payload = await capturePayload(dropThinkingFromHistory(secondTurnContext()));
	assert.equal(payload.messages[0].role, "system");
	assert.equal(payload.messages[0].content, "sys");
});

/**
 * The adapter only drops thinking because ThinkingSplitter leaves the signature
 * empty; a signed block (what other providers produce, and what a future
 * ThinkingSplitter change could produce) is replayed verbatim. This pins the
 * strip as the guard rather than the signature convention.
 */
test("a signed thinking block would reach the wire, and the strip is what stops it", async () => {
	const signed = () => {
		const context = secondTurnContext();
		context.messages[1].content[0].thinkingSignature = "reasoning_content";
		return context;
	};
	const unguarded = await capturePayload(signed());
	assert.equal(JSON.stringify(unguarded.messages).includes(COT), true, "expected the adapter to replay a signed chain of thought");
	const guarded = await capturePayload(dropThinkingFromHistory(signed()));
	assert.equal(JSON.stringify(guarded.messages).includes(COT), false);
});
