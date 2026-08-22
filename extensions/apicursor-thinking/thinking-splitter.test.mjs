/**
 * ThinkingSplitter tests — anchored on the raw apicursor.com protocol captured
 * with curl against /v1/chat/completions (stream, claude-opus-5):
 *
 *   delta.content = "<think>…chain of thought…</think>\n\n<visible answer>"
 *
 * No dedicated reasoning field is ever sent, and the chain of thought is plain
 * prose that routinely contains the words "response" and "thinking".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ThinkingSplitter } from "./thinking-splitter.ts";

/** Feed deltas, return the concatenated thinking / visible text. */
function split(deltas) {
	const s = new ThinkingSplitter();
	const segments = [];
	for (const d of deltas) segments.push(...s.feed(d));
	segments.push(...s.end());
	const join = (kind) =>
		segments
			.filter((seg) => seg.kind === kind)
			.map((seg) => seg.text)
			.join("");
	return { thinking: join("thinking"), text: join("text"), segments };
}

test("captured protocol: <think> block becomes thinking, remainder is the answer", () => {
	const { thinking, text } = split([
		"<think>I need to provide Euclid's proof of the infinitude of primes.</think>",
		"\n\n## There are infinitely many primes\n\nSuppose the set is finite.",
	]);
	assert.equal(thinking, "I need to provide Euclid's proof of the infinitude of primes.");
	assert.equal(text, "## There are infinitely many primes\n\nSuppose the set is finite.");
});

test("chain of thought containing 'response' stays inside thinking", () => {
	const cot = "The user asked a math question, so I will structure my response as a proof, then answer.";
	const { thinking, text } = split([`<think>${cot}</think>\n\n80 mph.`]);
	assert.equal(thinking, cot);
	assert.equal(text, "80 mph.");
});

test("chain of thought containing 'thinking' stays inside thinking", () => {
	const cot = "I am thinking about whether 17*23 equals 391; thinkingIn steps helps.";
	const { thinking, text } = split([`<think>${cot}</think>\n\nIt is 391.`]);
	assert.equal(thinking, cot);
	assert.equal(text, "It is 391.");
});

test("tags split across deltas are still recognised", () => {
	const { thinking, text } = split(["<th", "ink>step one", " step two</thi", "nk>", "\n\nanswer"]);
	assert.equal(thinking, "step one step two");
	assert.equal(text, "answer");
});

test("answer without any tag is passed through verbatim", () => {
	const answer = "Here is my response. I was thinking about the response format, thinkingly so.";
	const { thinking, text } = split([answer]);
	assert.equal(thinking, "");
	assert.equal(text, answer);
});

test("unclosed <think> keeps the chain of thought out of the answer", () => {
	const { thinking, text } = split(["<think>truncated reasoning about the response"]);
	assert.equal(thinking, "truncated reasoning about the response");
	assert.equal(text, "");
});

test("multiple think blocks alternate with visible text", () => {
	const { thinking, text } = split(["<think>first</think>part one<think>second</think>\n\npart two"]);
	assert.equal(thinking, "firstsecond");
	assert.equal(text, "part onepart two");
});

test("attribute form and <thinking> spelling are recognised", () => {
	const a = split(['<think style="codex">reasoning</think>answer']);
	assert.equal(a.thinking, "reasoning");
	assert.equal(a.text, "answer");
	const b = split(["<thinking>reasoning</thinking>answer"]);
	assert.equal(b.thinking, "reasoning");
	assert.equal(b.text, "answer");
});
