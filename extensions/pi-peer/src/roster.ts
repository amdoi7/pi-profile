import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { queryPeer, socketDir, type PeerIdentity } from "./transport.ts";

/**
 * 名册 = socket 目录本身,零缓存:发现即 readdir + 并行 who。
 * 身份永远来自活进程(新鲜性不需要维护);连接拒绝的 .sock 是尸体文件,
 * 即扫即清(内核真相:活进程的 socket 不会拒连,不存在误杀)。
 *
 * mute(可连但答不出身份)既不列出也不清:能连上就说明监听进程还活着，只是当时
 * 没应答——删它才是错的。也不计数上报:「几个 socket 没应答」对调用方零可行动性，
 * 那是作者向遥测，不该走模型通道。
 */

export async function discoverPeers(
	selfId: string,
	query: typeof queryPeer = queryPeer,
): Promise<PeerIdentity[]> {
	const dir = socketDir();
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((f) => f.endsWith(".sock"));
	} catch {
		return []; // 目录不存在 = 从未有 peer 上线
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

/** name/sessionId → 唯一活 peer。同 cwd 优先(同目录协作是主场景);歧义报候选。 */
export function resolvePeer(
	peers: PeerIdentity[],
	to: string,
	selfCwd: string,
): { ok: true; peer: PeerIdentity } | { ok: false; reason: string } {
	const matches = peers.filter((p) => p.name === to || p.sessionId === to || p.sessionId.startsWith(to));
	if (matches.length === 0) {
		return { ok: false, reason: `no live peer matching “${to}”; use action=list to see online sessions` };
	}
	const sameCwd = matches.filter((p) => p.cwd === selfCwd);
	const candidates = sameCwd.length > 0 ? sameCwd : matches;
	if (candidates.length > 1) {
		const list = candidates.map((p) => `${p.name ?? "(unnamed)"}(${p.sessionId.slice(0, 8)} cwd=${p.cwd})`).join("; ");
		return { ok: false, reason: `“${to}” is ambiguous, candidates: ${list}; specify sessionId to disambiguate` };
	}
	return { ok: true, peer: candidates[0] };
}
