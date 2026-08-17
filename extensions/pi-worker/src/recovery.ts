import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cwdFromWorkerSessionFile, ID_RE, workerSessionDir } from "./contract.ts";
import { displayNameOf } from "./present.ts";

/**
 * 重启认领(G1):父重启后子进程随父死(stdin EOF 自退,孤儿防护),worker session
 * jsonl 留在 <cwd>/.pi/worker-sessions——本模块把它们认领回 live 记录。
 * 身份判定委托 pi 原生 SessionManager(listAll:与 /resume 同一解析路径,上游格式
 * 演进自动跟进);本层只拥有 worker 身份判定(ID_RE)与丢弃范围声明(skipped/collected)。
 *
 * 身份 = session_info 条目的 name(--name 注入的 worker id);文件名为 UUID,
 * 不做身份载体。无 session_info 身份的旧文件跳过(身份不可判定,不猜)。
 *
 * 认领的唯一否决源 = 收起标记:collect/kill 在 session 尾部追加 pi-worker-collected
 * 条目(appendSessionLine 残行补换行,保证 marker 独占完整一行),扫描时尾窗逐行解析
 * customType 精确排除(呈报文本含字面量不误判)——审计留痕与恢复去重兼得,不删文件。
 * 同 id 多代次由调用方按最新 createdAt 认领。
 *
 * 已知边界:同 cwd 多 TUI 窗口时,活他窗口的 worker 文件也会被认领(exited 记录,
 * 无 pid 归属可判——平铺布局的固有限制)。认领只建记录,不碰进程;危险动作
 * (resume 同文件再 spawn)仅发生在父显式 send 时,单窗口场景无此路径。
 */

/** collect 在 session 尾部落的收起标记(customType)。 */
export const COLLECTED_MARKER = "pi-worker-collected";

/** 标记尾查窗口:64KB 足够覆盖尾部标记(collect 后子进程不再写入)。 */
const TAIL_SCAN_BYTES = 65536;

/** 解析为收起标记条目? */
function isMarkerEntry(s: string): boolean {
	try {
		const e = JSON.parse(s);
		return e?.type === "custom" && e?.customType === COLLECTED_MARKER;
	} catch {
		return false;
	}
}

/** 追加一行到 session 尾部。末行无换行(进程写一半被杀)时先补换行——
 * marker 必须独占完整一行,读侧逐行解析 customType;粘连会导致整行 parse 失败。 */
export function appendSessionLine(path: string, line: string): void {
	let needsNewline = false;
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			if (size > 0) {
				const b = Buffer.alloc(1);
				readSync(fd, b, 0, 1, size - 1);
				needsNewline = b[0] !== 0x0a;
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		// 读失败按直接追加(写侧错误由 appendFileSync 抛出,调用方已 catch)
	}
	appendFileSync(path, (needsNewline ? "\n" : "") + line);
}

/** session 尾部是否带收起标记。读取失败按未标记(宁可恢复,不静默丢审计)。 */
export function hasCollectedMarker(path: string): boolean {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - TAIL_SCAN_BYTES);
			const buf = Buffer.alloc(size - start);
			readSync(fd, buf, 0, buf.length, start);
			// 精确匹配:逐行解析 customType——尾窗 substring 会把呈报文本里的
			// 字面量(如让 worker 修改本扩展)误判为已收起,拒绝认领
			for (const line of buf.toString("utf8").split("\n")) {
				if (!line.includes(COLLECTED_MARKER)) continue; // 快速预筛
				if (isMarkerEntry(line)) return true;
				// 截断行/非 JSON 跳过。写侧保证 marker 独占完整一行(appendSessionLine
				// 残行补换行);不为旧写入的粘连文件做恢复(不做向后兼容)。
			}
			return false;
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

export interface LeftoverSession {
	/** worker id(session_info name,--name 注入):pi-worker-<name>#<12hex> */
	id: string;
	/** 显示名(id 的 name 段) */
	name: string;
	/** jsonl 绝对路径(审计指针,冷恢复 --session 同文件续接) */
	sessionFile: string;
	/** 父 cwd(锚点反解,失败回退扫描 cwd;resume spawn 用) */
	cwd: string;
	/** session header timestamp */
	createdAt: number;
}

/** 扫描 <cwd>/.pi/worker-sessions 平铺 *.jsonl,返回可认领的遗留 worker session。
 * 目录不存在 = 空数组(合法态,不报错)。结果按 createdAt 排序(确定性)。
 * 跳过:非 session 文件/无身份的 session/已收起的文件(尾窗精确匹配 COLLECTED_MARKER)。 */
export async function scanLeftoverSessions(cwd: string): Promise<LeftoverSession[]> {
	const dir = workerSessionDir(cwd);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	if (files.length === 0) return [];
	const infos = await SessionManager.listAll(dir);
	const byFile = new Map(infos.map((i) => [basename(i.path), i]));
	const sessions: LeftoverSession[] = [];
	for (const f of files) {
		const info = byFile.get(f);
		if (!info || !Number.isFinite(info.created.getTime())) continue;
		if (!info.name || !ID_RE.test(info.name)) continue;
		if (hasCollectedMarker(info.path)) continue;
		sessions.push({
			id: info.name,
			name: displayNameOf(info.name),
			sessionFile: info.path,
			cwd: cwdFromWorkerSessionFile(info.path) ?? cwd,
			createdAt: info.created.getTime(),
		});
	}
	sessions.sort((a, b) => a.createdAt - b.createdAt);
	return sessions;
}
