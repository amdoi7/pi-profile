import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { WindowQuota } from "./window-quota.ts";

/** pi-peer 配置:10/5min;RoomBus 配置:6/2min;同文窗两端均 60s。 */
const peerQuota = () => new WindowQuota({ max: 10, windowMs: 300_000, repeatWindowMs: 60_000 });
const roomQuota = () => new WindowQuota({ max: 6, windowMs: 120_000, repeatWindowMs: 60_000 });
const T = 1_800_000_000_000;

describe("WindowQuota(配额同构内核:pi-peer 发送配额 / RoomBus 唤醒配额共用)", () => {
	test("窗口内放行到上限,超限 kind=quota 且不计数;窗滑过后恢复", () => {
		const q = roomQuota();
		for (let i = 0; i < 6; i++) assert.equal(q.check("a", `m${i}`, T + i * 1000).ok, true);
		const over = q.check("a", "m6", T + 6000);
		assert.deepEqual(over, { ok: false, kind: "quota" });
		// 拒绝不计数:紧接着再试仍拒(若计数会永远锁死);窗滑后恢复
		assert.equal(q.check("a", "m7", T + 7000).ok, false);
		assert.equal(q.check("a", "m8", T + 121_000).ok, true, "窗滑动恢复");
	});

	test("同文短窗内重发 kind=repeat 且不计数;异文/超窗放行", () => {
		const q = peerQuota();
		assert.equal(q.check("a→b", "阻塞了", T).ok, true);
		assert.deepEqual(q.check("a→b", "阻塞了", T + 30_000), { ok: false, kind: "repeat" });
		assert.equal(q.check("a→b", "换个说法", T + 31_000).ok, true, "异文放行");
		assert.equal(q.check("a→b", "阻塞了", T + 61_000).ok, true, "超窗后同文放行");
	});

	test("key 隔离:不同收发对/不同 sender 互不占额", () => {
		const q = roomQuota();
		for (let i = 0; i < 6; i++) q.check("w1", `m${i}`, T + i * 1000);
		assert.equal(q.check("w1", "x", T + 6000).ok, false);
		assert.equal(q.check("w2", "x", T + 6000).ok, true, "w2 不受 w1 影响");
	});

	test("repeat 拒绝不刷新同文基线:基线仍是上次成功发送(防绕窗)", () => {
		const q = peerQuota();
		q.check("a→b", "X", T);
		assert.equal(q.check("a→b", "X", T + 59_000).ok, false, "窗内拒");
		// 59s 时的拒绝若刷新基线,则 T+119s 仍拒;正确语义:基线=T,T+61s 即放行
		assert.equal(q.check("a→b", "X", T + 61_000).ok, true, "基线不被拒绝刷新");
	});
});
