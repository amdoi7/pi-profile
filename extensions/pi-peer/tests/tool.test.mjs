import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WindowQuota } from "../src/quota.ts";
import { humanizeIdle, registerPeerTools } from "../src/tool.ts";
import { socketDir, socketPathFor, startPeerServer } from "../src/transport.ts";
import { writeHeartbeat } from "../src/process.ts";

/** 测试基建:假 pi 抓 registerTool;peers 以真 socket server 扮演(端到端走协议),
 * 每次 setup 独立 socket 目录(socket 目录即名册,按 cwd 分区)。 */
const CWD = "/repo";

async function setup(peers = [], over = {}) {
	process.env.PI_PEER_DIR = mkdtempSync(join(tmpdir(), "pi-peer-tool-"));
	mkdirSync(socketDir(CWD), { recursive: true });
	const tools = {};
	const pi = { registerTool: (t) => (tools[t.name] = t) };
	const rt = {
		self: { sessionId: "selfself-0000", startedAt: 1, ...over.self },
		quota: new WindowQuota({ max: 10, windowMs: 300_000, repeatWindowMs: 60_000 }),
	};
	registerPeerTools(pi, () => rt);
	const servers = [];
	for (const p of peers) {
		const sockPath = socketPathFor(p.identity.sessionId, CWD);
		writeHeartbeat(sockPath.replace(/\.sock$/, ".heartbeat"), process.pid);
		servers.push(await startPeerServer(sockPath, { who: () => p.identity, deliver: p.deliver ?? (async () => {}) }));
	}
	const run = (name) => (params = {}) => tools[name].execute("c1", params, undefined, undefined, { cwd: CWD });
	return {
		rt,
		tools,
		dir: socketDir(CWD),
		list: run("peer_list"),
		send: run("peer_send"),
		close: () => servers.forEach((s) => s.close()),
	};
}

const NOW = Date.now();
const identity = (over = {}) => ({ sessionId: "aaaaaaaa-bbbb-cccc", startedAt: NOW - 60_000, ...over });

describe("peer 工具", () => {
	// 两个形状塞进一个 action 参数 = to/text 只能是可选的,schema 无法拦「send 缺 to」
	// (语料:269 次 send 里 6 次缺 to、1 次把 quiet 当顶层键)。拆开后必填即必填。
	test("拆成两个工具:list 零参数,send 的 to/text 是 schema 必填", async () => {
		const { tools } = await setup([]);
		assert.deepEqual(Object.keys(tools).sort(), ["peer_list", "peer_send"]);
		assert.deepEqual(tools.peer_list.parameters.properties ?? {}, {});
		assert.deepEqual(tools.peer_send.parameters.required.sort(), ["text", "to"]);
		assert.equal(tools.peer_send.parameters.properties.to.type, "array", "to 是目标列表");
	});

	test("list:自身 id + 一行一个 peer(短码 + 审计指针)", async () => {
		const empty = await setup([]);
		const none = (await empty.list()).content[0].text;
		assert.match(none, /^you: id=selfself$/m, "自身 id 可读(自报家门与自投判断都要它)");
		assert.ok(none.includes("No other online pi sessions."));
		const { list, close } = await setup([{ identity: identity({ sessionId: "deadbeef-1234", sessionFile: "/s/x.jsonl" }) }]);
		const text = (await list()).content[0].text;
		assert.ok(text.includes("Online pi sessions (1)"));
		assert.ok(text.includes("id=deadbeef"), "短码即地址");
		assert.ok(text.includes("session=/s/x.jsonl"), "审计指针");
		close();
	});

	test("list 闲置标注:有 sessionFile 标 idle(弃用会话可辨),无 sessionFile 不标", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-peer-idle-"));
		const oldJsonl = join(dir, "old.jsonl");
		writeFileSync(oldJsonl, "{}\n");
		const t = (Date.now() - 3 * 86_400_000) / 1000; // 3 天前最后活动
		utimesSync(oldJsonl, t, t);
		const { list, close } = await setup([
			{ identity: identity({ sessionId: "staleone-0001", sessionFile: oldJsonl }) },
			{ identity: identity({ sessionId: "nofile00-0002" }) },
		]);
		const text = (await list()).content[0].text;
		const lineA = text.split("\n").find((l) => l.includes("staleone"));
		const lineB = text.split("\n").find((l) => l.includes("nofile00"));
		assert.ok(lineA.includes("idle=3d"), lineA);
		assert.ok(!lineB.includes("idle="), lineB);
		close();
	});

	// 视图函数本体在 messages.test；这里只验接线：画出来的东西确实包含目标、正文与失败行。
	test("peer_send 自己渲染调用与结果", async () => {
		const { tools } = await setup([]);
		// 假 theme 把色键写进文本:否则「失败行画成成功色」这类回归无从被拓到
		const theme = { fg: (k, t) => `<${k}>${t}`, bold: (t) => t };
		const call = tools.peer_send
			.renderCall({ to: ["01a04647-4a56"], text: "L1\nL2\nL3\nL4" }, theme, { expanded: false })
			.render(80)
			.map((l) => l.trimEnd());
		assert.deepEqual(call, [
			"<toolTitle>peer_send <accent>01a04647",
			"<dim>L1",
			"<dim>L2",
			"<dim>L3",
			"<muted>… +1 lines",
		]);
		const result = tools.peer_send
			.renderResult({ content: [{ type: "text", text: "accepted by 01a04647\nnot delivered:\n- ghost: no live peer" }] }, {}, theme)
			.render(80)
			.map((l) => l.trimEnd());
		assert.deepEqual(result, [
			"<success>accepted by 01a04647",
			"<error>not delivered:",
			"<error>- ghost: no live peer",
		], "部分失败不能长得像全成功");
	});

	// 可连但不应答的占位:不列 peer,但显式上报为 suspended(挂起,带 pid)
	test("list:suspended socket 单独上报(带 pid),不混入 peer 行", async () => {
		const { list, dir, close } = await setup([{ identity: identity({ sessionId: "liveaaaa-0001" }) }]);
		const silent = createServer(() => {});
		const mutePath = join(dir, "mute-1234-abcdef1234.sock");
		await new Promise((r) => silent.listen(mutePath, r));
		writeFileSync(join(dir, "mute-1234-abcdef1234.heartbeat"), `${process.pid} ${Date.now() - 200_000}\n`); // 过期心跳 = 挂起
		const text = (await list()).content[0].text;
		assert.ok(text.includes("Online pi sessions (1)"), "计数只算应答的活会话");
		assert.ok(text.includes("id=liveaaaa"));
		assert.ok(text.includes("Suspended sockets"), "挂起占位显式上报");
		assert.ok(text.includes(String(process.pid)), "挂起占位带 pid");
		silent.close();
		close();
	});

	test("humanizeIdle 边界:now/m/h/d", () => {
		assert.equal(humanizeIdle(30_000), "now");
		assert.equal(humanizeIdle(5 * 60_000), "5m");
		assert.equal(humanizeIdle(3 * 3_600_000), "3h");
		assert.equal(humanizeIdle(50 * 3_600_000), "2d");
	});

	// 未知键不静默吞掉:语料里 { quiet: true } 曾被当成默认模式投出,
	// 模型要的「留痕不唤醒」被静默丢弃。报错要说本工具接受什么。
	test("未知参数报本工具接受什么", async () => {
		const { list, send, close } = await setup([{ identity: identity({ sessionId: "unknown0-0001" }) }]);
		await assert.rejects(send({ to: ["unknown0"], text: "x", quiet: true }), /unknown parameter quiet; peer_send accepts to, text/);
		await assert.rejects(list({ action: "list" }), /unknown parameter action; peer_list takes no parameters/);
		close();
	});

	test("send 缺参数报错可行动", async () => {
		const { send } = await setup([]);
		await assert.rejects(send({ text: "x" }), /missing to/);
		await assert.rejects(send({ to: [], text: "x" }), /missing to/);
		await assert.rejects(send({ to: ["aaaaaaaa"] }), /missing text/);
	});

	// 一次广播 = N 次独立投递（消息没有 un-send，不是事务）：逐目标成功、逐目标失败。
	test("to 接受列表:每个目标各收一份,结果列出送达的人", async () => {
		const a = [], b = [];
		const { send, close } = await setup([
			{ identity: identity({ sessionId: "bcastaaa-0001" }), deliver: async (m) => void a.push(m) },
			{ identity: identity({ sessionId: "bcastbbb-0002" }), deliver: async (m) => void b.push(m) },
		]);
		const res = await send({ to: ["bcastaaa", "bcastbbb"], text: "接口改了" });
		assert.equal(a[0].text, "接口改了");
		assert.equal(b[0].text, "接口改了");
		assert.equal(res.content[0].text, "accepted by bcastaaa, bcastbbb");
		assert.deepEqual(res.details.to, ["bcastaaa-0001", "bcastbbb-0002"]);
		close();
	});

	// 一个目标下线不能拖累其他人：送到的照送，没送到的逐个报。
	test("部分失败:送达的照送,失败的逐个报原因", async () => {
		const got = [];
		const { send, close } = await setup([
			{ identity: identity({ sessionId: "liveaaaa-0001" }), deliver: async (m) => void got.push(m) },
		]);
		const res = await send({ to: ["liveaaaa", "ghost"], text: "x" });
		assert.equal(got.length, 1, "在线的那个照收");
		assert.match(res.content[0].text, /accepted by liveaaaa/);
		assert.match(res.content[0].text, /not delivered:[\s\S]*ghost[\s\S]*no live peer/);
		close();
	});

	test("全部失败 → 抛错(零送达不是成功),并带当前名册", async () => {
		const { send, close } = await setup([{ identity: identity({ sessionId: "liveaaaa-0001" }) }]);
		await assert.rejects(send({ to: ["ghost", "phantom"], text: "x" }), (e) => {
			assert.match(e.message, /ghost/);
			assert.match(e.message, /phantom/);
			assert.match(e.message, /id=liveaaaa/, "名册随错误交回");
			return true;
		});
		close();
	});

	test("名册为空时说明白没有别人在线", async () => {
		const { send } = await setup([]);
		await assert.rejects(send({ to: ["ghost"], text: "x" }), /No other online pi sessions\./);
	});

	// 同一个 peer 写两遍(全 id + 前缀)不该收到两份。
	test("列表里指向同一会话的多个写法只投一次", async () => {
		const got = [];
		const { send, close } = await setup([
			{ identity: identity({ sessionId: "dedupeaa-0001" }), deliver: async (m) => void got.push(m) },
		]);
		const res = await send({ to: ["dedupeaa", "dedupeaa-0001"], text: "只收一次" });
		assert.equal(got.length, 1);
		assert.equal(res.content[0].text, "accepted by dedupeaa");
		close();
	});

	// 模型的先验是标量 to；单个目标写成裸字符串语义无歧义，直接当一元列表。
	test("单个目标写成裸字符串照收", async () => {
		const got = [];
		const { send, close } = await setup([
			{ identity: identity({ sessionId: "scalaraa-0001" }), deliver: async (m) => void got.push(m) },
		]);
		await send({ to: "scalaraa", text: "x" });
		assert.equal(got.length, 1);
		close();
	});

	test("发给自己(id 前缀撞库)→ 明确拒绝", async () => {
		const { send } = await setup([]);
		await assert.rejects(send({ to: ["selfself"], text: "hi" }), /cannot send to yourself/);
	});

	test("尸体 socket 文件:send 显式失败,list 顺带回收(名册自清洗)", async () => {
		const { send, dir } = await setup([]);
		writeFileSync(join(dir, "corpse-1234-abcdef.sock"), ""); // 无进程持有
		await assert.rejects(send({ to: ["corpse"], text: "x" }), /no live peer matching/);
		assert.deepEqual(readdirSync(dir), [], "尸体文件已回收");
	});

	test("配额接线:第 11 封(5min 内同对)被拒,错误带配额原因(配额逻辑本体见 quota.test)", async () => {
		const { send, close } = await setup([{ identity: identity({ sessionId: "quotaaaa-0001" }) }]);
		for (let i = 0; i < 10; i++) await send({ to: ["quotaaaa"], text: `m${i}` });
		await assert.rejects(send({ to: ["quotaaaa"], text: "第 11 封" }), /quota/);
		close();
	});

	test("发送失败不记账:被拒后同文重试成功(重复抑制不误伤 retry)", async () => {
		let failing = true;
		const { send, close } = await setup([
			{
				identity: identity({ sessionId: "retryaaa-0001" }),
				deliver: async () => {
					if (failing) throw new Error("注入失败");
				},
			},
		]);
		await assert.rejects(send({ to: ["retryaaa"], text: "同文" }), /peer rejected/);
		// 同一目标同一文本:修复后重试 —— 若失败计了账,60s 内必被 repeat 拦截
		failing = false;
		const res = await send({ to: ["retryaaa"], text: "同文" });
		assert.ok(res.content[0].text.includes("accepted by retryaaa"), "重试放行,同文不重复抑制");
		close();
	});

	test("端到端:真 socket 收方——send 成功即对方 deliver 已收", async () => {
		const got = [];
		const { send, close } = await setup([
			{ identity: identity({ sessionId: "e2eaaaaa-0001" }), deliver: async (m) => void got.push(m) },
		]);
		const res = await send({ to: ["e2eaaaaa"], text: "schema 迁移完成,tenant_id 已落" });
		// 结果只说新事实（谁接收了）；异步语义在工具描述里，不在每次成功里重复。
		assert.equal(res.content[0].text, "accepted by e2eaaaaa");
		assert.equal(got[0].text, "schema 迁移完成,tenant_id 已落");
		assert.equal(got[0].from, "selfself-0000", "同目录内 from 就是 sessionId");
		close();
	});

	// 回归(2026-09-10):离线/被拒是可重试的瞬时失败——收方瞬拒 2 次后第 3 次送达。
	// 现状(一次失败即落账)该测试应先红后绿。
	test("退避重试:目标瞬时被拒 2 次后送达(3 次尝试内成功,只投成一份)", async () => {
		const got = [];
		let transientFailures = 0;
		const { send, close } = await setup([
			{
				identity: identity({ sessionId: "retryaa-0001" }),
				deliver: async (m) => {
					if (transientFailures < 2) {
						transientFailures += 1;
						throw new Error("session 正忙"); // 被拒 = ack{ok:false} → 可重试
					}
					got.push(m);
				},
			},
		]);
		const res = await send({ to: ["retryaa"], text: "x" });
		assert.equal(got.length, 1, "第 3 次尝试送达,只投成一份");
		assert.match(res.content[0].text, /accepted by retryaa/);
		close();
	});
});
