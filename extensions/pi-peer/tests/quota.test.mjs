import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { WindowQuota } from "../src/quota.ts";

/** pi_peer 生产配置:10/5min,同文窗 60s。 */
const peerQuota = () => new WindowQuota({ max: 10, windowMs: 300_000, repeatWindowMs: 60_000 });
const T = 1_800_000_000_000;

describe("WindowQuota(pi_peer 发送配额判定内核)", () => {
	test("check 只判定不记账:失败(不 commit)不消耗额度,同文重试放行(发送失败≠loop)", () => {
		const q = peerQuota();
		// 尝试失败(未 commit):同文立即重试不被 repeat 拦截
		assert.equal(q.check("a→b", "重试这封", T).ok, true);
		assert.equal(q.check("a→b", "重试这封", T + 5_000).ok, true, "失败后同文重试放行");
		// 连续失败(20 次全不 commit):额度不消耗、同文基线不刷新
		for (let i = 0; i < 20; i++) assert.equal(q.check("a→b", `m${i}`, T + 10_000 + i).ok, true);
		// 成功才记账:10 次成功后第 11 次 quota 拒
		for (let i = 0; i < 10; i++) {
			assert.equal(q.check("a→b", `s${i}`, T + 100_000 + i).ok, true);
			q.commit("a→b", `s${i}`, T + 100_000 + i);
		}
		assert.deepEqual(q.check("a→b", "s9", T + 100_500), { ok: false, kind: "repeat" }, "成功过的同文短窗内重发 → repeat");
		assert.deepEqual(q.check("a→b", "第 11 封", T + 110_000), { ok: false, kind: "quota" });
	});

	test("窗口内放行到上限,超限 kind=quota 且不计数;窗滑过后恢复", () => {
		const q = new WindowQuota({ max: 6, windowMs: 120_000, repeatWindowMs: 60_000 });
		for (let i = 0; i < 6; i++) {
			assert.equal(q.check("k", `m${i}`, T + i).ok, true);
			q.commit("k", `m${i}`, T + i);
		}
		assert.deepEqual(q.check("k", "m7", T + 10), { ok: false, kind: "quota" });
		// 窗滑过:最早的记账淡出后恢复放行
		assert.equal(q.check("k", "m8", T + 120_001).ok, true);
	});

	test("repeat 按 key 隔离:不同收方同文互不影响;同 key 超窗后同文放行", () => {
		const q = peerQuota();
		q.commit("a→b", "同文", T);
		assert.deepEqual(q.check("a→b", "同文", T + 30_000), { ok: false, kind: "repeat" });
		assert.equal(q.check("a→c", "同文", T + 30_000).ok, true, "不同 key 不共享同文基线");
		assert.equal(q.check("a→b", "同文", T + 60_001).ok, true, "超 repeat 窗放行");
	});
});
