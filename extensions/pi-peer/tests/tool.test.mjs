import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WindowQuota } from "../src/quota.ts";
import { humanizeIdle, registerPeerTool } from "../src/tool.ts";
import { socketPathFor, startPeerServer } from "../src/transport.ts";

/** 测试基建:假 pi 抓 registerTool;peers 以真 socket server 扮演(端到端走协议),
 * 每次 setup 独立 socket 目录(socket 目录即名册)。 */
async function setup(peers = [], over = {}) {
	process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-tool-"));
	let tool;
	const pi = { registerTool: (t) => (tool = t) };
	const rt = {
		self: { sessionId: "self-self-self", name: "main", cwd: "/repo", startedAt: 1, ...over.self },
		quota: new WindowQuota({ max: 10, windowMs: 300_000, repeatWindowMs: 60_000 }),
	};
	registerPeerTool(pi, () => rt);
	const servers = [];
	for (const p of peers) {
		servers.push(await startPeerServer(socketPathFor(p.identity.sessionId), { who: () => p.identity, deliver: p.deliver ?? (async () => {}) }));
	}
	return {
		rt,
		exec: (params) => tool.execute("c1", params, undefined, undefined, { cwd: "/repo" }),
		close: () => servers.forEach((s) => s.close()),
	};
}

const NOW = Date.now();
const identity = (over = {}) => ({ sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "api-session", cwd: "/repo", startedAt: NOW - 60_000, ...over });

describe("pi_peer 工具", () => {
	test("list:空名册 / 决策优先行(name + 短码 + cwd + 同目录标记 + 审计指针)", async () => {
		const empty = await setup([]);
		assert.equal((await empty.exec({ action: "list" })).content[0].text, "No other online pi sessions.");
		const { exec, close } = await setup([{ identity: identity({ sessionId: "deadbeef-1234-5678-9abc", sessionFile: "/s/x.jsonl" }) }]);
		const text = (await exec({ action: "list" })).content[0].text;
		assert.ok(text.includes("Online pi sessions (1)"));
		assert.ok(text.includes("api-session") && text.includes("id=deadbeef"), "name + 短码");
		assert.ok(text.includes("cwd=/repo") && text.includes("[same-dir]"), "cwd + 同目录标记");
		assert.ok(text.includes("session=/s/x.jsonl"), "审计指针");
		close();
	});

	test("list 闲置标注:有 sessionFile 标 idle(弃用会话可辨),无 sessionFile 不标", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-peer-idle-"));
		const oldJsonl = join(dir, "old.jsonl");
		writeFileSync(oldJsonl, "{}\n");
		const t = (Date.now() - 3 * 86_400_000) / 1000; // 3 天前最后活动
		utimesSync(oldJsonl, t, t);
		const { exec, close } = await setup([
			{ identity: identity({ sessionId: "idle-aaaa", name: "stale-one", sessionFile: oldJsonl }) },
			{ identity: identity({ sessionId: "idle-bbbb", name: "no-file" }) },
		]);
		const text = (await exec({ action: "list" })).content[0].text;
		const lineA = text.split("\n").find((l) => l.includes("stale-one"));
		const lineB = text.split("\n").find((l) => l.includes("no-file"));
		assert.ok(lineA.includes("idle=3d"), lineA);
		assert.ok(!lineB.includes("idle="), lineB);
		close();
	});

	test("humanizeIdle 边界:now/m/h/d", () => {
		assert.equal(humanizeIdle(30_000), "now");
		assert.equal(humanizeIdle(5 * 60_000), "5m");
		assert.equal(humanizeIdle(3 * 3_600_000), "3h");
		assert.equal(humanizeIdle(50 * 3_600_000), "2d");
	});

	test("send 缺参数报错可行动", async () => {
		const { exec } = await setup([]);
		await assert.rejects(exec({ action: "send", text: "x" }), /missing to/);
		await assert.rejects(exec({ action: "send", to: "api-session" }), /missing text/);
	});

	test("发给自己(name 撞库)→ 明确拒绝", async () => {
		const { exec } = await setup([]);
		await assert.rejects(exec({ action: "send", to: "main", text: "hi" }), /cannot send to yourself/);
	});

	test("目标不存在 → resolvePeer 错误原文抛出(可行动指引)", async () => {
		const { exec } = await setup([]);
		await assert.rejects(exec({ action: "send", to: "ghost", text: "x" }), /action=list/);
	});

	test("尸体 socket 文件:send 显式失败,list 顺带回收(名册自清洗)", async () => {
		const { exec } = await setup([]);
		const dir = process.env.PI_PEER_DIR;
		writeFileSync(join(dir, "corpse-1234-abcdef1234.sock"), ""); // 无进程持有
		await assert.rejects(exec({ action: "send", to: "corpse", text: "x" }), /no live peer matching/);
		assert.deepEqual(readdirSync(dir), [], "尸体文件已回收");
	});

	test("配额接线:第 11 封(5min 内同对)被拒,错误带配额原因(配额逻辑本体见 quota.test)", async () => {
		const { exec, close } = await setup([{ identity: identity({ sessionId: "t-quota", name: "audit" }) }]);
		for (let i = 0; i < 10; i++) await exec({ action: "send", to: "audit", text: `m${i}` });
		await assert.rejects(exec({ action: "send", to: "audit", text: "第 11 封" }), /quota/);
		close();
	});

	test("发送失败不记账:被拒后同文重试成功(重复抑制不误伤 retry)", async () => {
		let failing = true;
		const { exec, close } = await setup([
			{
				identity: identity({ sessionId: "t-retry", name: "audit" }),
				deliver: async () => {
					if (failing) throw new Error("注入失败");
				},
			},
		]);
		await assert.rejects(exec({ action: "send", to: "audit", text: "同文" }), /peer rejected/);
		// 同一目标同一文本:修复后重试 —— 若失败计了账,60s 内必被 repeat 拦截
		failing = false;
		const res = await exec({ action: "send", to: "audit", text: "同文" });
		assert.ok(res.content[0].text.includes("accepted by audit"), "重试放行,同文不重复抑制");
		close();
	});

	test("端到端:真 socket 收方——send 成功即对方 deliver 已收,默认 followUp;steer 透传", async () => {
		const got = [];
		const { exec, close } = await setup([
			{ identity: identity({ sessionId: "target-e2e", name: "audit" }), deliver: async (m) => void got.push(m) },
		]);
		const res = await exec({ action: "send", to: "audit", text: "schema 迁移完成,tenant_id 已落" });
		// 结果只说新事实（谁接收了）；异步语义在工具描述里，不在每次成功里重复。
		assert.equal(res.content[0].text, "accepted by audit");
		assert.equal(got[0].text, "schema 迁移完成,tenant_id 已落");
		assert.equal(got[0].from.name, "main");
		assert.equal(got[0].mode, "followUp", "缺省 followUp");
		await exec({ action: "send", to: "audit", text: "先停一下,看这个", mode: "steer" });
		// mode 是模型自己传的，回读给它没价值；该测的是线协议真的带了 mode。
		assert.equal(got[1].mode, "steer", "mode=steer 线协议直传");
		close();
	});
});
