import { test } from "vitest";
import assert from "node:assert/strict";
import { Value } from "typebox/value";

import { sendMessageParams } from "../src/messaging.ts";

/** send_message 契约:to 可选(缺省 parent),text 必填非空(框架 execute 前校验)。 */
test("text 必填非空(minLength:1);to 可选", () => {
	assert.equal(Value.Check(sendMessageParams, { text: "" }), false);
	assert.equal(Value.Check(sendMessageParams, {}), false);
	assert.equal(Value.Check(sendMessageParams, { text: "进展同步" }), true); // to 缺省 → parent
	assert.equal(Value.Check(sendMessageParams, { to: "seal", text: "证据已齐" }), true);
});
