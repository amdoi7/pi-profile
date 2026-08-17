import type { CallbackMessage } from "./bridge.ts";
import { STOP_DEADLINE_MS } from "./contract.ts";
import { WorkerError, type CollectVerdict, type WorkerRecord, type WorkerState } from "./types.ts";

/**
 * UI 投影纯函数(主权界面:决策点显式化优先于进度投影)。无副作用,可单测。
 * 设计语言:静态状态词汇(✓✗⏾●,STATE_FACETS 单一来源)、⏺ 动作、⎿ 续行;
 * 语义靠颜色(accent/warning/error/dim),不靠生造字形;
 * footer 双区(工作区 │ 决策区)。
 */

const WORKING_STATES = new Set(["starting", "running", "stopping"]);

export type FooterColor = "accent" | "warning" | "error" | "dim";
export type Fg = (color: FooterColor, text: string) => string;
const plainFg: Fg = (_c, t) => t;

/** token 紧凑格式:<1000 原值;≥1000 一位小数 k,去尾零(45.2k / 45k / 1.5k)。 */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** footer 心跳:只留工具名(停滞检测),参数是诊断信息,归 overlay。 */
function footerActivity(activity: string | undefined): string | undefined {
	if (!activity) return undefined;
	return activity.replace(/^tool: /, "").split(" ")[0];
}

/**
 * 显示名:id 的 name 段(pi-worker-<name>#<hash> → <name>)。
 * 显示层统一用人可读名(一轮 session 内 name 即区分标识);
 * 完整 id 只留在 content/status/工具参数等机器契约里。
 */
export function displayNameOf(id: string): string {
	const m = id.match(/^pi-worker-(.+)#[0-9a-f]{12}$/);
	return m ? m[1] : id;
}

export interface FooterOptions {
	/** elapsed 与活动心跳的时钟源 */
	now: number;
	/** 语义色注入(默认无色,测试友好) */
	fg?: Fg;
	/** 决策区入口的快捷键提示(如 "alt+w");缺省只给 /pi-worker 命令 */
	openHint?: string;
}

/**
 * 运行态颜色脉冲:grok animated bullet 对等物——词汇静态(● 不换字形),
 * 颜色呼吸(偶数秒亮 accent,奇数秒回 dim);1s liveTick 提供重绘节拍。
 * 告警面(stopping/killing warning)不脉冲——警示需要恒定可见。
 */
export function pulseBright(now: number): boolean {
	return Math.floor(now / 1000) % 2 === 0;
}

/** 行内截断:总长含省略号 ≤ n。 */
function trunc(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * 工具调用参数摘要(无键白名单):首个标量参数 = 主语(pi 工具 schema 惯例:主语属性
 * command/path/pattern 声明在最前),其余标量 key=value;对象/数组/空值跳过;布尔/数字
 * 主语用 key=value(裸值无信息)。对任何(未来)工具自动适用,零维护。pi 原生
 * renderCall 是最权威渲染器,但 getAllTools 的 ToolInfo 已 strip renderCall,扩展不可达。
 * transcript 行(⚒)与 watcher 心跳(tool: name …)共用。
 */
export function summarizeArgs(args: Record<string, unknown>, maxSubject: number, maxRest: number): string {
	const scalars = Object.entries(args).filter(
		([, v]) => (typeof v === "string" && v.length > 0) || typeof v === "number" || typeof v === "boolean",
	);
	if (scalars.length === 0) return "";
	const [firstKey, firstVal] = scalars[0];
	const subject =
		typeof firstVal === "string" ? trunc(firstVal.replace(/\s+/g, " ").trim(), maxSubject) : `${firstKey}=${String(firstVal)}`;
	const rest = scalars.slice(1).map(([k, v]) => {
		const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : String(v);
		return `${k}=${trunc(s, maxRest)}`;
	});
	return [subject, ...rest].join(" · ");
}

/**
 * Footer 投影:回答"系统在忙吗?有决策在等我吗?"。
 * 决策区在左、工作区在右:pi 把扩展 status 单行拼接超宽截尾,需要用户行动的
 * 决策区必须靠前,工作区(信息性)可被截。工作区:单 worker(图标+name+工具名
 * 心跳+elapsed),多 worker 聚合(最早创建者具名 +N、Σtok);决策区按严重度
 * ✗failed>✓idle>⏾exited 计数,任一待决策即带 /pi-worker 入口。
 * 终态(done/failed 之外)与瞬态(killing)不投影;无内容 → undefined。
 */
export function formatFooter(records: WorkerRecord[], opts: FooterOptions): string | undefined {
	const fg = opts.fg ?? plainFg;
	const working = records
		.filter((r) => WORKING_STATES.has(r.state))
		.sort((a, b) => a.createdAt - b.createdAt);

	let workZone = "";
	if (working.length === 1) {
		const r = working[0];
		// 图标与 STATE_FACETS 同词汇(静态);stopping 警示色(告警面)
		const icon = fg(r.state === "stopping" ? "warning" : "accent", markOf(r).icon);
		const parts = [icon, r.name];
		const activity = footerActivity(r.currentActivity);
		if (activity) parts.push(activity);
		parts.push(formatRuntime(r, opts.now));
		workZone = parts.join(" · ").replace(" · ", " "); // 图标后是空格不是 ·
	} else if (working.length > 1) {
		// 高可信聚合:代表名(最早创建)+ 运行时长 + Σtok;turns 是内部计数,决策价值低于耗时
		const tokens = working.reduce((s, r) => {
			const t = extractTokens(latestStats(r));
			return s + (typeof t === "number" && Number.isFinite(t) ? t : 0);
		}, 0);
		const parts = [
			`${markOf(working[0]).icon} ${working[0].name} +${working.length - 1}`,
			formatRuntime(working[0], opts.now),
		];
		if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
		workZone = parts.join(" · ");
	}

	// 决策区:STATE_FACETS 的 decision 成员按 rank 序(failed→idle→exited),图标同表。
	// footer 色是告警语义本地政策(与 overlay 行色不同源):failed=error、exited=warning、
	// idle=dim,非正常收尾(length 截断/aborted 中断)升 warning 并带标记——需复核的验收对象。
	const counts = new Map<WorkerState, number>();
	for (const r of records) {
		if (STATE_FACETS[r.state].decision) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
	}
	const idleAbnormal = records.filter((r) => r.state === "idle" && r.stopReason && r.stopReason !== "stop");
	const footerColor = (s: WorkerState): FooterColor =>
		s === "failed" ? "error" : s === "exited" ? "warning" : idleAbnormal.length > 0 ? "warning" : "dim";
	const decisionParts: string[] = [];
	let decisionTotal = 0;
	const decisionStates = (Object.keys(STATE_FACETS) as WorkerState[])
		.filter((s) => STATE_FACETS[s].decision)
		.sort((a, b) => STATE_FACETS[a].rank - STATE_FACETS[b].rank);
	for (const s of decisionStates) {
		const n = counts.get(s) ?? 0;
		if (n === 0) continue;
		decisionTotal += n;
		const tag =
			s === "idle"
				? idleAbnormal.length === 1
					? ` stop:${idleAbnormal[0].stopReason}`
					: idleAbnormal.length > 1
						? ` ${idleAbnormal.length} 异常收尾`
						: ""
				: "";
		decisionParts.push(fg(footerColor(s), `${STATE_FACETS[s].mark?.icon} ${n} ${s}${tag}`));
	}
	// 任一决策待办(失败归因/ idle 验收/ exited 清理)即给行动入口:命令 + 快捷键提示
	// (入口复用:footer 是纯文本,键绑定是唯一可交互通道,见 index.ts registerShortcut)
	if (decisionTotal > 0) {
		decisionParts.push(fg("dim", opts.openHint ? `/pi-worker · ${opts.openHint}` : "/pi-worker"));
	}
	const decisionZone = decisionParts.join(" · ");

	if (!workZone && !decisionZone) return undefined;
	if (workZone && decisionZone) return `${decisionZone} │ ${workZone}`;
	return workZone || decisionZone;
}

export interface CallbackView {
	kind: "settled" | "message" | "failed" | "action";
	/** ⏺ 主动作行(Claude 动作 bullet,kind 决定颜色) */
	header: string;
	/** settled = 四要素呈报 markdown(核验证据段不藏);failed = 诊断 */
	body: string;
	bodyIsMarkdown: boolean;
	/** ⎿ 续行摘要:turns · tokens · cost;无统计缺省 */
	summary?: string;
}

/** 统一 cost 提取:多处渲染共用,判空一致。 */
export function extractCost(stats: unknown): number | undefined {
	if (stats && typeof stats === "object" && "cost" in stats) {
		const cost = (stats as { cost: unknown }).cost;
		if (typeof cost === "number" && Number.isFinite(cost)) return cost;
	}
	return undefined;
}

/** 统一 tokens.total 提取(与 extractCost 同判空规则)。 */
export function extractTokens(stats: unknown): number | undefined {
	if (stats && typeof stats === "object" && "tokens" in stats) {
		const total = (stats as { tokens: { total?: unknown } }).tokens?.total;
		if (typeof total === "number" && Number.isFinite(total)) return total;
	}
	return undefined;
}

/** 标题聚合统计(与 footer 同词汇同色:✗failed > ✓idle > ⏾exited > ●工作中);
 * 全终态 → undefined(统计行省略)。 */
export function formatPaneStats(records: WorkerRecord[], fg: Fg = plainFg): string | undefined {
	const count = (states: readonly string[]) => records.filter((r) => states.includes(r.state)).length;
	const failed = count(["failed"]);
	const idle = count(["idle"]);
	const exited = count(["exited"]);
	const working = count(["starting", "running", "stopping"]);
	const parts: string[] = [];
	if (failed > 0) parts.push(fg("error", `✗ ${failed} failed`));
	if (idle > 0) parts.push(fg("dim", `✓ ${idle} idle`));
	if (exited > 0) parts.push(fg("warning", `⏾ ${exited} exited`));
	if (working > 0) parts.push(fg("accent", `● ${working} 工作中`));
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** 最近用量快照(turn_end 覆写,投影层唯一读入口)。 */
export function latestStats(r: { latestStats?: Record<string, unknown> }): Record<string, unknown> | undefined {
	return r.latestStats;
}

/** 回调消息 → 渲染视图。settled 报告全文即终审输入,渲染上不折叠。
 * 显示标识统一用 name(#hash 只在 content/status 的机器契约里)。 */
export function formatCallbackView(msg: CallbackMessage): CallbackView {
	const d = msg.details as Record<string, unknown>;
	const id = String(d.id ?? "");
	// 显示名统一取 id 的 name 段(helper 一处推导,不依赖投递侧额外字段)
	const name = displayNameOf(id);
	if (d.type === "message") {
		return {
			kind: "message",
			header: `⏺ msg ${name}`,
			body: String(d.text ?? ""),
			bodyIsMarkdown: false,
		};
	}
	if (d.type === "failed") {
		const exit = String(d.exitCode ?? d.exitSignal ?? "?");
		const stderr = d.stderrTail ? `\n${String(d.stderrTail)}` : "";
		return {
			kind: "failed",
			header: `⏺ failed ${name}`,
			body: `exit=${exit}${stderr}`,
			bodyIsMarkdown: false,
		};
	}
	if (d.type === "settled") {
		const statsBits: string[] = [];
		if (typeof d.turns === "number") {
			statsBits.push(d.turns === 1 ? "1 turn" : `${d.turns} turns`);
		}
		// stopReason 不进事件卡(一次性)：它是状态属性，常驻显示归 footer/状态行。
		const tokens = extractTokens(d.stats);
		if (tokens !== undefined) statsBits.push(`${formatTokens(tokens)} tokens`);
		const cost = extractCost(d.stats);
		if (cost !== undefined) statsBits.push(`$${cost.toFixed(4)}`);
		const report = String(d.report ?? "");
		// 与 bridge.formatCallback 同判空:报告缺失回退错误/占位,不静默空卡
		const body = report || (d.reportError ? `(呈报获取失败: ${String(d.reportError)})` : "(无呈报)");
		return {
			kind: "settled",
			header: `⏺ settled ${name}`,
			body,
			bodyIsMarkdown: true,
			summary: statsBits.length > 0 ? `⎿ ${statsBits.join(" · ")}` : undefined,
		};
	}
	// action-done 审计与未知类型:content 即 body,不再静默落 settled 空卡
	return {
		kind: "action",
		header: `⏺ action ${name}`,
		body: String(msg.content ?? ""),
		bodyIsMarkdown: false,
	};
}

/** renderCall:动作 + 目标 + 关键参数(单行;task/message 40 字符截断,
 * 全文在工具 result/details;model/thinking 仅显式指定时渲染——缺省值无信息)。 */
const CALL_PARAM_MAX = 40;
function quotedParam(s: string): string {
	const t = s.trim();
	return `"${t.length > CALL_PARAM_MAX ? `${t.slice(0, CALL_PARAM_MAX)}…` : t}"`;
}

export function formatToolCallLine(
	action: string,
	params: { id?: string; name?: string; text?: string; model?: string; thinking?: string; tools?: string },
): string {
	const target = params.name || (params.id ? displayNameOf(params.id) : "");
	const parts = [action];
	if (target) parts.push(target);
	if (action === "run") {
		if (params.text?.trim()) parts.push(quotedParam(params.text));
		if (params.tools?.trim()) parts.push(`· tools:${params.tools.trim()}`);
		if (params.model?.trim()) {
			parts.push(`· ${params.model.trim()}${params.thinking?.trim() ? ` think:${params.thinking.trim()}` : ""}`);
		} else if (params.thinking?.trim()) {
			parts.push(`· think:${params.thinking.trim()}`);
		}
	} else if (action === "send" && params.text?.trim()) {
		parts.push(quotedParam(params.text));
	}
	return parts.join(" ");
}

export interface Toast {
	level: "info" | "error";
	text: string;
}

/** failed 送达时即时提醒;settled 进 transcript 即可,不 toast。 */
export function toastFor(msg: CallbackMessage): Toast | null {
	const d = msg.details as Record<string, unknown>;
	if (d.type === "failed") {
		const exit = String(d.exitCode ?? d.exitSignal ?? "?");
		return { level: "error", text: `worker failed: ${String(d.id ?? "")} exit=${exit}` };
	}
	return null;
}

// ---------- overlay 行投影 ----------

/** 模型行:握手生效值优先,未握手用 spawn 参数;无参数 → 空。providerName 为父侧
 * 查到的 provider 显示名(如 "OpenCode Go"),缺省用 id。 */
export function formatModelInfo(r: WorkerRecord, providerName?: string): string {
	if (r.modelInfo) {
		const provider = providerName ?? r.modelInfo.provider;
		const think = r.modelInfo.thinkingLevel ? ` · think:${r.modelInfo.thinkingLevel}` : "";
		return `${provider}/${r.modelInfo.id}${think}`;
	}
	if (r.model) {
		return `${r.model}${r.thinking ? ` · think:${r.thinking}` : ""}`;
	}
	return "";
}

/** 运行时长:打开时算一次,无定时器。 */
export function formatRuntime(r: WorkerRecord, now: number): string {
	const sec = Math.max(0, Math.floor((now - r.createdAt) / 1000));
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	if (m < 60) return `${m}m${sec % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m${sec % 60}s`;
}

/** 决策队列分区:decision(等父行动)与 working(仅信息)。exited 只剩 collect,归入 decision。 */
type Section = "decision" | "working";

/** 可见宽:中文等全角字符计 2 列(overlay 定宽列对齐用)。 */
function colWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
	return w;
}

function padCol(s: string, width: number): string {
	const pad = width - colWidth(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}

function padStartCol(s: string, width: number): string {
	const pad = width - colWidth(s);
	return pad > 0 ? " ".repeat(pad) + s : s;
}

/** 状态 → 主行图标与语义色(图标家族与 footer/callback 同源)。 */
/** 状态面单一来源:每态一行——rank(status/overlay 排序)、decision(决策区成员)、
 * mark(图标/行色)、两个动作投影(toolActions=RPC 机器契约;paneActions=overlay UI 文案)。
 * 合法性以状态机 requireState 为准,本表是投影不是政策;漂移由 present.test 的
 * 「facet 与 FSM 合法集一致」红测试守门(非法提供与合法遗漏双向,即 #2 类 bug)。
 * 政策注记:idle 的 kill 虽 FSM 合法,两个投影都不推——idle 终局动作是带判决的
 * collect,无判决撤换不占用父的注意力;终态 done/killing 无投影(调用方过滤)。 */
export interface StateFacet {
	rank: number;
	decision: boolean;
	mark?: { icon: string; color: LineColor };
	toolActions: string;
	paneActions: WorkerAction[];
}

export const STATE_FACETS: Record<WorkerState, StateFacet> = {
	failed: {
		rank: 0,
		decision: true,
		mark: { icon: "✗", color: "error" },
		toolActions: "collect(clear, then redispatch per attribution)",
		paneActions: [
			{ value: "撤换", label: "撤换", description: "归因分流处置(collect 清账后重派或收尾),注入父 session 执行" },
		],
	},
	idle: {
		rank: 1,
		decision: true,
		mark: { icon: "✓", color: "success" },
		toolActions: "send|collect(verdict=通过|丢弃|强制放行)",
		paneActions: [
			{ value: "通过", label: "通过", description: "验收通过,收尾" },
			{ value: "消息", label: "消息", description: "发消息触发新轮(打回/追加轮次)", needsInput: true, inputPrompt: "消息内容:" },
			{ value: "丢弃", label: "丢弃" },
			{ value: "强制放行", label: "强制放行", needsInput: true, inputPrompt: "放行理由:" },
		],
	},
	exited: {
		rank: 2,
		decision: true,
		mark: { icon: "⏾", color: "warning" },
		// 报告已交(报告先于进程死),判决不因进程死失效——与 idle 同款判决集
		toolActions: "send(cold-resume)|collect(verdict=通过|丢弃|强制放行)",
		paneActions: [
			{ value: "通过", label: "通过", description: "验收通过,收尾" },
			{ value: "消息", label: "消息", description: "冷恢复续接(--session 同文件,历史完整;消息即新轮指令)", needsInput: true, inputPrompt: "消息内容:" },
			{ value: "丢弃", label: "丢弃" },
			{ value: "强制放行", label: "强制放行", needsInput: true, inputPrompt: "放行理由:" },
		],
	},
	running: {
		rank: 3,
		decision: false,
		mark: { icon: "●", color: "dim" },
		toolActions: "send|stop|kill",
		paneActions: [
			{ value: "消息", label: "消息", description: "注入干预,turn 边界生效", needsInput: true, inputPrompt: "消息内容:" },
			{ value: "stop", label: "stop", description: "立即停止新工作,只收尾呈报" },
			{ value: "kill", label: "kill", description: "撤换", irreversible: true },
		],
	},
	starting: {
		rank: 3,
		decision: false,
		mark: { icon: "●", color: "dim" },
		toolActions: "kill",
		paneActions: [{ value: "kill", label: "kill", description: "撤换", irreversible: true }],
	},
	stopping: {
		rank: 3,
		decision: false,
		mark: { icon: "●", color: "dim" },
		toolActions: "kill",
		paneActions: [{ value: "kill", label: "kill", description: "撤换", irreversible: true }],
	},
	done: { rank: 4, decision: false, toolActions: "", paneActions: [] },
	killing: { rank: 4, decision: false, toolActions: "", paneActions: [] },
};

function markOf(r: WorkerRecord): { icon: string; color: LineColor; section: Section; order: number } {
	const f = STATE_FACETS[r.state];
	// fail fast:新增状态须在 STATE_FACETS 登记(调用方过滤保证 done/killing 不可达)
	if (!f?.mark) throw new WorkerError(`overlay 未投影的状态: ${r.state};在 STATE_FACETS 登记或加入过滤`);
	return { ...f.mark, section: f.decision ? "decision" : "working", order: f.rank };
}

/**
 * 决策队列投影(分区即治理):decision 区(failed>idle>exited)在前,
 * working 区在后;区内按创建序。终态(done/killing)不列出。
 * 单行主行定宽列(图标+name+runtime右对齐+tN,可扫读);判决证据(failed 诊断/
 * idle 呈报封顶 8 行)>模型>活动/cost 收进 details,渲染层固定底部预览窗格
 * (选中行)。渲染不截断。
 */
export type LineColor = "accent" | "dim" | "warning" | "success" | "error" | "muted";

export interface OverlayLine {
	text: string;
	color: LineColor;
}

export interface OverlayRow {
	value: string;
	section: Section;
	main: OverlayLine;
	/** 选中行才渲染的补充行(判决证据:failed 诊断 / 呈报前 3 行) */
	details: OverlayLine[];
}

/** exited 聚合折叠行的伪 value(>2 时折叠,enter 展开);pane 据此拦截 enter 与 transcript 重定向。 */
export const EXITED_FOLD_ID = "__exited_fold__";

/** 主行活动短摘要:剥 tool: 前缀、单行化、30 字符截断(参数全文在 transcript 区)。 */
function activityShort(activity: string): string {
	const s = activity.replace(/^tool: /, "").replace(/\s+/g, " ").trim();
	return s.length > 30 ? `${s.slice(0, 30)}…` : s;
}

/** 主行任务摘要短形式:40 字符截断(全文在 transcript 区)。 */
function taskShort(s: string): string {
	return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

export function formatOverlayRows(
	records: WorkerRecord[],
	now: number,
	opts?: { expandExited?: boolean; providerNameFor?: (id: string) => string | undefined },
): OverlayRow[] {
	const live = records.filter((r) => r.state !== "done" && r.state !== "killing");
	const sorted = [...live].sort((a, b) => {
		const ma = markOf(a);
		const mb = markOf(b);
		return ma.order - mb.order || a.createdAt - b.createdAt;
	});
	// exited >2 折叠为一行(死记录是低价值噪音;决策点 failed/idle 不折叠——显式化优先)
	const foldExited = !opts?.expandExited && sorted.filter((r) => r.state === "exited").length > 2;
	const visible = foldExited ? sorted.filter((r) => r.state !== "exited") : sorted;
	// 定宽列(可扫读):name / runtime(右对齐);列宽按行集最大可见宽,
	// 纯函数内计算,渲染层不截断。
	const nameW = Math.max(...visible.map((r) => colWidth(r.name)));
	const timeW = Math.max(...visible.map((r) => colWidth(formatRuntime(r, now))));
	const rows = visible.map((r) => {
		const mark = markOf(r);
		// 颜色脉冲:running/starting 偶数秒 accent 奇数秒 dim(grok animated bullet 对等,
		// 词汇静态颜色呼吸);stopping 恒 warning(告警不脉冲)
		let color = mark.color;
		if (r.state === "stopping") color = "warning";
		else if (r.state === "running" || r.state === "starting") color = pulseBright(now) ? "accent" : "dim";
		const cols = [padCol(r.name, nameW), padStartCol(formatRuntime(r, now), timeW), `t${r.turns}`];
		// 行=任务卡:任务摘要进主行(不选中可扫读);旧记录无摘要不加料
		const working = r.state === "running" || r.state === "starting" || r.state === "stopping";
		const bits = [cols.join(" ")];
		if (r.taskSummary) bits.push(taskShort(r.taskSummary));
		if (working) {
			if (r.currentActivity) bits.push(activityShort(r.currentActivity));
			// 瞬态提示:starting 握手期(30s 静默窗可读);stopping 倒计时上限(硬兑底时限,数据源 stopStartedAt)
			if (r.state === "starting") bits.push("握手中");
			else if (r.state === "stopping" && r.stopStartedAt !== undefined) {
				const remain = Math.max(0, Math.ceil((r.stopStartedAt + STOP_DEADLINE_MS - now) / 1000));
				bits.push(`收尾中≤${remain}s`);
			}
		}
		// 模型/think 徽章进主行(不选中可扫读;选中的 transcript 标题栏仍有完整徽章)
		const model = formatModelInfo(r, opts?.providerNameFor?.(r.id));
		if (model) bits.push(model);
		const main = `${mark.icon} ${bits.join(" · ")}`;
		// 非正常收尾诊断:length(截断)/aborted(中断)进主行,父一眼可见
		const mainDiag = !working && r.stopReason && r.stopReason !== "stop" ? ` · stop:${r.stopReason}` : "";
		const details: OverlayLine[] = [];
		// 判决证据拆封:failed 带退出诊断,idle 带呈报前 3 行;全文在 transcript 视图(L2)
		if (r.state === "failed") {
			const diag = [`exit=${r.exitCode ?? r.exitSignal ?? "?"}`];
			if (r.stderrTail) diag.push(r.stderrTail);
			details.push({ text: diag.join(" · "), color: "error" });
		}
		if (r.report) {
			const lines = r.report.split("\n");
			const cap = 3;
			for (const line of lines.slice(0, cap)) details.push({ text: line, color: "muted" });
			if (lines.length > cap) details.push({ text: `…(+${lines.length - cap} 行,transcript 区看全文)`, color: "dim" });
		} else if (r.reportError) {
			// 呈报不可取/deliver 失败:诊断进 status,不静默空卡
			details.push({ text: r.reportError, color: "warning" });
		}
		return {
			value: r.id,
			section: mark.section,
			main: { text: main + mainDiag, color },
			details,
		};
	});
	if (foldExited) {
		const n = sorted.length - visible.length;
		// exited 原序位 = decision 区尾(working 区前)
		const idx = rows.findIndex((r) => r.section === "working");
		rows.splice(idx === -1 ? rows.length : idx, 0, {
			value: EXITED_FOLD_ID,
			section: "decision",
			main: { text: `⏾ exited ×${n} · 待 collect(enter 展开)`, color: "dim" },
			details: [],
		});
	}
	return rows;
}

// ---------- 判决消息(slice 3:注入父 session 的结构化文本) ----------

/** 机械动作(stop/kill/collect)审计消息:已直调,陈述式留痕。 */
export function formatActionMessage(id: string, action: string): string {
	return `已对 ${id} 执行 ${action}`;
}

// ---------- overlay 动作集(纯函数,可测) ----------

export interface WorkerAction {
	value: string;
	label: string;
	description?: string;
	needsInput?: boolean;
	inputPrompt?: string;
	/** 不可逆语义(机械 kill 直调,不可收回):动作层需二次确认;inject 类经父 agent 二次判断,不确认 */
	irreversible?: boolean;
}

/** 每子状态 → 合法动作集:STATE_FACETS 直读(与 FSM 合法集一致性由一致性测试守门)。
 * 返回共享表行,调用方不得改(pane 只读)。 */
export function actionsFor(rec: WorkerRecord): WorkerAction[] {
	return STATE_FACETS[rec.state].paneActions;
}

/** overlay 动作 → 执行操作:判决/撤换 = 机械收尾(collect 落记录+verdict)+ 注入指引
 * (frontmatter 落笔/归因分流归父 agent 判断);消息与机械动作直调 manager。
 * audit 为直调动作的陈述式留痕(落 session display,不唤醒父)。 */
export type ActionOp =
	| { kind: "stop" | "kill" | "collect"; audit: string }
	| { kind: "message"; message: string; audit: string }
	| { kind: "verdict"; verdict: CollectVerdict; audit: string; text: string }
	| { kind: "replacement"; audit: string; text: string };

/** 判决/特殊动作数据表:查表即出 ActionOp,无需 switch */
const VERDICT_TABLE: Record<string, { verdict: CollectVerdict; status: string; hint?: string }> = {
	通过: { verdict: "通过", status: "closed", hint: "按 Deliverable 契约" },
	丢弃: { verdict: "丢弃", status: "rejected" },
	强制放行: { verdict: "强制放行", status: "closed" },
};


export function opFor(action: WorkerAction, id: string, input?: string): ActionOp {
	// 判决:查表出 verdict + inject 文案
	const v = VERDICT_TABLE[action.value];
	if (v)
		return {
			kind: "verdict",
			verdict: v.verdict,
			audit: `已对 ${id} 判决「${action.value}」并收尾`,
			text:
				`对 ${id} 的「${action.value}」判决已执行(collect 完成,verdict=${v.verdict} 已落记录)` +
				(action.value === "强制放行" && input ? `(理由:${input})` : "") +
				`. ${v.hint ? v.hint + " 将" : "请将"} verdict=${v.verdict}、status=${v.status}` +
				(action.value === "强制放行" && input ? ` 连同理由` : "") +
				` 落相关 deliverable frontmatter${v.verdict === "通过" ? "(无对应 issue 豁免)" : ""}`,
		};
	// 消息:唯一需要 input 的动作
	if (action.value === "消息") {
		const msg = input ?? "";
		return { kind: "message", message: msg, audit: `已对 ${id} 发送 message:${msg}` };
	}
	// 撤换:清账 collect + 归因指引注入
	if (action.value === "撤换")
		return {
			kind: "replacement",
			audit: `已对 ${id} 撤换并清账`,
			text: `对 ${id} 已执行撤换并清账(collect 完成)。请按归因分流处置:重派或收尾`,
		};
	// 机械动作:stop/kill/collect → kind 与 action.value 同名
	if (action.value === "stop" || action.value === "kill" || action.value === "collect")
		return { kind: action.value, audit: formatActionMessage(id, action.value) };
	throw new WorkerError(`未知动作: ${action.value}`);
}

