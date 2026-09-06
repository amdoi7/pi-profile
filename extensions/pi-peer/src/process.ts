import { readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * 在场性判定(全 Node 原生,零外部命令):
 * 每个会话启动时写一个 <sessionId>.heartbeat 文件(内容 = pid + 刷新时间戳),
 * 并周期刷新(见 index.ts 的 heartbeat 定时器)。观察者读 heartbeat:
 * - pid 存在(kill 0 成功)+ 时间戳新鲜 → 在线;
 * - pid 存在但 heartbeat 过期 → 挂起(进程 T/D,事件循环冻结,无法刷新);
 * - pid 不存在 → 尸体(残留文件可清)。
 *
 * 名册成员 = heartbeat 文件,而不是 socket 文件:挂起进程的 socket 可能被外部
 * 清理,但 heartbeat + pid 仍能暴露"本应在线的会话"。这正是"握手/心跳 =
 * 在线性证据"的落地:光有 socket 文件存在不算数,要有活的心跳。
 *
 * 不查"谁持有 socket"(macOS 无 procfs,libproc 无 JS 绑定,lsof/ps 是外部命令),
 * 改为让会话自报 pid——观察者只做原生读 + kill 0,零依赖零权限问题。
 */
export const HEARTBEAT_FRESH_MS = 2 * 60_000; // 心跳 60s 刷新,2min 内算新鲜
/** 挂起超时孤儿阈值:心跳停更超过此时长 = 大概率被遗忘,回收占位(不杀进程)。 */
export const ORPHAN_SUSPENDED_MS = 15 * 60_000;

export interface Heartbeat {
	pid: number;
	ts: number;
}

export function readHeartbeat(hbPath: string): Heartbeat | null {
	try {
		const raw = readFileSync(hbPath, "utf8").trim();
		const m = /^(\d+)\s+(\d+)$/.exec(raw);
		if (!m) return null;
		const pid = Number(m[1]);
		const ts = Number(m[2]);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts)) return null;
		return { pid, ts };
	} catch {
		return null;
	}
}

export function writeHeartbeat(hbPath: string, pid: number, now = Date.now()): void {
	writeFileSync(hbPath, `${pid} ${now}\n`, { mode: 0o600 });
}

/** 进程是否存在(信号 0):挂起/僵尸也算存在;EPERM(异 uid)按存在处理。 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type Presence =
	/** 心跳新鲜 + 进程活:在线。 */
	| { status: "online"; pid: number }
	/** 心跳过期但进程活:挂起(事件循环冻结,无法刷新)。 */
	| { status: "suspended"; pid: number }
	/** 进程已不存在:尸体,残留文件可清。 */
	| { status: "dead"; pid: number }
	/** 无心跳文件(旧版本会话)或读不到:不动不猜。 */
	| { status: "unknown" };

/** 根据 heartbeat 文件判在场性。 */
export function presenceOf(hbPath: string, now = Date.now()): Presence {
	const hb = readHeartbeat(hbPath);
	if (hb === null) return { status: "unknown" };
	if (!isPidAlive(hb.pid)) return { status: "dead", pid: hb.pid };
	if (now - hb.ts > HEARTBEAT_FRESH_MS) return { status: "suspended", pid: hb.pid };
	return { status: "online", pid: hb.pid };
}

/** 清理尸体:socket + heartbeat 一并移除(仅调用方确认尸体后)。 */
export function removeCorpse(socketPath: string, hbPath: string): void {
	rmSync(socketPath, { force: true });
	rmSync(hbPath, { force: true });
}
