import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { queryPeer, socketDir, type PeerIdentity } from "./transport.ts";

/**
 * 名册 = socket 目录本身,零缓存:发现即 readdir + 并行 who。
 * 目录按 cwd 分区,所以「只和同目录会话通信」是结构保证,这里没有过滤逻辑。
 * 身份永远来自活进程(新鲜性不需要维护);连接拒绝的 .sock 是尸体文件,
 * 即扫即清(内核真相:活进程的 socket 不会拒连,不存在误杀)。
 *
 * mute(可连但答不出身份)既不列出也不清:能连上就说明监听进程还活着，只是当时
 * 没应答——删它才是错的。也不计数上报:「几个 socket 没应答」对调用方零可行动性，
 * 那是作者向遥测，不该走模型通道。
 */
export async function discoverPeers(
	selfId: string,
	cwd: string,
	query: typeof queryPeer = queryPeer,
): Promise<PeerIdentity[]> {
	const dir = socketDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((f) => f.endsWith(".sock"));
	} catch {
		return []; // 目录不存在 = 本目录从未有 peer 上线
	}
	const alive: PeerIdentity[] = [];
	await Promise.all(
		entries.map(async (f) => {
			const path = join(dir, f);
			const r = await query(path);
			if (r.status === "ok") {
				if (r.who.sessionId !== selfId) alive.push(r.who);
			} else if (r.status === "dead") {
				rmSync(path, { force: true });
			}
		}),
	);
	alive.sort((a, b) => b.startedAt - a.startedAt); // 新开张在前
	return alive;
}

/** sessionId(或其前缀)→ 唯一活 peer;前缀撞多个就报候选,不替调用方猜。 */
export function resolvePeer(
	peers: PeerIdentity[],
	to: string,
): { ok: true; peer: PeerIdentity } | { ok: false; reason: string } {
	const matches = peers.filter((p) => p.sessionId.startsWith(to));
	if (matches.length === 0) return { ok: false, reason: `no live peer matching “${to}”` };
	if (matches.length > 1) {
		const list = matches.map((p) => p.sessionId.slice(0, 8)).join(", ");
		return { ok: false, reason: `“${to}” is ambiguous, candidates: ${list}` };
	}
	return { ok: true, peer: matches[0]! };
}
