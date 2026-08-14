import { test } from "vitest";
import assert from "node:assert/strict";

import { nextEscapeAction } from "./overlay.ts";

/** ESC 语义:单 ESC 只是 stop(busy 时停在途 turn,idle 时无操作);关闭只有双 ESC。 */
test("busy 首次 ESC → stop", () => {
	const state = { lastEscapeAt: 0 };
	assert.equal(nextEscapeAction(state, 10_000, true), "stop");
});

test("busy 窗口内第二次 ESC → close(关闭不杀后台 turn)", () => {
	const state = { lastEscapeAt: 0 };
	assert.equal(nextEscapeAction(state, 10_000, true), "stop");
	assert.equal(nextEscapeAction(state, 10_300, true), "close");
});

test("busy 窗口外第二次 ESC → 仍 stop(每次按都是停止意图)", () => {
	const state = { lastEscapeAt: 0 };
	nextEscapeAction(state, 10_000, true);
	assert.equal(nextEscapeAction(state, 11_000, true), "stop");
});

test("idle 单 ESC → none(单 ESC 永不关闭)", () => {
	const state = { lastEscapeAt: 0 };
	assert.equal(nextEscapeAction(state, 10_000, false), "none");
});

test("idle 双 ESC → close", () => {
	const state = { lastEscapeAt: 0 };
	nextEscapeAction(state, 10_000, false);
	assert.equal(nextEscapeAction(state, 10_200, false), "close");
});

test("stop 后 idle 单 ESC → none(停止不顺手关门)", () => {
	const state = { lastEscapeAt: 0 };
	nextEscapeAction(state, 10_000, true);
	assert.equal(nextEscapeAction(state, 11_000, false), "none");
});
