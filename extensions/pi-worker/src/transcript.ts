import { formatModelInfo, summarizeArgs, extractCost, extractTokens, latestStats, formatTokens, type LineColor } from "./present.ts";
import type { WorkerRecord } from "./types.ts";

/**
 * worker session jsonl → transcript 投影(纯函数,合并窗口 transcript 区的唯一读入口)。
 * message 粒度(不按 delta):只投影 text(assistant 走 Markdown 管线)与 toolCall;
 * thinking 不投影(占位行零信息量);≥3 连续 toolCall 折叠为一行(轨迹链刷屏防护);
 * toolResult/custom/compaction 等不投影(成败信号由
 * pane 诊断与回调承担)。投影保真:行内容不截断(渲染层按宽度截断);
 * v3 树结构沿 parentId 回溯当前分支(文件末尾 message 条目为 tip),v1 线性按顺序。
 * 未知条目类型/坏行跳过不抛错(诊断面在 session 文件本身,视图不做纠错)。
 */

export interface TranscriptLine {
	text: string;
	color: LineColor;
	/** assistant text 块:经 Markdown 管线渲染(代码块语法高亮),渲染层负责 */
	markdown?: boolean;
	/** 消息起点(user 首行 / assistant text 块 / toolCall 行):↑↓ 按消息粒度浏览的锚点 */
	anchor?: boolean;
}

interface SessionEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: { role?: string; [k: string]: unknown };
	customType?: string;
	data?: unknown;
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

/** jsonl 全文 → transcript 行。 */
export function projectTranscript(content: string): TranscriptLine[] {
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
	const out: TranscriptLine[] = [];
	for (const e of currentBranch(entries)) {
		projectMessage(e.message as NonNullable<SessionEntry["message"]>, out);
	}
	return out;
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

import { readFileSync, statSync } from "node:fs";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

/**
 * 内嵌 transcript 区:grok framed 子视图的内容核,去掉独立窗口壳
 * (终局是合并单窗口:tasks panel 的 entry 即 worker 代表,transcript 同屏)。
 * 活性:render 重 stat 文件,size 变才重读重解析;底部跟随(在底部时新内容
 * 自动可见,向上滚动脱离 follow,回底恢复)。文件缺失给提示行,不抛错。
 */
export class TranscriptZone {
	private file: string;
	private lines: TranscriptLine[] = [];
	private lastSize = -1;
	private offset = 0;
	private follow = true;
	private missing = false;
	private pendingDelta = 0;
	private pendingMessageSteps = 0;
	/** markdown 渲染缓存:(宽度+原文) → 渲染行;setFile 重定向时清空 */
	private mdCache = new Map<string, string[]>();

	constructor(
		deps: { file: string; theme: Theme },
	) {
		this.file = deps.file;
		this.theme = deps.theme;
	}
	private readonly theme: Theme;

	/** 重定向到另一 worker 的 session 文件:强制重读,滚动回底部(follow)。 */
	setFile(file: string): void {
		if (file === this.file) return;
		this.file = file;
		this.lastSize = -1;
		this.offset = 0;
		this.follow = true;
		this.mdCache.clear();
	}

	/** delta 行滚动(渲染行空间;pending 在下一次 renderBody 生效,那里才知道渲染后总长)。 */
	scroll(delta: number): void {
		this.pendingDelta += delta;
	}

	/** 消息粒度浏览:↑↓ 逐条跳到前/后一条消息起点(渲染行空间,下一次 renderBody 生效)。 */
	scrollMessage(direction: -1 | 1): void {
		this.pendingMessageSteps += direction;
	}

	private reload(): void {
		try {
			const size = statSync(this.file).size;
			if (size !== this.lastSize) {
				this.lastSize = size;
				this.lines = projectTranscript(readFileSync(this.file, "utf8"));
				this.missing = false;
			}
		} catch {
			// 首次读不到 → 缺失提示;中途消失保留旧投影(不闪烁)
			if (this.lastSize < 0) this.missing = true;
		}
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
		this.reload();
		const body: TranscriptLine[] = this.missing
			? [{ text: "(无 session 文件:worker 未握手或记录已清理)", color: "dim" }]
			: this.lines;
		let n = 0;
		for (const l of body) n += this.materialize(l, width).length;
		return n;
	}

	/** 窗口化正文:恒返回 height 行(不足补空行,布局稳定)。 */
	renderBody(width: number, height: number): string[] {
		this.reload();
		const body: TranscriptLine[] = this.missing
			? [{ text: "(无 session 文件:worker 未握手或记录已清理)", color: "dim" }]
			: this.lines;
		const rendered: string[] = [];
		const anchors: number[] = [];
		for (const l of body) {
			if (l.anchor) anchors.push(rendered.length);
			rendered.push(...this.materialize(l, width));
		}
		const maxOffset = Math.max(0, rendered.length - height);
		if (this.pendingDelta !== 0) {
			this.offset = Math.min(Math.max(0, this.offset + this.pendingDelta), maxOffset);
			this.follow = this.offset >= maxOffset;
			this.pendingDelta = 0;
		}
		if (this.pendingMessageSteps !== 0) {
			if (anchors.length > 0) {
				// 当前锚点 = 不晚于 offset 的最后一个锚点;步进后钳到边界
				let ai = 0;
				for (let k = 0; k < anchors.length; k++) if (anchors[k] <= this.offset) ai = k;
				ai = Math.min(Math.max(0, ai + this.pendingMessageSteps), anchors.length - 1);
				this.offset = Math.min(anchors[ai], maxOffset);
			} else {
				this.offset = Math.min(Math.max(0, this.offset + this.pendingMessageSteps), maxOffset);
			}
			this.follow = this.offset >= maxOffset;
			this.pendingMessageSteps = 0;
		}
		if (this.follow) this.offset = maxOffset;
		this.offset = Math.min(this.offset, maxOffset);
		const out = rendered.slice(this.offset, this.offset + height);
		while (out.length < height) out.push("");
		return out;
	}
}
