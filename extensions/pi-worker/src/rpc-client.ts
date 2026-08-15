import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcLike {
	on(event: "event", cb: (ev: Record<string, unknown>) => void): () => void;
	on(event: "exit", cb: (code: number | null, signal: string | null) => void): () => void;
	send(cmd: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
	/** 原始写入(不经 id 关联),如 extension_ui_response */
	writeRaw(obj: Record<string, unknown>): void;
}

/** RPC 协议/传输错误,message 即 actionable 文案 */
export class RpcError extends Error {
	constructor(message: string, readonly command?: string) {
		super(message);
		this.name = "RpcError";
	}
}

/**
 * pi --mode rpc 的 JSONL 客户端。严格 framing:只按 \n 分行(非 readline),
 * 容忍非 JSON 噪音行;response 按 id 关联,事件推给订阅者;send 解析为 data。
 */
export class RpcClient implements RpcLike {
	private nextId = 1;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private exited = false;
	/** spawn 失败(进程从未启动)的诊断,manager 投递 failed 回调时回退使用 */
	spawnError?: string;
	private readonly pending = new Map<
		string,
		{ resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private readonly eventCbs = new Set<(ev: Record<string, unknown>) => void>();
	private readonly exitCbs = new Set<(code: number | null, signal: string | null) => void>();

	constructor(private readonly proc: ChildProcess) {
		proc.stdout?.on("data", (chunk: Buffer | string) => this.onData(chunk));
		proc.on("error", (err: Error) => {
			// spawn 失败(ENOENT 等)或运行期 kill/IO 错误:进程已不可用,与 exit 同路径
			// (reject 全部 pending + 通知 exit 订阅者);error 后进程必死或从未存在,
			// 后续 exit 事件由 exited 守卫挡掉,防双 fire。
			if (this.exited) return;
			this.exited = true;
			if (proc.pid === undefined) this.spawnError = err.message; // 进程从未启动,诊断供 failed 回调
			const rpcErr = new RpcError(err.message);
			for (const { reject, timer } of this.pending.values()) {
				clearTimeout(timer);
				reject(rpcErr);
			}
			this.pending.clear();
			for (const cb of this.exitCbs) cb(null, null);
		});
		proc.on("exit", (code, signal) => {
			if (this.exited) return;
			this.exited = true;
			const err = new RpcError(`child exited (exit=${code ?? signal ?? "?"})`);
			for (const { reject, timer } of this.pending.values()) {
				clearTimeout(timer);
				reject(err);
			}
			this.pending.clear();
			for (const cb of this.exitCbs) cb(code, signal);
		});
	}

	on(event: "event", cb: (ev: Record<string, unknown>) => void): () => void;
	on(event: "exit", cb: (code: number | null, signal: string | null) => void): () => void;
	on(event: "event" | "exit", cb: (...args: never[]) => void): () => void {
		const set = event === "event" ? this.eventCbs : this.exitCbs;
		set.add(cb as never);
		return () => set.delete(cb as never);
	}

	send(cmd: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>> {
		if (this.exited) {
			return Promise.reject(new RpcError(`child exited, cannot send ${String(cmd.type)}`));
		}
		const timeoutMs = opts?.timeoutMs ?? 15000;
		const id = `r${this.nextId++}`;
		const full = { ...cmd, id };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcError(`RPC timeout (${timeoutMs}ms): ${String(cmd.type)}`, String(cmd.type)));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });

			this.proc.stdin?.write(JSON.stringify(full) + "\n", (err) => {
				if (!err) return;
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new RpcError(`stdin write failed: ${err.message}`, String(cmd.type)));
			});
		});
	}

	writeRaw(obj: Record<string, unknown>): void {
		if (this.exited) return;
		this.proc.stdin?.write(JSON.stringify(obj) + "\n");
	}

	private onData(chunk: Buffer | string): void {
		this.buffer += this.decoder.write(chunk);
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // 容忍非 JSON 噪音行
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: Record<string, unknown>): void {
		if (msg.type === "response") {
			const p = this.pending.get(String(msg.id));
			if (!p) return;
			this.pending.delete(String(msg.id));
			clearTimeout(p.timer);
			if (msg.success === false) {
				p.reject(new RpcError(String(msg.error ?? `RPC failed: ${String(msg.command)}`), String(msg.command)));
			} else {
				p.resolve((msg.data as Record<string, unknown>) ?? {});
			}
			return;
		}
		for (const cb of this.eventCbs) cb(msg);
	}
}
