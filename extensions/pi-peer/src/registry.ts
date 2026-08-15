import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeSocket } from "./transport.ts";

/**
 * peer 注册中心:同机 pi 会话的磁盘名册,纯 rendezvous——文件只回答
 * 「谁在线、socket 在哪」,消息不经这里(见 transport.ts)。
 * 布局:<root>/<sessionId>.json;root 固定默认路径(不同 agentDir 的 pi 也能互见),
 * PI_PEER_DIR 覆盖(测试/隔离)。
 * 活性:读时探测 socket(连接即活);探测失败即清扫文件,无心跳无 pid 探活。
 */

export interface PeerInfo {
	/** schema 版本(v1 曾带 pid/heartbeat,无外部消费者,直接切换不兼容旧文件) */
	v: 2;
	sessionId: string;
	/** pi session name(--name / 自动派生);缺省 = 未命名 */
	name?: string;
	cwd: string;
	/** 会话 jsonl(ephemeral/print 无文件时缺省) */
	sessionFile?: string;
	/** 投递地址(transport.ts 窄协议 socket) */
	socketPath: string;
	startedAt: number;
}

export function peersRoot(): string {
	return process.env.PI_PEER_DIR ?? join(homedir(), ".pi", "agent", "peers");
}

/** 原子写:tmp + rename(读方不会读到半文件)。 */
function writeAtomic(path: string, data: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, data, "utf8");
	renameSync(tmp, path);
}

/** session_start 注册自己(自己独占自己的文件,无并发)。 */
export function registerSelf(root: string, info: PeerInfo): void {
	mkdirSync(root, { recursive: true });
	writeAtomic(join(root, `${info.sessionId}.json`), JSON.stringify(info));
}

export function unregisterSelf(root: string, sessionId: string): void {
	rmSync(join(root, `${sessionId}.json`), { force: true });
}

/** 列同机活 peers(排除自己):并行探测 socket,死连接的文件即扫即清。
 * 解析失败的文件不静默:跳过并计数返回。 */
export async function listPeers(
	root: string,
	selfId: string,
	probe: (socketPath: string) => Promise<boolean> = probeSocket,
): Promise<{ alive: PeerInfo[]; corrupt: number }> {
	mkdirSync(root, { recursive: true });
	const candidates: { path: string; info: PeerInfo }[] = [];
	let corrupt = 0;
	for (const f of readdirSync(root)) {
		if (!f.endsWith(".json")) continue;
		const path = join(root, f);
		let info: PeerInfo;
		try {
			info = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			corrupt++;
			continue;
		}
		if (!info || info.v !== 2 || typeof info.sessionId !== "string" || typeof info.socketPath !== "string") {
			corrupt++;
			continue;
		}
		if (info.sessionId === selfId) continue;
		candidates.push({ path, info });
	}
	const alive: PeerInfo[] = [];
	await Promise.all(
		candidates.map(async ({ path, info }) => {
			if (await probe(info.socketPath)) alive.push(info);
			else rmSync(path, { force: true }); // socket 不可达 = 进程已死,文件即垃圾
		}),
	);
	alive.sort((a, b) => b.startedAt - a.startedAt); // 新开张在前
	return { alive, corrupt };
}

/** name/sessionId → 唯一活 peer。同 cwd 优先(同目录协作是主场景);歧义报候选。 */
export function resolvePeer(
	peers: PeerInfo[],
	to: string,
	selfCwd: string,
): { ok: true; peer: PeerInfo } | { ok: false; reason: string } {
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
