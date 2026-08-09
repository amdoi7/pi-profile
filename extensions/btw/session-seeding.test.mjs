import { test } from "vitest";
import assert from "node:assert/strict";

import { seedSideSessionMessages } from "./session-seeding.ts";

test("seedSideSessionMessages rebuilds side-session context without agent.replaceMessages", () => {
	const appended = [];
	const session = {
		agent: { state: { messages: [] } },
		sessionManager: {
			appendMessage(message) {
				appended.push(message);
				return String(appended.length);
			},
			buildSessionContext() {
				return { messages: appended.map((message) => ({ ...message, seeded: true })) };
			},
		},
	};

	const seedMessages = [
		{ role: "user", content: [{ type: "text", text: "First question" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "First answer" }],
			provider: "test",
			model: "mock",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
	];

	seedSideSessionMessages(session, seedMessages);

	assert.deepEqual(appended, seedMessages);
	assert.equal(session.agent.state.messages.length, 2);
	assert.equal(session.agent.state.messages[0]?.role, "user");
	assert.equal(session.agent.state.messages[1]?.role, "assistant");
	assert.equal(session.agent.state.messages[0]?.seeded, true);
});
