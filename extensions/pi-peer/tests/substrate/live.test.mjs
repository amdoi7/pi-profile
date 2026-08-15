import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendPeerMessage } from "../../src/transport.ts";

/**
 * live 冒烟:两个真实 pi RPC 进程经共享 peers 目录互见 + 真实收信。
 * 不烧 LLM:收信证据 = sendPeerMessage 拿到 ack(ack 在对方注入成功后才发出)。
 */

const root = mkdtempSync(join(tmpdir(), "pi-peer-live-"));
const procs = [];

function startPi() {
	const p = spawn("pi", ["--mode", "rpc"], {
		env: { ...process.env, PI_PEER_DIR: root },
		stdio: ["pipe", "pipe", "pipe"],
	});
	p.stdout.on("data", () => {}); // 排空防背压
	p.stderr.on("data", () => {});
	procs.push(p);
	return p;
}

async function waitFor(pred, what, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const v = pred();
			if (v) return v;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`waitFor 超时: ${what}`);
}

afterAll(() => {
	for (const p of procs) p.kill("SIGTERM");
});

test("双进程:互见(注册中心)+ socket 投递拿 ack(收方真实注入)+ 注销清扫", async () => {
	startPi();
	startPi();
	// 双方注册
	const files = await waitFor(() => {
		const f = readdirSync(root).filter((x) => x.endsWith(".json"));
		return f.length >= 2 ? f : undefined;
	}, "双方注册文件");
	const infos = files.map((f) => JSON.parse(readFileSync(join(root, f), "utf8")));
	for (const info of infos) {
		assert.equal(info.v, 2);
		assert.ok(info.socketPath && info.cwd, `注册信息完整: ${info.sessionId}`);
	}
	// 直接向 B 的 socket 投递(绕过 LLM 工具调用;ack = B 扩展注入成功)
	const b = infos[1];
	await sendPeerMessage(b.socketPath, {
		from: { sessionId: infos[0].sessionId, name: "a-win", cwd: infos[0].cwd },
		text: "跨进程冒烟",
		mode: "quiet", // 不唤醒 B 的 LLM(不烧 token)
		ts: Date.now(),
	});
	// ack 到达 = B 已注入;再验证 B 的 socket 仍活(可再收)
	await sendPeerMessage(b.socketPath, { from: { sessionId: infos[0].sessionId }, text: "第二封", mode: "quiet", ts: Date.now() });
	// 注销:杀全部 → 注册文件全清、socket 死亡(文件序≠进程序,不做一一对应)
	for (const p of procs) p.kill("SIGTERM");
	await waitFor(() => (readdirSync(root).filter((x) => x.endsWith(".json")).length === 0 ? true : undefined), "双方注销");
	await assert.rejects(
		sendPeerMessage(b.socketPath, { from: { sessionId: "x" }, text: "y", mode: "quiet", ts: 1 }),
		/peer offline/,
		"死后投递显式失败(fail-fast 无黑洞)",
	);
}, 30_000);
