import test from "node:test";
import assert from "node:assert/strict";

import { registerCommand, on } from "./mode-gate.ts";

/** 收集注册调用的 fake ExtensionAPI。 */
function fakePi() {
	const commands = [];
	const subscriptions = [];
	return {
		commands,
		subscriptions,
		pi: {
			registerCommand(name, options) {
				commands.push({ name, options });
			},
			on(event, handler) {
				subscriptions.push({ event, handler });
			},
		},
	};
}

function fakeCtx(mode, overrides = {}) {
	return { mode, hasUI: true, ui: { notify: () => {} }, ...overrides };
}

test("registerCommand runs the handler in declared modes", async () => {
	const { pi, commands } = fakePi();
	let ran = false;
	registerCommand(pi, "demo", {
		modes: ["tui"],
		handler: async () => {
			ran = true;
		},
	});

	assert.equal(commands.length, 1);
	await commands[0].options.handler("", fakeCtx("tui"));
	assert.equal(ran, true);
});

test("registerCommand drops the handler in other modes and notifies", async () => {
	const { pi, commands } = fakePi();
	let ran = false;
	const notices = [];
	registerCommand(pi, "demo", {
		modes: ["tui"],
		handler: async () => {
			ran = true;
		},
	});

	const ctx = fakeCtx("rpc", {
		ui: {
			notify(message, level) {
				notices.push({ message, level });
			},
		},
	});
	await commands[0].options.handler("", ctx);
	assert.equal(ran, false);
	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /demo/);
	assert.equal(notices[0].level, "warning");
});

test("registerCommand stays silent without UI (print/json modes)", async () => {
	const { pi, commands } = fakePi();
	let ran = false;
	registerCommand(pi, "demo", {
		modes: ["tui"],
		handler: async () => {
			ran = true;
		},
	});

	// print/json: hasUI=false, no ui object at all.
	await commands[0].options.handler("", { mode: "print", hasUI: false });
	assert.equal(ran, false);
});

test("registerCommand defaults to all modes when modes is omitted", async () => {
	const { pi, commands } = fakePi();
	let ran = 0;
	registerCommand(pi, "demo", {
		handler: async () => {
			ran += 1;
		},
	});

	await commands[0].options.handler("", fakeCtx("tui"));
	await commands[0].options.handler("", fakeCtx("rpc"));
	await commands[0].options.handler("", fakeCtx("print"));
	await commands[0].options.handler("", fakeCtx("json"));
	assert.equal(ran, 4);
});

test("registerCommand keeps extra options (description, completions)", () => {
	const { pi, commands } = fakePi();
	const completions = () => [];
	registerCommand(pi, "demo", {
		modes: ["tui"],
		description: "desc",
		getArgumentCompletions: completions,
		handler: async () => {},
	});

	assert.equal(commands[0].options.description, "desc");
	assert.equal(commands[0].options.getArgumentCompletions, completions);
});

test("on dispatches the handler only in declared modes", async () => {
	const { pi, subscriptions } = fakePi();
	let ran = [];
	on(
		pi,
		"tool_call",
		async (event) => {
			ran.push(event.toolName);
			return { block: true, reason: "blocked" };
		},
		["tui"],
	);

	assert.equal(subscriptions.length, 1);
	const handler = subscriptions[0].handler;

	// TUI: dispatched, return value passes through.
	const result = await handler({ toolName: "bash" }, fakeCtx("tui"));
	assert.deepEqual(ran, ["bash"]);
	assert.deepEqual(result, { block: true, reason: "blocked" });

	// RPC: dropped.
	await handler({ toolName: "bash" }, fakeCtx("rpc"));
	assert.deepEqual(ran, ["bash"]);
});

test("on defaults to all modes when modes is omitted", async () => {
	const { pi, subscriptions } = fakePi();
	let ran = 0;
	on(pi, "tool_call", async () => {
		ran += 1;
	});

	const handler = subscriptions[0].handler;
	await handler({}, fakeCtx("tui"));
	await handler({}, fakeCtx("rpc"));
	await handler({}, fakeCtx("print"));
	await handler({}, fakeCtx("json"));
	assert.equal(ran, 4);
});


