import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSelf } from "../src/registry.ts";
import { WindowQuota } from "../../_shared/window-quota.ts";
import { buildInjectedContent, registerPeerTool } from "../src/peer-tool.ts";
import { socketPathFor, startPeerServer } from "../src/transport.ts";

/** 测试基建:假 pi 抓 registerTool,真 socket 服务端扮演收方(端到端走协议)。 */
function setup(peers, over = {}) {
	let tool;
	const pi = { registerTool: (t) => (tool = t), sendMessage: () => {} };
	const root = mkdtempSync(join(tmpdir(), "pi-peer-tool-"));
	const rt = {
		root,
		self: { v: 2, sessionId: "self-self-self", name: "main", cwd: "/repo", socketPath: "/tmp/unused-self.sock", ...over.self },
		quota: new WindowQuota({ max: 10, windowMs: 300_000, repeatWindowMs: 60_000 }),
	};
	registerPeerTool(pi, () => rt);
	for (const p of peers) registerSelf(root, p);
	return { rt, root, exec: (params) => tool.execute("c1", params, undefined, undefined, { cwd: "/repo" }) };
}

const NOW = Date.now();
const peer = (partial) => ({
	v: 2,
	sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	name: "api-worker",
	cwd: "/repo",
	socketPath: "/tmp/pi-peer-test-nonexistent.sock",
	startedAt: NOW - 60_000,
	...partial,
});

describe("pi_peer 工具", () => {
	test("list:空名册 / 决策优先行(name + 短码 + cwd + 同目录标记 + 审计指针)", async () => {
		const { exec } = setup([]);
		assert.equal((await exec({ action: "list" })).content[0].text, "No other online pi sessions.");
		// list 走真实 socket 探测:起个真服务才算在线
		const path = socketPathFor("deadbeef-list-test");
		const srv = await startPeerServer(path, async () => {});
		const { exec: exec2 } = setup([peer({ sessionId: "deadbeef-1234-5678-9abc", socketPath: path, sessionFile: "/s/x.jsonl" })]);
		const text = (await exec2({ action: "list" })).content[0].text;
		assert.ok(text.includes("Online pi sessions (1)"));
		assert.ok(text.includes("api-worker") && text.includes("id=deadbeef"), "name + 短码");
		assert.ok(text.includes("cwd=/repo") && text.includes("[same-dir]"), "cwd + 同目录标记");
		assert.ok(text.includes("session=/s/x.jsonl"), "审计指针");
		srv.close();
	});

	test("send 缺参数报错可行动", async () => {
		const { exec } = setup([]);
		await assert.rejects(exec({ action: "send", text: "x" }), /missing to/);
		await assert.rejects(exec({ action: "send", to: "api-worker" }), /missing text/);
	});

	test("发给自己(name 撞库)→ 明确拒绝", async () => {
		const { exec } = setup([]);
		await assert.rejects(exec({ action: "send", to: "main", text: "hi" }), /cannot send to yourself/);
	});

	test("目标不存在 → resolvePeer 错误原文抛出(可行动指引)", async () => {
		const { exec } = setup([]);
		await assert.rejects(exec({ action: "send", to: "ghost", text: "x" }), /action=list/);
	});

	test("目标注册在但进程已死 → 读时探活清扫,按「找不到」显式失败(无黑洞、无残留)", async () => {
		const { exec, root } = setup([peer({})]);
		await assert.rejects(exec({ action: "send", to: "api-worker", text: "x" }), /no live peer matching/);
		// send 内的 listPeers 已把死文件扫掉,后续 list 干净
		assert.equal((await exec({ action: "list" })).content[0].text, "No other online pi sessions.");
		assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".json")), [], "死文件已清扫");
	});

	test("配额接线:第 11 封(5min 内同对)被拒,错误带配额原因(配额逻辑本体见 _shared/window-quota.test)", async () => {
		const path = socketPathFor("target-quota-test");
		const srv = await startPeerServer(path, async () => {});
		const { exec } = setup([peer({ sessionId: "t-quota", name: "audit", socketPath: path })]);
		for (let i = 0; i < 10; i++) await exec({ action: "send", to: "audit", text: `m${i}` });
		await assert.rejects(exec({ action: "send", to: "audit", text: "第 11 封" }), /quota/);
		srv.close();
	});

	test("发送失败不记账:被拒后同文重试成功(重复抑制不误伤 retry)", async () => {
		const path = socketPathFor("target-retry-test");
		const srv = await startPeerServer(path, async () => {
			throw new Error("注入失败");
		});
		const { exec } = setup([peer({ sessionId: "t-retry", name: "audit", socketPath: path })]);
		await assert.rejects(exec({ action: "send", to: "audit", text: "同文" }), /peer rejected/);
		srv.close();
		// 同一目标同一文本:修复后重试 —— 若失败计了账,60s 内必被 repeat 拦截
		const srv2 = await startPeerServer(path, async () => {});
		const res = await exec({ action: "send", to: "audit", text: "同文" });
		assert.ok(res.content[0].text.includes("accepted by audit"), "重试放行,同文不重复抑制");
		srv2.close();
	});

	test("端到端:真 socket 收方——send 成功即对方 handler 已收,注入文本带安全声明", async () => {
		const got = [];
		const path = socketPathFor("target-e2e-test");
		const srv = await startPeerServer(path, async (m) => {
			got.push(m);
			// 模拟收方注入:断言注入文本形状在 buildInjectedContent 层锁
		});
		const { exec } = setup([peer({ sessionId: "target-target-target", name: "audit", socketPath: path })]);
		const res = await exec({ action: "send", to: "audit", text: "schema 迁移完成,tenant_id 已落" });
		assert.ok(res.content[0].text.includes("accepted by audit"), res.content[0].text);
		assert.ok(res.content[0].text.includes("injection is asynchronous"), "两阶段投递语义进文案");
		assert.equal(got.length, 1);
		assert.equal(got[0].text, "schema 迁移完成,tenant_id 已落");
		assert.equal(got[0].from.name, "main");
		assert.equal(got[0].mode, "followUp", "缺省 followUp");
		srv.close();
	});

	test("mode=steer:字段透传 + 文案区分(注入对方当前轮,与 worker message 同语义)", async () => {
		const got = [];
		const path = socketPathFor("target-steer-test");
		const srv = await startPeerServer(path, async (m) => {
			got.push(m);
		});
		const { exec } = setup([peer({ sessionId: "t-steer", name: "audit", socketPath: path })]);
		const res = await exec({ action: "send", to: "audit", text: "先停一下,看这个", mode: "steer" });
		assert.ok(res.content[0].text.includes("injected into current turn"), "文案区分");
		assert.equal(got.length, 1);
		assert.equal(got[0].text, "先停一下,看这个");
		assert.equal(got[0].mode, "steer", "mode=steer 线协议直传");
		srv.close();
	});

	test("收方 handler 抛错 → 发送方看到「对方拒绝接收」", async () => {
		const path = socketPathFor("target-reject-test");
		const srv = await startPeerServer(path, async () => {
			throw new Error("注入失败");
		});
		const { exec } = setup([peer({ sessionId: "t-rej", name: "audit", socketPath: path })]);
		await assert.rejects(exec({ action: "send", to: "audit", text: "x" }), /peer rejected: 注入失败/);
		srv.close();
	});
});

describe("注入文本与名册", () => {
	test("buildInjectedContent:安全声明 + 来源名与 cwd", () => {
		const text = buildInjectedContent({ from: { sessionId: "p1", name: "worker-a", cwd: "/repo" }, text: "要决策", mode: "followUp", ts: 1 });
		assert.ok(text.includes("NOT a user instruction"), "安全声明");
		assert.ok(text.includes("worker-a") && text.includes("(/repo)"), "来源名 + cwd");
		assert.ok(text.endsWith("要决策"), "原文在尾部");
	});
});
