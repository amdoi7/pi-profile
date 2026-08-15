import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 跨进程投递:每会话一个 unix domain socket,窄协议 NDJSON(一连接一消息)。
 * 语义:同步往返——写消息 → 对方注入成功才回 ack → 连接关闭。
 * fail-fast 取代 durability(消息是摘要文本,丢失必须显形而非永生):
 * - 连接拒绝 = 对方已下线(发送方立即显式失败,无黑洞);
 * - ack 前连接断/超时 = 状态不明,发送方自查后重试(重复无害);
 * - 不暴露 pi RPC 面:本协议只有一个动词(投递文本)。
 */

export interface PeerMessage {
	from: { sessionId: string; name?: string; cwd?: string };
	text: string;
	/** 投递模式(与 pi 内核 deliverAs 同词汇):followUp = 对方当前轮结束后投递再唤醒;steer = 注入对方当前轮(运行中 turn 间隙生效);quiet = 只留痕不唤醒 */
	mode: "followUp" | "steer" | "quiet";
	ts: number;
}

const PROBE_TIMEOUT_MS = 150;
const SEND_TIMEOUT_MS = 2_000;

/** socket 目录放 tmpdir:macOS sun_path 上限 104 字符,peersRoot 可深(PI_PEER_DIR 指到长路径) */
export function socketDir(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return join(tmpdir(), `pi-peer-${uid}`);
}

export function socketPathFor(sessionId: string): string {
	// sessionId 截 16 位压长度(碰撞概率可忽略;完整 id 在注册文件里,发送方按注册文件的路径直连)
	return join(socketDir(), `${sessionId.slice(0, 16)}.sock`);
}

export function isPeerMessage(x: unknown): x is PeerMessage {
	const m = x as PeerMessage;
	return (
		!!m &&
		typeof m.text === "string" &&
		(m.mode === "followUp" || m.mode === "steer" || m.mode === "quiet") &&
		!!m.from &&
		typeof m.from.sessionId === "string"
	);
}

/** 活性真相:连接即活,拒绝/超时即死(socket 随进程消亡,无 pid 复用误判) */
export function probeSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection(socketPath);
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.setTimeout(timeoutMs, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

export interface PeerServer {
	/** false = 同 sessionId 已有活进程在服务,本实例退让(不注册,发送仍可用) */
	serving: boolean;
	close(): void;
}

/** 起服务:stale socket 文件接管(探测不通 → unlink 再 listen);活进程冲突 → 退让。 */
export async function startPeerServer(
	socketPath: string,
	handler: (msg: PeerMessage) => Promise<void>,
): Promise<PeerServer> {
	mkdirSync(socketDir(), { recursive: true, mode: 0o700 });
	try {
		chmodSync(socketDir(), 0o700);
	} catch {}
	if (await probeSocket(socketPath)) return { serving: false, close: () => {} };
	try {
		unlinkSync(socketPath); // 死进程残留文件
	} catch {}
	const server = createServer((conn) => {
		let buf = "";
		conn.on("data", (d) => {
			buf += d.toString();
			const i = buf.indexOf("\n");
			if (i < 0) return;
			const line = buf.slice(0, i);
			conn.pause(); // 一连接一消息,后续数据不属于本协议
			void (async () => {
				let reply: string;
				try {
					const msg: unknown = JSON.parse(line);
					if (!isPeerMessage(msg)) {
						reply = JSON.stringify({ ok: false, error: "invalid message shape (need from.sessionId + text + mode)" });
					} else {
						await handler(msg); // 注入成功才 ack:ack = 已送达
						reply = JSON.stringify({ ok: true });
					}
				} catch (e) {
					reply = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
				}
				conn.end(reply + "\n");
			})();
		});
		conn.on("error", () => {}); // 发送方中断:注入与否已各自显形,无需处理
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	return {
		serving: true,
		close: () => {
			server.close();
			try {
				unlinkSync(socketPath);
			} catch {}
		},
	};
}

/** 同步投递:成功 = 对方已注入;失败抛出显式原因(不在线/被拒/超时不明)。 */
export async function sendPeerMessage(socketPath: string, msg: PeerMessage, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const s = createConnection(socketPath);
		let buf = "";
		let settled = false;
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			s.destroy();
			reject(e);
		};
		s.setTimeout(timeoutMs, () => fail(new Error("peer receive timeout (may or may not have been injected; check the peer session before deciding to resend)")));
		s.once("error", () => fail(new Error("peer offline (socket unreachable); use action=list to refresh online sessions")));
		s.on("data", (d) => {
			buf += d.toString();
			const i = buf.indexOf("\n");
			if (i < 0 || settled) return;
			settled = true;
			s.destroy();
			let ack: { ok?: boolean; error?: string };
			try {
				ack = JSON.parse(buf.slice(0, i));
			} catch {
				reject(new Error("unparsable peer ack"));
				return;
			}
			if (ack.ok) resolve();
			else reject(new Error(`peer rejected: ${ack.error ?? "unknown reason"}`));
		});
		s.on("connect", () => s.write(JSON.stringify(msg) + "\n"));
	});
}
