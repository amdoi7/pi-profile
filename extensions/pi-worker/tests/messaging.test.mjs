import { test } from "vitest";
import assert from "node:assert/strict";
import { Value } from "typebox/value";

import { sendMessageParams, SEND_MESSAGE_DESCRIPTION } from "../src/messaging.ts";

/** send_message 契约:to 可选(缺省 parent),text 必填非空(框架 execute 前校验)。 */
test("text 必填非空(minLength:1);to 可选", () => {
	assert.equal(Value.Check(sendMessageParams, { text: "" }), false);
	assert.equal(Value.Check(sendMessageParams, {}), false);
	assert.equal(Value.Check(sendMessageParams, { text: "进展同步" }), true); // to 缺省 → parent
	assert.equal(Value.Check(sendMessageParams, { to: "seal", text: "证据已齐" }), true);
});

test("to 描述载双形态寻址(name 或完整 id;name 可重名时用完整 id 精确定向)", () => {
	assert.ok(sendMessageParams.properties.to.description.includes("full id"), sendMessageParams.properties.to.description);
});

/** 工具描述 tripwire:反问条款(问父是常态)与回合语义(报告继续/提问结束本轮)被砍即红灯。 */
test("描述载反问条款与回合语义", () => {
	assert.ok(SEND_MESSAGE_DESCRIPTION.includes("do not deliberate alone"), "问父优先于独自死磕");
	assert.ok(SEND_MESSAGE_DESCRIPTION.includes("end your turn"), "阻塞提问后结束本轮等答复");
});
