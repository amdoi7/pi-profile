import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { queryPeer, socketDir, type PeerIdentity } from "./transport.ts";
import { ORPHAN_SUSPENDED_MS, presenceOf, readHeartbeat, removeCorpse } from "./process.ts";

/**
 * 名册 = socket 目录里的 heartbeat 文件,零缓存:发现即 readdir heartbeat +
 * 握手 who。目录按 cwd 分区,所以「只和同目录会话通信」是结构保证,这里没有过滤逻辑。
 *
 * 成员身份 = heartbeat 文件(pid + 刷新时间戳),不是 socket 文件:
 * 挂起进程的 socket 可能被外部清理,但 heartbeat + kill 0 仍能暴露"本应在线
 * 的会话"。每次发现都对每个 heartbeat 做一次握手(who),据此分类:
 * - who ok → alive(在线,应答身份);
 * - who dead + heartbeat dead → 尸体,连 socket+heartbeat 一并清;
 * - who mute + heartbeat suspended → suspended(挂起:进程活但事件循环冻结);
 * - who mute + heartbeat online → 进程活着心跳新鲜但不握手:忙/异常 → unknown(不动不猜);
 * - 无 heartbeat(旧版本会话,只有 .sock)→ 旧版本,退回 socket 存在性:ok=alive,
 *   mute=unknown, dead=尸体。
 */
export interface PeerRoster {
	/** 应答了 who 的活会话(排除自己,新开张在前)。 */
	alive: PeerIdentity[];
	/** 挂起(T/D)的会话:pid + 短码。不删,但显式上报。 */
	suspended: { path: string; pid: number }[];
	/** 无证据/忙:不动不猜。 */
	unknown: string[];
}

export async function discoverPeers(
	selfId: string,
	cwd: string,
	query: typeof queryPeer = queryPeer,
	now = Date.now(),
): Promise<PeerRoster> {
	const dir = socketDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { alive: [], suspended: [], unknown: [] }; // 目录不存在 = 本目录从未有 peer 上线
	}
	const hbFiles = entries.filter((f) => f.endsWith(".heartbeat"));
	const hbSockNames = new Set(hbFiles.map((h) => h.replace(/\.heartbeat$/, ".sock")));
	// 无心跳的 .sock = 旧版本残留,一律清(不向后兼容);有对应心跳的不动(走心跳分类)
	const orphanSocks = entries.filter((f) => f.endsWith(".sock") && !hbSockNames.has(f));

	// 读心跳时间戳(无/坏 → 0,即最旧,会被当残留清)
	const hbTs = (hbPath: string): number => {
		const hb = readHeartbeat(hbPath);
		return hb ? hb.ts : 0;
	};

	const alive: PeerIdentity[] = [];
	const suspended: { path: string; pid: number }[] = [];
	const unknown: string[] = [];

	// 同一 sessionId 可能有多代 heartbeat(reload 前/后):按 sessionId 分组,
	// 只保留心跳时间戳最新的一代,旧代是残留,清掉(无论是否自己的旧代)。
	// 自己的最新代不列(不在名册里),但仍参与分组以清掉自己的旧代。
	const bySession = new Map<string, string[]>();
	const sidOf = (hbFile: string): string => hbFile.slice(0, hbFile.indexOf("-")); // 短前缀即身份
	for (const hb of hbFiles) {
		const sid = sidOf(hb);
		const g = bySession.get(sid);
		if (g) g.push(hb);
		else bySession.set(sid, [hb]);
	}
	const chosen: string[] = [];
	const stale: string[] = [];
	for (const group of bySession.values()) {
		group.sort((a, b) => hbTs(join(dir, b)) - hbTs(join(dir, a)));
		chosen.push(group[0]!);
		for (const other of group.slice(1)) stale.push(other);
	}
	// 清掉旧代心跳(及其 socket)——它们是 reload 前的残留
	for (const s of stale) {
		removeCorpse(join(dir, s.replace(/\.heartbeat$/, ".sock")), join(dir, s));
	}

	await Promise.all(
		chosen.map(async (hbFile) => {
			const hbPath = join(dir, hbFile);
			const sockPath = hbPath.replace(/\.heartbeat$/, ".sock");
			// 自己的最新代:不列(自己不在名册里),但也无需清
			if (sidOf(hbFile) === selfId.slice(0, 8)) return;
			const presence = presenceOf(hbPath, now);
			const r = await query(sockPath);
			if (r.status === "ok") {
				if (r.who.sessionId !== selfId) alive.push(r.who);
				return;
			}
			if (presence.status === "dead") {
				removeCorpse(sockPath, hbPath); // 尸体:连 socket+heartbeat 一并清
				return;
			}
			// 进程活(online 或 suspended)+ socket 不应答 = 挂起/忙:心跳存在即证据。
			// 心跳新旧不重要——挂起进程刚被挂起时心跳还新鲜,几秒后 socket 就 mute。
			if (presence.status === "suspended" || presence.status === "online") {
				// 孤儿判定(事实级):同 sessionId 存在更新代且 who ok → 本代已被取代,回收占位。
				const newerSid = bySession.get(sidOf(hbFile));
				const newerAlive = newerSid ? await query(newerSid[0]!.replace(/\.heartbeat$/, ".sock")) : { status: "dead" };
				if (newerAlive.status === "ok") {
					removeCorpse(sockPath, hbPath); // 有活替代者 = 本代必无用:回收(不杀进程)
					return;
				}
				// 无替代者:挂起超时孤儿阈值 → 回收占位(不杀进程)
				if (presence.status === "suspended" && now - hbTs(hbPath) > ORPHAN_SUSPENDED_MS) {
					removeCorpse(sockPath, hbPath);
					return;
				}
				suspended.push({ path: hbFile, pid: presence.pid });
				return;
			}
			// 无心跳可查:不动不猜
			unknown.push(hbFile);
		}),
	);

	// 无心跳的 .sock:握手仍能应答 → 活会话(旧版本,保留并列出);
	// who 拒连(dead)→ 孤儿残留,清。这是「不向后兼容」的边界:
	// 心跳是权威,但对活进程的 socket 不做毁灭性清理。
	await Promise.all(
		orphanSocks.map(async (f) => {
			const path = join(dir, f);
			const r = await query(path);
			if (r.status === "ok") {
				if (r.who.sessionId !== selfId) alive.push(r.who);
			} else if (r.status === "dead") {
				rmSync(path, { force: true }); // 尸体 socket
			} else {
				unknown.push(f); // mute:无心跳可查 → unknown,不动
			}
		}),
	);

	alive.sort((a, b) => b.startedAt - a.startedAt); // 新开张在前
	suspended.sort((a, b) => a.path.localeCompare(b.path));
	unknown.sort();
	return { alive, suspended, unknown };
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
