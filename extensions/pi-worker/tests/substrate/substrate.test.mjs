import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerManager } from "../../src/manager.ts";
import { RpcClient } from "../../src/rpc-client.ts";

const MODEL = process.env.PI_WORKER_TEST_MODEL ?? "opencode-go/deepseek-v4-flash";
const LONG = 120000;
const cwd = mkdtempSync(join(tmpdir(), "pi-worker-live-"));

const delivered = [];
const manager = new WorkerManager({ deliver: (msg) => delivered.push(msg) });

function dump() {
	return delivered.map((m) => `${m.details.type}:${m.details.id}`).join(", ");
}

async function waitFor(pred, what, timeoutMs = LONG) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`waitFor 超时: ${what}`);
}

function findCallback(type, id) {
	return delivered.find((m) => m.details.type === type && m.details.id === id);
}

afterAll(() => {
	manager.killAll();
});

test(
	"run → settled 回调(呈报+stats) → 父显式 collect → done;session jsonl 落盘",
	async () => {
		const { id, pid } = manager.run({ name: "t1", prompt: "只回复两个字:完成" }, cwd);
		assert.match(id, /^pi-worker-t1#[0-9a-f]{12}$/);
		assert.ok(pid > 0);

		await waitFor(() => findCallback("settled", id), "settled 回调");
		const msg = findCallback("settled", id);
		assert.match(msg.content, /^settled id=pi-worker-t1#/);
		assert.ok(msg.content.includes("完成"), `呈报应含完成: ${msg.content}`);
		assert.ok(typeof msg.details.stats?.cost === "number", "stats.cost 应为数字");
		// 回调应携带原生 sessionFile 审计指针(事实核验第三层:子 session 审计一步可达)
		assert.match(msg.details.sessionFile ?? "", /\.jsonl$/, "details.sessionFile 应为会话 jsonl 路径");
		manager.collect(id);
		assert.equal(manager.status(id).state, "done", "父验收后显式 collect");

		// 握手 get_state 应记录实际生效模型/档位(含默认)
		const rec = manager.status(id);
		assert.ok(rec.modelInfo?.id, "modelInfo.id 应存在");
		assert.ok(rec.modelInfo.thinkingLevel, "modelInfo.thinkingLevel 应存在");
		assert.ok(rec.modelInfo.provider, "modelInfo.provider 应存在");

		const sessionDir = join(cwd, ".pi", "worker-sessions");
		const files = readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
		assert.ok(files.length > 0, "子 session jsonl 应落盘审计");
	},
	LONG,
);

test(
	"O4 授权链:run 带 parentSessionFile → 子 jsonl header 真实落 parentSession(恢复归属的数据链)",
	async () => {
		const parentFile = join(cwd, "parent-session.jsonl");
		const { id } = manager.run({ name: "t1chain", prompt: "只回复两个字:完成" }, cwd, { parentSessionFile: parentFile });
		await waitFor(() => findCallback("settled", id), "settled 回调");
		const msg = findCallback("settled", id);
		const sessionFile = msg.details.sessionFile;
		assert.ok(sessionFile?.endsWith(".jsonl"), "审计指针");
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
		assert.equal(header.type, "session");
		assert.equal(header.parentSession, parentFile, "new_session(parentSession) 原生写入 header;恢复时凭此认领");
		manager.collect(id);
	},
	LONG,
);

test(
	"O3 冷恢复:settled 后杀进程 → exited → message 续接,历史完整(暗号记忆)是新轮上下文",
	async () => {
		const { id } = manager.run({ name: "t5resume", prompt: "记住暗号:蓝鲸742。只回复:收到" }, cwd);
		await waitFor(() => findCallback("settled", id), "首轮 settled");
		// 模拟进程死亡:直接杀子进程 → watcher exit → idle 后进程崩 → exited
		manager.handles.get(id)?.proc.kill("SIGKILL");
		await waitFor(() => manager.status(id).state === "exited", "exited 态");
		// 冷恢复续接:--session 同文件,消息即新轮指令
		const via = await manager.message(id, "暗号是什么?只回复暗号本身");
		assert.equal(via, "prompt");
		await waitFor(() => manager.status(id).state === "idle", "续接后轮 settled");
		const rec = manager.status(id);
		assert.ok(rec.report?.includes("蓝鲸742"), `续接后应记得暗号(历史完整): ${rec.report}`);
		assert.equal(rec.recovered, undefined, "复活后不再是遗留记录");
		manager.collect(id);
	},
	LONG,
);

test(
	"message:settled 后父 message 触发新轮 → 新呈报 → collect(ask 通道已移除)",
	async () => {
		const { id } = manager.run({ name: "t2", prompt: "只回复两个字:完成" }, cwd);
		await waitFor(() => findCallback("settled", id), `首轮 settled(delivered: ${dump()})`);
		assert.equal(manager.status(id).state, "idle");

		const mode = await manager.message(id, "父指令:请回复:确认开工");
		assert.equal(mode, "prompt", "idle 子应走 prompt 投递");
		await waitFor(
			() => {
				const rec = manager.status(id);
				return rec.state === "idle" && String(rec.report ?? "").includes("确认开工");
			},
			`message 后新轮 settled(rec=${JSON.stringify({ state: manager.status(id).state })}, delivered: ${dump()})`,
		);

		manager.collect(id);
		assert.equal(manager.status(id).state, "done");
	},
	LONG,
);

test(
	"send_message to=parent → RoomBus 消息卡(details.type=message),不阻塞子进程",
	async () => {
		const { id } = manager.run(
			{ name: "t2b", prompt: '调用 send_message 工具(text="进展同步",to 缺省),然后只回复:已发送' },
			cwd,
		);
		await waitFor(
			() => delivered.find((m) => m.details.type === "message" && m.details.id === id),
			`消息卡(delivered: ${dump()})`,
		);
		const card = delivered.find((m) => m.details.type === "message" && m.details.id === id);
		assert.ok(card.content.includes("→ parent"), `应指向 parent: ${card.content}`);
		// 异步语义:worker 不被消息阻塞,继续完成本轮并 settled
		await waitFor(() => findCallback("settled", id), `settled(delivered: ${dump()})`);
		manager.collect(id);
	},
	LONG,
);

test(
	"kill:running 中撤换 → abort+终止 → done",
	async () => {
		const { id } = manager.run({ name: "t3", prompt: "写一篇 500 字的文章,用 write 工具保存,分多步完成" }, cwd);
		await new Promise((r) => setTimeout(r, 4000)); // 让它进入 running
		await manager.kill(id);
		await waitFor(() => manager.status(id).state === "done", "kill 后 done", 30000);
	},
	LONG,
);

test(
	"failed:运行中进程被杀 → failed 回调(exit 信号)+ last known",
	async () => {
		const { id, pid } = manager.run({ name: "t4", prompt: "写一篇 500 字的文章,用 write 工具保存,分多步完成" }, cwd);
		await new Promise((r) => setTimeout(r, 4000));
		process.kill(pid, "SIGKILL");

		await waitFor(() => findCallback("failed", id), "failed 回调");
		const msg = findCallback("failed", id);
		assert.match(msg.content, /^failed id=pi-worker-t4#[0-9a-f]{12} exit=/);
		assert.equal(msg.details.exitSignal, "SIGKILL");
		assert.equal(manager.status(id).state, "failed");
	},
	LONG,
);

test(
	"stop:running 中要求收尾 → 收尾回调(软路径 settled / 硬路径 failed)→ collect",
	async () => {
		const { id } = manager.run({ name: "t6", prompt: "写一篇 500 字的文章,用 write 工具保存,分多步完成" }, cwd);
		await new Promise((r) => setTimeout(r, 4000));
		await manager.stop(id);
		// stop 收尾双路径:软(worker 自愿/abort 后 settled)→ idle;硬(STOP_GRACE_MS +
		// STOP_ABORT_WINDOW_MS 内未收尾 → terminate → exit → failed 带诊断)。
		// 两种都是收尾完成,stop 不永久卡 stopping 是唯一不变式。
		// 90s 预算出处:4s 睡 + 30s grace + 15s abort 窗口 + ~2s terminate ≈ 51s worst case,
		// 90s = 1.9×,余量覆盖真实模型生成抖动(live 实测 settle 19s→>60s)。
		await waitFor(
			() => findCallback("settled", id) || findCallback("failed", id),
			`stop 后回调(delivered: ${dump()})`,
			90000,
		);
		const rec = manager.status(id);
		if (rec.state === "idle") {
			manager.collect(id);
		} else {
			assert.equal(rec.state, "failed", "硬终止路径应有 failed 诊断");
			manager.collect(id);
		}
		assert.equal(manager.status(id).state, "done");
	},
	LONG,
);

test(
	"非法 action:actionable 错误",
	async () => {
		const { id } = manager.run({ name: "t5", prompt: "只回复:完成" }, cwd);
		await waitFor(() => manager.status(id).state === "idle", "t5 settled");

		await assert.rejects(
			() => manager.steer(id, "x"),
			(e) => String(e.message).includes("id is idle") && String(e.message).includes("send or collect"),
		);
		await assert.rejects(
			() => manager.followUp("pi-worker-nobody#000000", "x"),
			(e) => String(e.message).includes("id not found") && String(e.message).includes("alive"),
		);
		manager.collect(id);
	},
	LONG,
);

test(
	"tools(G2):只读 worker(read,grep,find,ls)无 write/bash——文件未创建,归一化工具面落记录",
	async () => {
		const { id } = manager.run(
			{ name: "ro", tools: "read,grep,find,ls", prompt: "在当前目录创建文件 should-not-exist.txt(用 write 或 bash);若你没有写工具,只回复:无写工具" },
			cwd,
		);
		await waitFor(() => findCallback("settled", id), "ro settled");
		assert.equal(manager.status(id).tools, "find,grep,ls,read", "归一化工具面落记录(集合语义排序)");
		assert.ok(!existsSync(join(cwd, "should-not-exist.txt")), "只读 worker 不得创建文件");
		manager.collect(id);
	},
	LONG,
);

test(
	"父进程加载 smoke:pi_worker 工具可被 LLM 调用",
	async () => {
		// 真父 pi(rpc,无 PI_WORKER_CHILD):extension 自动发现加载,LLM 应能调 pi_worker。
		const env = { ...process.env };
		delete env.PI_WORKER_CHILD;
		const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--model", MODEL], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const rpc = new RpcClient(proc);
		const settled = new Promise((resolve) => rpc.on("event", (ev) => ev.type === "agent_settled" && resolve()));
		try {
			await rpc.send({ type: "prompt", message: "调用 pi_worker 工具,action=status,然后只回复工具返回的内容。" }, { timeoutMs: 30000 });
			await settled;
			const res = await rpc.send({ type: "get_last_assistant_text" }, { timeoutMs: 15000 });
			assert.ok(
				String(res.text ?? "").includes("pi-worker") || String(res.text ?? "").includes("worker"),
				`父 LLM 应成功调用 pi_worker status: ${res.text}`,
			);
		} finally {
			proc.kill("SIGKILL");
		}
	},
	LONG,
);

test(
	"生命周期 entry:LLM run 后父 session jsonl 落 pi-worker-lifecycle 条目(端到端持久化证据)",
	async () => {
		const env = { ...process.env };
		delete env.PI_WORKER_CHILD;
		const parentSessionDir = mkdtempSync(join(tmpdir(), "pi-worker-parent-"));
		const proc = spawn("pi", ["--mode", "rpc", "--session-dir", parentSessionDir, "--model", MODEL], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const rpc = new RpcClient(proc);
		try {
			await rpc.send(
				{
					type: "prompt",
					message: "调用 pi_worker 工具,参数:action=run, name=lifecycle, prompt=只回复两个字:完成。调用成功后只回复:已派发。",
				},
				{ timeoutMs: 30000 },
			);
			// entry 在 run 的 tool execute 内同步 append;轮询父 session jsonl 直至落盘
			await waitFor(() => {
				const files = existsSync(parentSessionDir)
					? readdirSync(parentSessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"))
					: [];
				return files.some((f) => {
					const content = readFileSync(join(parentSessionDir, String(f)), "utf8");
					return (
						content.includes("pi-worker-lifecycle") &&
						content.includes("pi-worker-lifecycle#") &&
						content.includes("只回复两个字:完成")
					);
				});
			}, "父 session jsonl 落 pi-worker-lifecycle entry");
		} finally {
			proc.kill("SIGKILL");
		}
	},
	LONG,
);

test(
	"/pi-worker 命令:已注册(get_commands 确定性验证)",
	async () => {
		const env = { ...process.env };
		delete env.PI_WORKER_CHILD;
		const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--model", MODEL], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const rpc = new RpcClient(proc);
		try {
			const res = await rpc.send({ type: "get_commands" }, { timeoutMs: 30000 });
			const commands = Array.isArray(res.commands) ? res.commands : [];
			assert.ok(
				commands.some((c) => c?.name === "pi-worker" && c?.source === "extension"),
				`pi-worker 命令应注册: ${commands.map((c) => c?.name).join(", ")}`,
			);
		} finally {
			proc.kill("SIGKILL");
		}
	},
	60000,
);

test(
	"孤儿防护(回归):rpc 子进程 stdin EOF → 自动退出,无挂起",
	async () => {
		// pi --mode rpc 以 stdin 为命令流;父进程退出 → pipe 关闭 → EOF。
		// 若 pi 未来改为 EOF 后挂起,worker 会成为孤儿,此测试即红灯。
		const proc = spawn("pi", ["--mode", "rpc", "--name", "eof-guard", "--session-dir", join(cwd, "eof-session")], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
		await new Promise((r) => setTimeout(r, 800)); // 子进程启动 + 处理命令
		const start = Date.now();
		proc.stdin.end(); // EOF:模拟父死
		const exit = await new Promise((resolve) => {
			proc.on("exit", (code, signal) => resolve({ code, signal }));
			setTimeout(() => resolve({ code: null, signal: "hang" }), 10000);
		});
		assert.notEqual(exit.code, null, `stdin EOF 后应自动退出,实际挂起 ${Date.now() - start}ms`);
	},
	20000,
);

test(
	"并行 3 worker 各自独立 settled:回调按 id 隔离,无串扰",
	async () => {
		// 一次 run 3 个 worker,各自独立 settle。验证:
		// 1) 每个 settled 回调 content/细节都带自己的 id(不互相串);
		// 2) 各自可独立 collect,互不影响;
		// 3) 3 个 session jsonl 都落盘。
		const ids = [];
		for (const n of ["p1", "p2", "p3"]) {
			const { id } = manager.run({ name: n, prompt: "只回复两个字:完成" }, cwd);
			ids.push(id);
		}
		assert.equal(new Set(ids).size, 3, "3 个 worker id 互异");

		for (const id of ids) {
			await waitFor(
				() => findCallback("settled", id),
				`并行 worker ${id} settled(delivered: ${dump()})`,
			);
			const msg = findCallback("settled", id);
			assert.match(msg.content, new RegExp(`^settled id=pi-worker-p[123]#`), `settled 回调应带自身 id: ${msg.content.slice(0, 60)}`);
		}

		// 独立 collect:先收 p1、p3,只剩 p2 仍在 (idle→done)
		manager.collect(ids[0]);
		manager.collect(ids[2]);
		assert.equal(manager.status(ids[0]).state, "done");
		assert.equal(manager.status(ids[2]).state, "done");
		manager.collect(ids[1]);
		assert.equal(manager.status(ids[1]).state, "done");

		// 3 个 worker 的 session jsonl 审计指针都在记录上;验证文件真实存在(落盘审计)
		for (const id of ids) {
			const sf = manager.status(id).sessionFile ?? "";
			assert.match(sf, /\.jsonl$/, `worker ${id} 应有 sessionFile 持针: ${sf}`);
			const abs = sf.startsWith("/") ? sf : join(cwd, sf);
			assert.ok(existsSync(abs), `sessionFile 应真实落盘: ${abs}`);
		}
	},
	LONG,
);

test(
	"竞态 collect:先 collect 一个 worker,另一个仍正常 follow_up + settle + collect",
	async () => {
		// 两个 worker 几乎同时落 idle;先 collect A,再对 B 发 message(追加轮次)。
		// 验证:collect A 不传染 B,B 仍能 message→settled→collect。
		const { id: a } = manager.run({ name: "ra", prompt: "只回复两个字:完成" }, cwd);
		const { id: b } = manager.run({ name: "rb", prompt: "只回复两个字:完成" }, cwd);

		await waitFor(() => findCallback("settled", a), `A settled(delivered: ${dump()})`);
		await waitFor(() => findCallback("settled", b), `B settled(delivered: ${dump()})`);
		assert.equal(manager.status(a).state, "idle");
		assert.equal(manager.status(b).state, "idle");

		// 收集 A,B 不受影响
		manager.collect(a);
		assert.equal(manager.status(a).state, "done");
		assert.equal(manager.status(b).state, "idle", "collect A 不影响 B 的 idle");

		// B 仍可追加轮次(follow_up 语义)
		await manager.message(b, "父指令:请回复:确认开工");
		await waitFor(
			() => manager.status(b).state === "idle" && String(manager.status(b).report ?? "").includes("确认开工"),
			`B message 后新轮 settled(state=${manager.status(b).state}, report=${String(manager.status(b).report ?? "").slice(0, 40)})`,
		);
		manager.collect(b);
		assert.equal(manager.status(b).state, "done");
	},
	LONG,
);
