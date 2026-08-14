import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ID_RE } from "./contract.ts";
import { displayNameOf } from "./present.ts";

/**
 * 启动恢复(G1):jsonl 是 persisted(stateless,at-rest)artifact,本模块把它 recover 成
 * live(stateful)记录——worker-sessions 目录即 registry,session jsonl 是 worker 身份的
 * single source of truth(pi 原生 --name 把 worker id 写进 session_info,零并行文件)。
 * 父重启后 records 从磁盘恢复,审计/归因/重派有据。
 *
 * 归属(同 cwd 多 TUI 窗口):spawn 落在 p<父pid> 子目录,所有权编码进目录结构;
 * 恢复时本实例 pid 目录与平铺文件(未知归属,历史布局)恢复,活他窗口目录不认领
 * (heldElsewhere 显式声明),死他窗口目录按孤儿恢复。pid 复用是已知理论误判面
 * (kill(pid,0) 探活),影响仅限多认领一条记录,可 collect 清理。
 *
 * 收起标记:collect 在 session 尾部追加 pi-worker-collected 条目,扫描时排除
 * (collected 显式声明)——审计留痕与恢复去重兼得,不删文件。
 *
 * 「什么算 session / 怎么读 name / created/modified」全部委托 pi 原生 SessionManager
 * (与 /resume 同一 listSessionsFromDir 路径,上游格式演进自动跟进);本层只拥有
 * worker 身份判定、归属判定与丢弃范围声明(skipped/collected/heldElsewhere)。
 */

/** collect 在 session 尾部落的收起标记(customType)。 */
export const COLLECTED_MARKER = "pi-worker-collected";

/** 归属目录形态:p<父pid>。 */
const OWNER_DIR_RE = /^p(\d+)$/;

/** 标记尾查窗口:64KB 足够覆盖尾部标记(collect 后子进程不再写入)。 */
const TAIL_SCAN_BYTES = 65536;

/** pid 探活(可注入测试);EPERM = 存在但无权,视为活。pid 复用是已知理论误判面。 */
export function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface Ownership {
	/** 本实例 pid */
	pid: number;
	pidAlive: (pid: number) => boolean;
}

export interface RecoveredSession {
	/** worker id(session_info name,--name 注入):pi-worker-<name>#<12hex> */
	id: string;
	/** 显示名(id 的 name 段) */
	name: string;
	/** jsonl 绝对路径(审计指针) */
	sessionFile: string;
	/** session header timestamp(native SessionInfo.created) */
	createdAt: number;
	/** 最后活动时间(native SessionInfo.modified:末条消息时间,回退 header/mtime) */
	updatedAt: number;
}

export interface ScanResult {
	sessions: RecoveredSession[];
	/** 不可解析/非 worker 文件(相对基目录路径) */
	skipped: string[];
	/** 活他窗口持有的 worker id(未认领) */
	heldElsewhere: string[];
	/** 已收起的文件(相对基目录路径) */
	collected: string[];
}

/** session 尾部是否带收起标记。读取失败按未标记(宁可恢复,不静默丢审计)。 */
function hasCollectedMarker(path: string): boolean {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - TAIL_SCAN_BYTES);
			const buf = Buffer.alloc(size - start);
			readSync(fd, buf, 0, buf.length, start);
			return buf.toString("utf8").includes(COLLECTED_MARKER);
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

interface ScanTarget {
	/** 扫描目录(基目录或 p<pid> 子目录) */
	dir: string;
	/** 相对基目录的路径前缀(声明用) */
	prefix: string;
}

async function scanDir(
	target: ScanTarget,
	out: { sessions: RecoveredSession[]; skipped: string[]; collected: string[] },
): Promise<void> {
	let files: string[];
	try {
		files = readdirSync(target.dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return;
	}
	if (files.length === 0) return;
	// listAll(dir):custom sessionDir 路径,无 cwd 过滤(worker-sessions 是专属目录)
	const infos = await SessionManager.listAll(target.dir);
	const byFile = new Map(infos.map((i) => [basename(i.path), i]));
	for (const f of files) {
		const rel = `${target.prefix}${f}`;
		const info = byFile.get(f);
		if (!info || !Number.isFinite(info.created.getTime())) {
			out.skipped.push(rel); // native 判定非 session(首行非 session header / 不可解析)
			continue;
		}
		if (!info.name || !ID_RE.test(info.name)) {
			out.skipped.push(rel); // 合法 session 但非 worker(session_info name 不是 worker id)
			continue;
		}
		if (hasCollectedMarker(info.path)) {
			out.collected.push(rel); // 已收起:恢复去重,审计保留
			continue;
		}
		out.sessions.push({
			id: info.name,
			name: displayNameOf(info.name),
			sessionFile: info.path,
			createdAt: info.created.getTime(),
			updatedAt: info.modified.getTime(),
		});
	}
}

/**
 * 扫描基目录下平铺 *.jsonl(未知归属,历史布局)与 p<父pid> 子目录(归属命名空间)。
 * ownership 缺省 = 全量扫描(兼容调用);持有判定只在 ownership 给定时发生。
 * 目录不存在 = 无遗留(合法态,不报错)。结果按 createdAt 排序(确定性)。
 */
export async function scanWorkerSessions(dir: string, ownership?: Ownership): Promise<ScanResult> {
	const out: ScanResult = { sessions: [], skipped: [], heldElsewhere: [], collected: [] };
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	// 平铺层(含 legacy):始终扫描
	await scanDir({ dir, prefix: "" }, out);
	// 归属子目录:本实例/死他窗口 → 扫描;活他窗口 → 扫描仅取 id 声明,不恢复
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const m = OWNER_DIR_RE.exec(e.name);
		if (!m) continue;
		const owner = Number(m[1]);
		const sub = join(dir, e.name);
		if (ownership && owner !== ownership.pid && ownership.pidAlive(owner)) {
			const held: ScanTarget = { dir: sub, prefix: `${e.name}/` };
			const tmp: ScanResult = { sessions: [], skipped: [], heldElsewhere: [], collected: [] };
			await scanDir(held, tmp);
			out.heldElsewhere.push(...tmp.sessions.map((s) => s.id));
			continue;
		}
		await scanDir({ dir: sub, prefix: `${e.name}/` }, out);
	}
	out.sessions.sort((a, b) => a.createdAt - b.createdAt);
	return out;
}
