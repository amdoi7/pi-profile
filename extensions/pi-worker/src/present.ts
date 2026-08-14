import type { CallbackMessage } from "./bridge.ts";
import { WorkerError, type WorkerRecord } from "./types.ts";

/**
 * UI 投影纯函数(主权界面:决策点显式化优先于进度投影)。无副作用,可单测。
 * 设计语言:静态状态词汇(✓✗⏾●,与 overlay STATE_MARKS 同表)、⏺ 动作、⎿ 续行;
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
		// 图标与 overlay STATE_MARKS 同词汇(静态);stopping 警示色(告警面)
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

	let failed = 0;
	let idle = 0;
	let exited = 0;
	for (const r of records) {
		if (r.state === "failed") failed++;
		else if (r.state === "idle") idle++;
		else if (r.state === "exited") exited++;
	}
	const decisionParts: string[] = [];
	if (failed > 0) decisionParts.push(fg("error", `✗ ${failed} failed`));
	if (idle > 0) decisionParts.push(fg("dim", `✓ ${idle} idle`));
	if (exited > 0) decisionParts.push(fg("warning", `⏾ ${exited} exited`));
	// 任一决策待办(失败归因/ idle 验收/ exited 清理)即给行动入口
	if (failed + idle + exited > 0) decisionParts.push(fg("dim", "/pi-worker"));
	const decisionZone = decisionParts.join(" · ");

	if (!workZone && !decisionZone) return undefined;
	if (workZone && decisionZone) return `${decisionZone} │ ${workZone}`;
	return workZone || decisionZone;
}

export interface CallbackView {
	kind: "settled" | "message" | "failed" | "recovery" | "action";
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
	if (d.type === "recovery") {
		// 启动恢复:遗留 worker 待审计/清理是决策项(warning 级),非机械留痕
		return {
			kind: "recovery",
			header: `⏺ 启动恢复`,
			body: String(msg.content ?? ""),
			bodyIsMarkdown: false,
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
	params: { id?: string; name?: string; prompt?: string; model?: string; thinking?: string; tools?: string },
): string {
	const target = params.name || (params.id ? displayNameOf(params.id) : "");
	const parts = [action];
	if (target) parts.push(target);
	if (action === "run") {
		if (params.prompt?.trim()) parts.push(quotedParam(params.prompt));
		if (params.tools?.trim()) parts.push(`· tools:${params.tools.trim()}`);
		if (params.model?.trim()) {
			parts.push(`· ${params.model.trim()}${params.thinking?.trim() ? ` think:${params.thinking.trim()}` : ""}`);
		} else if (params.thinking?.trim()) {
			parts.push(`· think:${params.thinking.trim()}`);
		}
	} else if (action === "message" && params.prompt?.trim()) {
		parts.push(quotedParam(params.prompt));
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
const STATE_MARKS: Record<string, { icon: string; color: LineColor; section: Section; order: number }> = {
	failed: { icon: "✗", color: "error", section: "decision", order: 0 },
	idle: { icon: "✓", color: "success", section: "decision", order: 1 },
	exited: { icon: "⏾", color: "warning", section: "decision", order: 2 },
	running: { icon: "●", color: "dim", section: "working", order: 3 },
	starting: { icon: "●", color: "dim", section: "working", order: 3 },
	stopping: { icon: "●", color: "dim", section: "working", order: 3 },
};

function markOf(r: WorkerRecord): { icon: string; color: LineColor; section: Section; order: number } {
	const m = STATE_MARKS[r.state];
	// fail fast:新增状态须在 STATE_MARKS 登记(调用方过滤保证 done/killing 不可达)
	if (!m) throw new WorkerError(`overlay 未投影的状态: ${r.state};在 STATE_MARKS 登记或加入过滤`);
	return m;
}

/**
 * recent 条目 → status 可读行(tool call 面向父 LLM:去 TUI 装饰,参数高保真)。
 * start:提取常见参数键(command/path/file)作摘要;end 标 ✓(完成态是审计信号);
 * JSON 解析失败回退剥壳文本。
 */
export function formatRecentEntry(entry: string): string {
	if (entry.startsWith("start:")) {
		const [tool, ...argsRest] = entry.slice(6).split(" ");
		const args = argsRest.join(" ");
		const line = args ? `${tool}: ${args}` : tool;
		return line.length > 60 ? `${line.slice(0, 60)}…` : line;
	}
	if (entry.startsWith("end:")) return `${entry.slice(4)} ✓`;
	if (entry === "turn_end") return "turn_end";
	return entry.length > 60 ? `${entry.slice(0, 60)}…` : entry;
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
	/** 选中行才渲染的补充行(判决证据:遗留标记 / failed 诊断 / 呈报前 3 行) */
	details: OverlayLine[];
}

/** exited 聚合折叠行的伪 value(>2 时折叠,enter 展开);pane 据此拦截 enter 与 transcript 重定向。 */
export const EXITED_FOLD_ID = "__exited_fold__";

/** 主行活动短摘要:剥 tool: 前缀、单行化、30 字符截断(参数全文在 transcript 区)。 */
function activityShort(activity: string): string {
	const s = activity.replace(/^tool: /, "").replace(/\s+/g, " ").trim();
	return s.length > 30 ? `${s.slice(0, 30)}…` : s;
}

export function formatOverlayRows(
	records: WorkerRecord[],
	now: number,
	opts?: { expandExited?: boolean },
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
		// 行单行化:working 态主行带活动短摘要;模型/cost 徽章在 transcript 标题栏
		const working = r.state === "running" || r.state === "starting" || r.state === "stopping";
		const main = `${mark.icon} ${cols.join(" ")}${working && r.currentActivity ? ` · ${activityShort(r.currentActivity)}` : ""}`;
		const details: OverlayLine[] = [];
		// 遗留记录(exited × recovered 显式状态组合):来源与审计指针带出
		if (r.recovered) {
			details.push({ text: "重启遗留:最后状态未知,以 jsonl 为准", color: "warning" });
			if (r.sessionFile) details.push({ text: r.sessionFile, color: "dim" });
		}
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
		}
		return {
			value: r.id,
			section: mark.section,
			main: { text: main, color },
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

/** 每子状态 → 合法动作集(与状态机合法集一致,不给非法 action)。 */
export function actionsFor(rec: WorkerRecord): WorkerAction[] {
	if (rec.state === "idle") {
		return [
			{ value: "通过", label: "通过", description: "验收通过,收尾" },
			{ value: "消息", label: "消息", description: "发消息触发新轮(打回/追加轮次)", needsInput: true, inputPrompt: "消息内容:" },
			{ value: "丢弃", label: "丢弃" },
			{ value: "强制放行", label: "强制放行", needsInput: true, inputPrompt: "放行理由:" },
		];
	}
	if (rec.state === "failed") {
		return [
			{ value: "撤换", label: "撤换", description: "归因分流处置(collect 清账后重派或收尾),注入父 session 执行" },
		];
	}
	if (rec.state === "running") {
		return [
			{ value: "消息", label: "消息", description: "注入干预,turn 边界生效", needsInput: true, inputPrompt: "消息内容:" },
			{ value: "stop", label: "stop", description: "立即停止新工作,只收尾呈报" },
			{ value: "kill", label: "kill", description: "撤换", irreversible: true },
		];
	}
	if (rec.state === "stopping") {
		return [{ value: "kill", label: "kill", description: "撤换", irreversible: true }];
	}
	if (rec.state === "starting") {
		return [{ value: "kill", label: "kill", description: "撤换", irreversible: true }];
	}
	if (rec.state === "exited") {
		return [{ value: "collect", label: "collect", description: "收尾清理" }];
	}
	return [];
}

/** overlay 动作 → 执行操作:判决与归因注入父 session(落 verdict frontmatter/修合约
 * 是 agent 判断);消息与机械动作直调 manager。audit 为直调动作的陈述式留痕
 * (落 session display,不唤醒父)。 */
export type ActionOp =
	| { kind: "stop" | "kill" | "collect"; audit: string }
	| { kind: "message"; message: string; audit: string }
	| { kind: "inject"; text: string };

export function opFor(action: WorkerAction, id: string, input?: string): ActionOp {
	switch (action.value) {
		case "通过":
			// 判决注入父 session:verdict 落 deliverable frontmatter 是审查闭环事实源,需 agent 判断与落笔
			return {
				kind: "inject",
				text: `对 ${id} 判决「通过」:按 Deliverable 契约将 verdict=通过、status=closed 落相关 deliverable frontmatter(无对应 issue 豁免),然后 pi_worker collect id=${id} verdict=通过`,
			};
		case "强制放行":
			return {
				kind: "inject",
				text: `对 ${id} 判决「强制放行」${input ? `(理由:${input})` : ""}:将 verdict=强制放行、status=closed 连同理由落相关 deliverable frontmatter,然后 pi_worker collect id=${id} verdict=强制放行`,
			};
		case "丢弃":
			return {
				kind: "inject",
				text: `对 ${id} 判决「丢弃」:将 verdict=丢弃、status=rejected 落相关 deliverable frontmatter,然后 pi_worker collect id=${id} verdict=丢弃`,
			};
		case "消息":
			return { kind: "message", message: input ?? "", audit: `已对 ${id} 发送 message:${input ?? ""}` };
		case "stop":
		case "kill":
		case "collect":
			return { kind: action.value, audit: formatActionMessage(id, action.value) };
		case "撤换":
			// 归因分类是父 agent 判断(AGENTS.md 归因分流),菜单不替父分类
			return {
				kind: "inject",
				text: `对 ${id} 撤换:请执行 pi_worker collect id=${id} 清账,按归因分流处置`,
			};
		default:
			throw new WorkerError(`未知动作: ${action.value}`);
	}
}

// ---------- transcript 生命周期 block(scrollback 原位更新投影) ----------

/** appendEntry 的数据契约:记录消失(collect)后静态回退渲染所需的最小集。 */
export interface LifecycleEntryData {
	id: string;
	name: string;
	prompt: string;
	createdAt: number;
}

export interface LifecycleView {
	icon: string;
	iconColor: LineColor;
	/** 主行文本(不含图标);色彩恒 dim——语义色由图标承载,正文退后 */
	text: string;
	textColor: LineColor;
	/** expanded(ctrl+o)补充行 */
	details: OverlayLine[];
}

const LIFECYCLE_ACTIVITY_MAX = 30;

/** 活动标签:剥 tool: 前缀、压平空白、截断 30(grok "Running: X" 词汇对等物,工具名+参数)。 */
function lifecycleActivity(activity: string): string {
	const s = activity.replace(/^tool: /, "").replace(/\s+/g, " ").trim();
	return s.length > LIFECYCLE_ACTIVITY_MAX ? `${s.slice(0, LIFECYCLE_ACTIVITY_MAX - 1)}…` : s;
}

/** prompt 单行引号化(复用 renderCall 的 40 字符截断,transcript 内视觉同源)。 */
function quotedPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine ? quotedParam(oneLine) : "";
}

/**
 * 生命周期 block 投影:grok subagent scrollback block 对等物。
 * 色彩纪律:工作态图标 accent/warning(进行中是唯一需要抓取注意力的状态);
 * 非工作态整体 dim——终态色彩由紧随的回调消息(settled 呈报/failed 诊断)承载,
 * block 退后为留痕。rec 缺失(collect 后)回退 entry data 静态渲染。
 */
export function formatLifecycle(rec: WorkerRecord | undefined, data: LifecycleEntryData, now: number): LifecycleView {
	const quoted = quotedPrompt(data.prompt);
	if (!rec) {
		return {
			icon: "●",
			iconColor: "dim",
			text: [data.name, quoted].filter(Boolean).join(" "),
			textColor: "dim",
			details: data.prompt.split("\n").map((t) => ({ text: t, color: "muted" as const })),
		};
	}
	const head = [rec.name, quoted].filter(Boolean).join(" ");
	const elapsed = formatRuntime(rec, now);
	let icon = "●";
	let iconColor: LineColor = "dim";
	const extras: string[] = [];
	switch (rec.state) {
		case "starting":
		case "running":
			iconColor = pulseBright(now) ? "accent" : "dim";
			if (rec.currentActivity) extras.push(lifecycleActivity(rec.currentActivity));
			break;
		case "stopping":
		case "killing":
			iconColor = "warning";
			if (rec.currentActivity) extras.push(lifecycleActivity(rec.currentActivity));
			break;
		case "idle":
			icon = "✓";
			break;
		case "failed":
			icon = "✗";
			extras.push(`exit=${rec.exitCode ?? rec.exitSignal ?? "?"}`);
			break;
		case "exited":
			icon = "⏾";
			break;
		case "done":
			if (rec.verdict) extras.push(rec.verdict);
			break;
	}
	const text = `${head} · ${elapsed}${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}`;
	const details: OverlayLine[] = [];
	if (rec.recovered) {
		details.push({ text: "重启遗留:最后状态未知,以 jsonl 为准", color: "warning" });
	}
	const model = formatModelInfo(rec);
	if (model) details.push({ text: model, color: "dim" });
	if (rec.sessionFile) details.push({ text: rec.sessionFile, color: "dim" });
	for (const e of rec.recent.slice(-4)) details.push({ text: formatRecentEntry(e), color: "dim" });
	return { icon, iconColor, text, textColor: "dim", details };
}

/**
 * 本会话归属判定:branch 文本(JSON.stringify(session entries))里出现该 worker
 * id(run 工具调用留痕)= 本会话遗留;未引用 = 其他父 session 的遗留。
 */
export function splitLeftoversByReference<T extends { id: string }>(
	sessions: T[],
	branchText: string,
): { own: T[]; foreign: T[] } {
	const own: T[] = [];
	const foreign: T[] = [];
	for (const s of sessions) (branchText.includes(s.id) ? own : foreign).push(s);
	return { own, foreign };
}

/**
 * 启动检测提示:显示遗留但不自动认领(认领是显式动作 pi_worker action=recover,
 * 且只认领本会话的;外会话遗留直接新会话查看)。仅在可认领/外会话/可跳过时产出;
 * held-only 不打扰(活窗口自己管理)。
 */
export function formatLeftoverHint(
	scan: { sessions: { id: string; sessionFile: string }[]; skipped: string[]; heldElsewhere: string[] },
	branchText: string,
): string | undefined {
	const { own, foreign } = splitLeftoversByReference(scan.sessions, branchText);
	if (own.length === 0 && foreign.length === 0 && scan.skipped.length === 0) return undefined;
	const parts: string[] = [];
	if (own.length > 0) {
		parts.push(
			`本会话遗留 ${own.length} 个 worker(未自动认领):${own.map((s) => s.id).join(", ")};pi_worker action=recover 认领审计`,
		);
	}
	if (foreign.length > 0) {
		parts.push(
			`非本会话遗留 ${foreign.length} 个 worker(不建记录;直接新会话查看):` +
				foreign.map((s) => `${s.id} → pi --session ${s.sessionFile}(查看/续接) 或 pi --fork ${s.sessionFile}(新会话)`).join("; ") +
				`;确认无用可删文件清理`,
		);
	}
	if (scan.skipped.length > 0) parts.push(`跳过不可解析文件: ${scan.skipped.join(", ")}`);
	if (scan.heldElsewhere.length > 0) parts.push(`另有 ${scan.heldElsewhere.length} 个由其他活窗口持有: ${scan.heldElsewhere.join(", ")}`);
	return parts.join(";");
}
