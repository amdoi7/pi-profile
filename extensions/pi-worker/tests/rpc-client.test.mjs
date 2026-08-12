import { test } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { RpcClient } from "../src/rpc-client.ts";

/** RpcClient 传输单测:fake proc(不起进程)。核心:Critical 1 的 error 路径语义。 */
function fakeProc({ pid } = {}) {
	const proc = new EventEmitter();
	proc.pid = pid;
	proc.stdout = { on: () => {} };
	proc.stderr = { on: () => {} };
	proc.stdin = { write: (line, cb) => cb?.(null) };
	return proc;
}

test("spawn 失败(error,pid 未定)→ pending reject 带 err.message,exitCbs 触发一次,后续 send 拒绝", async () => {
	const proc = fakeProc(); // pid undefined = spawn 失败
	const rpc = new RpcClient(proc);
	const exits = [];
	rpc.on("exit", (code, signal) => exits.push([code, signal]));
	const p = rpc.send({ type: "get_state" });
	proc.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }));
	await assert.rejects(p, /ENOENT/);
	assert.deepEqual(exits, [[null, null]]);
	await assert.rejects(rpc.send({ type: "prompt", message: "x" }), /已退出/);
});

test("error 后 exit 同来 → exitCbs 只触发一次(守卫)", () => {
	const proc = fakeProc();
	const rpc = new RpcClient(proc);
	const exits = [];
	rpc.on("exit", (code, signal) => exits.push([code, signal]));
	proc.emit("error", new Error("spawn pi ENOENT"));
	proc.emit("exit", -2, null);
	assert.deepEqual(exits, [[null, null]]);
});

test("正常 exit → pending reject + exitCbs(code, signal)", async () => {
	const proc = fakeProc({ pid: 123 });
	const rpc = new RpcClient(proc);
	const exits = [];
	rpc.on("exit", (code, signal) => exits.push([code, signal]));
	const p = rpc.send({ type: "get_state" });
	proc.emit("exit", 0, null);
	await assert.rejects(p, /已退出/);
	assert.deepEqual(exits, [[0, null]]);
});

test("response 按 id 关联(逆序响应),噪音行容忍", async () => {
	let dataCb;
	const proc = fakeProc({ pid: 123 });
	proc.stdout = { on: (ev, cb) => { if (ev === "data") dataCb = cb; } }; // 构造前替换,构造器订阅此捕获器
	const rpc = new RpcClient(proc);
	const written = [];
	proc.stdin.write = (line, cb) => {
		written.push(JSON.parse(line));
		cb?.(null);
	};
	const p1 = rpc.send({ type: "get_state" });
	const p2 = rpc.send({ type: "prompt", message: "x" });
	assert.equal(written.length, 2);
	// 逆序:先回 p2,再回 p1;中间夹噪音行与 \r\n
	dataCb("not json\n");
	dataCb(JSON.stringify({ type: "response", id: written[1].id, data: { ok: true } }) + "\r\n");
	dataCb(JSON.stringify({ type: "response", id: written[0].id, data: { state: "running" } }) + "\n");
	assert.deepEqual(await p2, { ok: true });
	assert.deepEqual(await p1, { state: "running" });
});
