import { formatModelInfo, summarizeArgs, extractCost, extractTokens, latestStats, formatTokens, type LineColor } from "./present.ts";
import type { SessionEntry, WorkerRecord } from "./types.ts";

/**
 * worker transcript 投影(纯函数,合并窗口 transcript 区的唯一读入口)。
 * 数据源平铺为 SessionEntry[](来源不感知:live = RPC 事件流增量 + get_messages
 * 当前分支回填;dead = 文件一次性解析 parseSessionEntries)——视图层不再碰文件 IO。
 * message 粒度(不按 delta):只投影 text(assistant 走 Markdown 管线)与 toolCall;
 * thinking 不投影(占位行零信息量);≥3 连续 toolCall 折叠为一行(轨迹链刷屏防护);
 * toolResult/custom/compaction 等不投影(成败信号由 pane 诊断与回调承担)。
 * 投影保真:行内容不截断(渲染层按宽度截断)。
 */

export interface TranscriptLine {
	text: string;
	color: LineColor;
	/** assistant text 块:经 Markdown 管线渲染(代码块语法高亮),渲染层负责 */
	markdown?: boolean;
	/** 消息起点(user 首行 / assistant text 块 / toolCall 行):↑↓ 按消息粒度浏览的锚点 */
	anchor?: boolean;
}



function firstText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const c of content) {
			if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
				return String((c as { text?: unknown }).text ?? "");
			}
		}
	}
	return "";
}

const ARGS_MAX = 80;
const REST_MAX = 30;

function toolCallLine(name: string, args: Record<string, unknown>): string {
	const summary = summarizeArgs(args, ARGS_MAX, REST_MAX);
	return summary ? `⚒ ${name}: ${summary}` : `⚒ ${name}`;
}

function pushTextLines(out: TranscriptLine[], text: string, prefixFirst: string, prefixRest: string, color: LineColor, anchor = false): void {
	const lines = text.split("\n");
	lines.forEach((l, i) => out.push({ text: `${i === 0 ? prefixFirst : prefixRest}${l}`, color, ...(anchor && i === 0 ? { anchor: true } : {}) }));
}

function projectMessage(m: NonNullable<SessionEntry["message"]>, out: TranscriptLine[]): void {
	switch (m.role) {
		case "user": {
			pushTextLines(out, firstText(m.content), "❯ ", "  ", "accent", true);
			break;
		}
		case "assistant": {
			// message 粒度投影:thinking 不投影;只 text 与 toolCall
			const content = Array.isArray(m.content) ? m.content : [];
			for (let i = 0; i < content.length; i++) {
				const c = content[i];
				if (!c || typeof c !== "object") continue;
				const block = c as { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
				if (block.type === "text" && block.text) {
					// markdown 块不预拆行:渲染层走 Markdown 管线(高亮),原文保持完整
					out.push({ text: block.text, color: "muted", markdown: true, anchor: true });
				} else if (block.type === "toolCall" && block.name) {
					// 连续 toolCall 运行:≥3 折叠为一行(计数 + 去重名序),1–2 保留逐条参数摘要
					const run: { name: string; arguments?: Record<string, unknown> }[] = [];
					let j = i;
					while (j < content.length) {
						const n = content[j] as { type?: string; name?: string } | null;
						if (!n || typeof n !== "object" || n.type !== "toolCall" || !n.name) break;
						run.push(n as { name: string; arguments?: Record<string, unknown> });
						j++;
					}
					if (run.length >= 3) {
						const names = [...new Set(run.map((r) => r.name))];
						const shown = names.slice(0, 5).join(" · ") + (names.length > 5 ? " …" : "");
						out.push({ text: `⚒ ×${run.length} ${shown}`, color: "dim", anchor: true });
					} else {
						for (const r of run) out.push({ text: toolCallLine(r.name, r.arguments ?? {}), color: "dim", anchor: true });
					}
					i = j - 1;
				}
			}
			break;
		}
		default:
			break; // toolResult/custom/bashExecution/compaction/未知 role:不投影不抛错
	}
}

/** 当前分支 message 序列:有 id/parentId 走树回溯(文件末尾 message 为 tip),否则线性。 */
function currentBranch(entries: SessionEntry[]): SessionEntry[] {
	const messages = entries.filter((e) => e.type === "message" && e.message);
	if (messages.length === 0) return [];
	const linked = messages.every((e) => typeof e.id === "string");
	if (!linked) return messages;
	const byId = new Map(messages.map((e) => [e.id as string, e]));
	const branch: SessionEntry[] = [];
	let cur: SessionEntry | undefined = messages[messages.length - 1];
	const seen = new Set<string>();
	while (cur && !seen.has(cur.id as string)) {
		seen.add(cur.id as string);
		branch.unshift(cur);
		cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
	}
	return branch;
}

/** 条目序列(当前分支) → transcript 行。 */
export function projectEntries(entries: SessionEntry[]): TranscriptLine[] {
	const out: TranscriptLine[] = [];
	for (const e of entries) {
		if (e.type === "message" && e.message) projectMessage(e.message, out);
	}
	return out;
}

/** dead worker 的数据源(进程不在,文件是唯一真相):jsonl 全文 → 当前分支 message 条目。
 * live 不走这里(get_messages 原生返回当前分支,事件流增量追加)。 */
export function parseSessionEntries(content: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			entries.push(JSON.parse(t) as SessionEntry);
		} catch {
			// 坏行跳过(写入中的部分行/手改):视图不纠错
		}
	}
	return currentBranch(entries);
}

/** jsonl 全文 → transcript 行(parse + 分支回溯 + 投影,测试与一次性场景用)。 */
export function projectTranscript(content: string): TranscriptLine[] {
	return projectEntries(parseSessionEntries(content));
}

/**
 * framed 视图标题栏 = 徽章槽:状态图标 + 模型·think + cost + Σtok。
 * name/runtime/活动归主行(行不重复徽章);无任何徽章时回退 name(区域标识最小集)。
 */
export function transcriptTitle(
	rec: WorkerRecord | undefined,
	opts?: { fallbackName?: string; providerName?: string },
): { text: string; color: LineColor } {
	if (!rec) {
		return { text: `● ${opts?.fallbackName ?? "?"}`, color: "dim" };
	}
	let icon = "●";
	let color: LineColor = "dim";
	if (rec.state === "starting" || rec.state === "running") color = "accent";
	else if (rec.state === "stopping" || rec.state === "killing") color = "warning";
	else if (rec.state === "idle") icon = "✓";
	else if (rec.state === "failed") icon = "✗";
	else if (rec.state === "exited") icon = "⏾";
	const badges: string[] = [];
	const model = formatModelInfo(rec, opts?.providerName);
	if (model) badges.push(model);
	const stats = latestStats(rec);
	if (stats) {
		const cost = extractCost(stats);
		if (cost !== undefined) badges.push(`cost $${cost}`);
		const tokens = extractTokens(stats);
		if (tokens !== undefined) badges.push(`${formatTokens(tokens)} tok`);
	}
	return { text: `${icon} ${badges.length > 0 ? badges.join(" · ") : rec.name}`, color };
}

// ---------- transcript 区(合并窗口内嵌,单窗口终局) ----------

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

/**
 * 内嵌 transcript 区:grok framed 子视图的内容核,去掉独立窗口壳。
 * 数据源 = view() 回调(manager 持有:live 事件流 buffer + get_messages 回填,
 * dead 文件一次性解析缓存)——渲染路径零磁盘 IO,无轮询重解析。
 * 投影缓存按(数组引用 + 长度)(manager 原位 push / 回填整体替换均可检出)。
 * 底部跟随(在底部时新内容自动可见,向上滚动脱离 follow,回底恢复)。
 * 空/无源给状态分化提示行,不抛错。
 */
export class TranscriptZone {
	private lines: TranscriptLine[] = [];
	/** 投影缓存的输入指纹:同一数组原位追加 → 长度变;回填替换 → 引用变 */
	private projSrc: SessionEntry[] | undefined;
	private projLen = -1;
	private offset = 0;
	private follow = true;
	private pendingDelta = 0;
	/** markdown 渲染缓存:(宽度+原文) → 渲染行;resetView 重定向时清空 */
	private mdCache = new Map<string, string[]>();
	private readonly view: () => SessionEntry[] | undefined;
	private readonly theme: Theme;
	private readonly stateGetter?: () => string | undefined;

	constructor(deps: { view: () => SessionEntry[] | undefined; theme: Theme; state?: () => string | undefined }) {
		this.view = deps.view;
		this.theme = deps.theme;
		this.stateGetter = deps.state;
	}

	/** 重定向到另一 worker:滚动回底部(follow),投影与 md 缓存失效。 */
	resetView(): void {
		this.projSrc = undefined;
		this.projLen = -1;
		this.offset = 0;
		this.follow = true;
		this.mdCache.clear();
	}

	/** 缺失提示按 worker 状态分化:starting = 等待握手(transient);终态 = 已清理/无产物(permanent)。 */
	private missingLine(): TranscriptLine {
		const st = this.stateGetter?.();
		if (st === "starting" || st === "running") {
			return { text: "(⏳ 等待握手,worker 运行中尚未产出 transcript…)", color: "dim" };
		}
		if (st === "done" || st === "failed" || st === "exited") {
			return { text: "(该 worker 无 session 文件:已清理或未握手)", color: "dim" };
		}
		return { text: "(无 session 文件:worker 未握手或记录已清理)", color: "dim" };
	}

	/** delta 行滚动(渲染行空间;pending 在下一次 renderBody 生效,那里才知道渲染后总长)。 */
	scroll(delta: number): void {
		this.pendingDelta += delta;
	}

	/** 当前正文行:无源/空 → 状态提示;否则投影(缓存命中跳过)。 */
	private body(): TranscriptLine[] {
		const entries = this.view();
		if (!entries || entries.length === 0) return [this.missingLine()];
		if (entries !== this.projSrc || entries.length !== this.projLen) {
			this.projSrc = entries;
			this.projLen = entries.length;
			this.lines = projectEntries(entries);
		}
		return this.lines;
	}

	/** markdown 块经 pi 原生管线渲染(getMarkdownTheme 含 cli-highlight 代码高亮,
	 * 与父 transcript 同一渲染器);缓存按 宽度+原文,宽度变化自动重渲染。 */
	private materialize(l: TranscriptLine, width: number): string[] {
		if (!l.markdown) return [this.theme.fg(l.color, l.text)];
		const key = `${width}\n${l.text}`;
		let rendered = this.mdCache.get(key);
		if (!rendered) {
			rendered = new Markdown(l.text, 0, 0, getMarkdownTheme()).render(width);
			this.mdCache.set(key, rendered);
		}
		return rendered;
	}

	/** 当前内容的渲染行数:布局按需分配高度用(空 transcript 不独占窗口)。
	 * 与 renderBody 同一 materialize 路径(mdCache 命中,成本可忽略)。 */
	measureBody(width: number): number {
		let n = 0;
		for (const l of this.body()) n += this.materialize(l, width).length;
		return n;
	}

	/** 窗口化正文:恒返回 height 行(不足补空行,布局稳定)。 */
	renderBody(width: number, height: number): string[] {
		const body = this.body();
		const rendered: string[] = [];
		for (const l of body) {
			rendered.push(...this.materialize(l, width));
		}
		const maxOffset = Math.max(0, rendered.length - height);
		if (this.pendingDelta !== 0) {
			this.offset = Math.min(Math.max(0, this.offset + this.pendingDelta), maxOffset);
			this.follow = this.offset >= maxOffset;
			this.pendingDelta = 0;
		}
		if (this.follow) this.offset = maxOffset;
		this.offset = Math.min(this.offset, maxOffset);
		const out = rendered.slice(this.offset, this.offset + height);
		while (out.length < height) out.push("");
		return out;
	}
}
