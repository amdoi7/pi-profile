import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 跨进程投递与身份:每会话一个 unix domain socket,窄协议 NDJSON(一连接一请求)。
 * socket 即存在性(进程持有 ⇔ 进程活),身份元数据由活进程按需应答(who),
 * 不落盘不缓存——名册的一切staleness问题因此不存在。
 * 两个动词:
 * - deliver(PeerMessage):写消息 → 对方进程接管(排队注入)即回 ack → 关连接。
 *   fail-fast 取代 durability:连接拒绝 = 对方已死;ack 前断/超时 = 状态不明,
 *   发送方自查后重试(失败不记账,重复无害);注入失败(ack 后)由接收方回执显形。
 * - who:返回会话身份(sessionId/name/cwd/sessionFile/startedAt),实时读取,
 *   永远新鲜;能答 who 才算在线(比裸 connect 更强的活性:答不了 who 的
 *   wedged 进程本来也收不了信)。
 */

export interface PeerIdentity {
	sessionId: string;
	/** pi session name(--name / 自动派生);缺省 = 未命名 */
	name?: string;
	cwd: string;
	/** 会话 jsonl(ephemeral/print 无文件时缺省);闲置时长按其 mtime 计 */
	sessionFile?: string;
	startedAt: number;
}

export interface PeerMessage {
	from: { sessionId: string; name?: string; cwd?: string };
	text: string;
	/** 投递模式(与 pi 内核 deliverAs 同词汇):followUp = 对方当前轮结束后投递再唤醒;steer = 注入对方当前轮(运行中 turn 间隙生效);quiet = 只留痕不唤醒 */
	mode: "followUp" | "steer" | "quiet";
	ts: number;
}

const PROBE_TIMEOUT_MS = 150;
const WHO_TIMEOUT_MS = 1_000;
const SEND_TIMEOUT_MS = 2_000;

/** socket 目录即名册:macOS sun_path 上限 104 字符,固定放 tmpdir(短);
 * PI_PEER_DIR 覆盖(测试隔离;注意覆盖路径必须短)。 */
export function socketDir(): string {
	if (process.env.PI_PEER_DIR) return process.env.PI_PEER_DIR;
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return join(tmpdir(), `pi-peer-${uid}`);
}

export function socketPathFor(sessionId: string): string {
	// UUIDv7 前 12 hex 是时间戳:同毫秒创建的会话共享长前缀,裸截断会碰撞
	// (碰撞会触发假退让,收信静默失联)。截 12 位可读前缀 + sha256 前 10 位
	// 消歧;路径是 sessionId 的纯函数,回执等反向投递直接 derive。
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
	return join(socketDir(), `${sessionId.slice(0, 12)}-${digest}.sock`);
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

function isWhoRequest(x: unknown): boolean {
	return !!x && (x as { op?: unknown }).op === "who";
}

export function isPeerIdentity(x: unknown): x is PeerIdentity {
	const p = x as PeerIdentity;
	return !!p && typeof p.sessionId === "string" && typeof p.cwd === "string";
}

/** 活性真相:连接即活,拒绝/超时即死(socket 随进程消亡,无 pid 复用误判)。
 * 仅接管判定用;名册级活性用 queryPeer(能答 who 才算在线)。 */
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
	/** false = 同 sessionId 已有活进程在服务,本实例退让(发送仍可用;接管重试见 reconciler) */
	serving: boolean;
	close(): void;
}

export interface PeerServerHandlers {
	/** 身份应答:每次 who 实时求值(改名/换 sessionFile 即时可见) */
	who(): PeerIdentity;
	/** 消息接管:返回即 ack(注入异步,失败另有回执) */
	deliver(msg: PeerMessage): Promise<void>;
}

/** 起服务:stale socket 文件接管(探测不通 → unlink 再 listen);活进程冲突 → 退让。 */
export async function startPeerServer(socketPath: string, handlers: PeerServerHandlers): Promise<PeerServer> {
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
			conn.pause(); // 一连接一请求,后续数据不属于本协议
			void (async () => {
				let reply: string;
				try {
					const req: unknown = JSON.parse(line);
					if (isWhoRequest(req)) {
						reply = JSON.stringify({ ok: true, who: handlers.who() });
					} else if (isPeerMessage(req)) {
						await handlers.deliver(req);
						reply = JSON.stringify({ ok: true });
					} else {
						reply = JSON.stringify({ ok: false, error: "invalid request (need op=who or from.sessionId + text + mode)" });
					}
				} catch (e) {
					reply = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
				}
				conn.end(reply + "\n");
			})();
		});
		conn.on("error", () => {}); // 发送方中断:结果已各自显形,无需处理
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

/** 单次请求-应答往返(内部:deliver 与 who 共用连接、超时、ack 解析)。 */
function roundTrip(socketPath: string, payload: unknown, timeoutMs: number, timeoutError: string): Promise<{ ok?: boolean; error?: string; who?: unknown }> {
	return new Promise((resolve, reject) => {
		const s = createConnection(socketPath);
		let buf = "";
		let settled = false;
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			s.destroy();
			reject(e);
		};
		s.setTimeout(timeoutMs, () => fail(new Error(timeoutError)));
		s.once("error", () => fail(new Error("peer offline (socket unreachable); use action=list to refresh online sessions")));
		s.on("data", (d) => {
			buf += d.toString();
			const i = buf.indexOf("\n");
			if (i < 0 || settled) return;
			settled = true;
			s.destroy();
			try {
				resolve(JSON.parse(buf.slice(0, i)));
			} catch {
				reject(new Error("unparsable peer ack"));
			}
		});
		s.on("connect", () => s.write(JSON.stringify(payload) + "\n"));
	});
}

/** 同步投递:成功 = 对方已接管;失败抛出显式原因(不在线/被拒/超时不明)。 */
export async function sendPeerMessage(socketPath: string, msg: PeerMessage, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
	const ack = await roundTrip(socketPath, msg, timeoutMs, "peer receive timeout (may or may not have been injected; check the peer session before deciding to resend)");
	if (!ack.ok) throw new Error(`peer rejected: ${ack.error ?? "unknown reason"}`);
}

/** 名册级身份查询。三态:ok = 在线且给出身份;dead = 连接拒绝(尸体文件,可回收);
 * mute = 可连但答不出合法身份(wedged/旧协议/异物)——不列出也不回收(不确定即不动)。 */
export async function queryPeer(
	socketPath: string,
	timeoutMs = WHO_TIMEOUT_MS,
): Promise<{ status: "ok"; who: PeerIdentity } | { status: "dead" } | { status: "mute" }> {
	try {
		const ack = await roundTrip(socketPath, { op: "who" }, timeoutMs, "who timeout");
		return ack.ok && isPeerIdentity(ack.who) ? { status: "ok", who: ack.who } : { status: "mute" };
	} catch (e) {
		return e instanceof Error && e.message.startsWith("peer offline") ? { status: "dead" } : { status: "mute" };
	}
}
