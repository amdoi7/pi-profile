import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 窄协议:一连接一请求,NDJSON,每连接至多一行请求 + 一行应答。
 * - deliver:发送方写一行消息 → 收方接管(注入排队)→ ack 一行 → 关闭;
 * - who:发送方写 {"op":"who"} → 收方答一行身份 → 关闭。
 * ack 在接管之后:成功返回 = 对方进程已收下,不是「写进了 socket」。
 * 身份 = 同目录内 sessionId 而已:cwd 已由 socket 目录(见 socketDir)保证一致,
 * 所以 who 只回「是谁 + 会话文件(审计/闲置)+ 何时开张(排序)」。
 */
export interface PeerIdentity {
	sessionId: string;
	/** 会话 jsonl(ephemeral/print 无文件时缺省);闲置时长按其 mtime 计 */
	sessionFile?: string;
	startedAt: number;
}

export interface PeerMessage {
	/** 发送方 sessionId(同目录内即全部身份) */
	from: string;
	text: string;
	/** 发送时间戳。 */
	ts: number;
}

const PROBE_TIMEOUT_MS = 150;
const WHO_TIMEOUT_MS = 1_000;
const SEND_TIMEOUT_MS = 2_000;

/**
 * socket 目录即名册,且按 cwd 分区:同目录才通信是结构保证,不是运行期过滤——
 * 别的目录的会话根本不在这个目录里,连都不会连。
 *
 * 路径预算(macOS sun_path 上限 104):tmpdir(48) + pi-peer-<uid>(12) + cwd 摘要(9)
 * + 文件名(24) = 93。PI_PEER_DIR 覆盖基址(测试隔离;覆盖路径必须短)。
 */
export function socketDir(cwd: string): string {
	const base = process.env.PI_PEER_DIR ?? join(tmpdir(), `pi-peer-${typeof process.getuid === "function" ? process.getuid() : 0}`);
	// 分区键走 canonical 路径:两个会话一个走 symlink 一个走真路径时,否则彼此隐身
	// (静默失联,比报错更难查)。路径不存在就用原串，至少保持确定性。
	let key = cwd;
	try {
		key = realpathSync.native(cwd);
	} catch {
		key = cwd;
	}
	return join(base, createHash("sha256").update(key).digest("hex").slice(0, 8));
}

export function socketPathFor(sessionId: string, cwd: string): string {
	// UUIDv7 前 12 hex 是时间戳:同毫秒创建的会话共享长前缀,裸截断会碰撞
	// (碰撞会触发假退让,收信静默失联)。截 12 位可读前缀 + sha256 前 6 位
	// 消歧;路径是 (sessionId, cwd) 的纯函数,回执等反向投递直接 derive。
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
	return join(socketDir(cwd), `${sessionId.slice(0, 12)}-${digest}.sock`);
}

export function isPeerMessage(x: unknown): x is PeerMessage {
	const m = x as PeerMessage;
	return (
		!!m &&
		typeof m.text === "string" &&
		typeof m.from === "string" &&
		m.from !== ""
	);
}

function isWhoRequest(x: unknown): boolean {
	return !!x && (x as { op?: unknown }).op === "who";
}

/**
 * NDJSON 行帧:累积到首个换行后把该行交给 onLine,只消费一次
 * (协议 = 一连接一请求,后续字节无意义)。
 */
function lineFraming(onLine: (line: string) => void) {
	let buf = "";
	let consumed = false;
	return (chunk: Buffer) => {
		if (consumed) return;
		buf += chunk.toString();
		const nl = buf.indexOf("\n");
		if (nl === -1) return;
		consumed = true;
		onLine(buf.slice(0, nl));
	};
}

/** 一次请求-应答:写一行,读一行,超时即失败(fail-fast,不重试)。 */
function request(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const conn = connect(path);
		const done = (err?: Error, value?: unknown) => {
			conn.destroy();
			err ? reject(err) : resolve(value);
		};
		conn.setTimeout(timeoutMs, () => done(new Error("timeout")));
		conn.on("error", done);
		conn.on("connect", () => conn.write(`${JSON.stringify(payload)}\n`));
		conn.on("data", lineFraming((line) => {
			try {
				done(undefined, JSON.parse(line));
			} catch (e) {
				done(e instanceof Error ? e : new Error(String(e)));
			}
		}));
		conn.on("close", () => done(new Error("closed before reply")));
	});
}

export type QueryResult =
	/** 应答身份 = 活会话 */
	| { status: "ok"; who: PeerIdentity }
	/** 拒连 = 无进程持有(尸体文件) */
	| { status: "dead" }
	/** 连得上但不应答(wedged 进程/异物):不列出也不清 */
	| { status: "mute" };

export async function queryPeer(path: string, timeoutMs = WHO_TIMEOUT_MS): Promise<QueryResult> {
	try {
		const reply = await request(path, { op: "who" }, timeoutMs);
		const who = reply as PeerIdentity;
		if (who && typeof who.sessionId === "string") return { status: "ok", who };
		return { status: "mute" };
	} catch (e) {
		// 没进程监听就是尸体:不存在/拒连/根本不是 socket 的残留文件
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK") return { status: "dead" };
		return { status: "mute" };
	}
}

/**
 * 投递:ack.ok=true 才算送达。三种失败各自有话说,因为下一步不同:
 * 离线 = 对方不在了(重新 list);拒收 = 对方接了但注入失败;超时 = 不确定投没投进去。
 */
export async function sendPeerMessage(path: string, msg: PeerMessage, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
	let reply: { ok?: boolean; error?: string };
	try {
		reply = (await request(path, msg, timeoutMs)) as { ok?: boolean; error?: string };
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ECONNREFUSED") throw new Error("peer offline (socket not answering)");
		if (e instanceof Error && e.message === "timeout") {
			throw new Error("peer receive timeout (may or may not have been injected; check the peer session before deciding)");
		}
		throw e;
	}
	if (!reply?.ok) throw new Error(`peer rejected: ${reply?.error ?? "unknown error"}`);
}

export async function probeSocket(path: string): Promise<boolean> {
	return (await queryPeer(path, PROBE_TIMEOUT_MS)).status !== "dead";
}

export interface PeerServer {
	/** false = 已有活进程持有该 socket(退让,不抢) */
	serving: boolean;
	close: () => void;
}

export interface ServerHandlers {
	who: () => PeerIdentity;
	deliver: (msg: PeerMessage) => Promise<void>;
}

/**
 * 接管 socket:活进程持有 → 退让;尸体/残留文件 → unlink 后接管。
 * 判定用 probe(连得上即活),不看文件属性。
 */
export async function startPeerServer(path: string, handlers: ServerHandlers): Promise<PeerServer> {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	if (existsSync(path)) {
		if (await probeSocket(path)) return { serving: false, close: () => {} };
		rmSync(path, { force: true });
	}

	// 协议分发:解析 + who/deliver/形状拒绝;单一 try/catch 兜底,永不 reject。
	const handleRequest = async (line: string): Promise<string> => {
		let reply: string;
		try {
			const req: unknown = JSON.parse(line);
			if (isWhoRequest(req)) {
				reply = JSON.stringify(handlers.who());
			} else if (isPeerMessage(req)) {
				await handlers.deliver(req);
				reply = JSON.stringify({ ok: true });
			} else {
				reply = JSON.stringify({ ok: false, error: "invalid request (need op=who or from + text)" });
			}
		} catch (e) {
			reply = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
		}
		return reply;
	};

	const server = createServer((conn) => {
		conn.on("data", lineFraming((line) => {
			void handleRequest(line).then((reply) => conn.end(reply + "\n"));
		}));
		conn.on("error", () => conn.destroy());
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});

	return {
		serving: true,
		close: () => {
			server.close();
			rmSync(path, { force: true }); // close 即 unlink = 从名册消失
		},
	};
}
