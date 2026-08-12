import type { CallbackMessage } from "./bridge.ts";
import { WorkerError, type WorkerRecord } from "./types.ts";

/**
 * UI 投影纯函数(主权界面:决策点显式化优先于进度投影)。无副作用,可单测。
 * 设计语言:单一 glyph 家族——三态帧族 spinner、⏺ 动作、⎿ 续行、✓✗⚑⏾ 状态;
 * 语义靠颜色(accent/warning/error/dim),不靠生造字形;
 * footer 双区(工作区 │ 决策区);role 不进显示层(dispatch 参数,非显示维度)。
 */

const WORKING_STATES = new Set(["starting", "running", "stopping"]);

/**
 * 三态帧族(等宽约束:全部 1 列/帧,铸约 3 字符帧由 footer 3 列槽承载——
 * 宽度漂移是八卦系 U+2631-2635 弃用的原因):
 * - starting:⦗◦⦘→⦗☯⦘→⦗⊚⦘→⦗⧇⦘ 慢呼吸(2s/帧);
 * - running:⧓→⧔→⧕→⧖(1s/帧);
 * - stopping:⧈→⧇→╳→·(1s/帧)。
 */
const SPINNER_BY_STATE: Record<string, { frames: string[]; frameMs: number }> = {
	starting: { frames: ["⦗◦⦘", "⦗☯⦘", "⦗⊚⦘", "⦗⧇⦘"], frameMs: 2000 },
	running: { frames: ["⧓", "⧔", "⧕", "⧖"], frameMs: 1000 },
	stopping: { frames: ["⧈", "⧇", "╳", "·"], frameMs: 1000 },
};

/** 按 worker 状态取当前帧(无匹配回退 running)。 */
function spinnerFor(state: string, now: number): string {
	const s = SPINNER_BY_STATE[state] ?? SPINNER_BY_STATE.running;
	return s.frames[Math.floor(now / s.frameMs) % s.frames.length];
}

/** 帧槽:starting 3 字符帧 / running·stopping 1 字符帧统一到 3 列,footer 无宽度漂移。 */
function spinnerSlot(state: string, now: number): string {
	return spinnerFor(state, now).padEnd(3);
}

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
	const m = id.match(/^pi-worker-(.+)#[0-9a-f]{6}$/);
	return m ? m[1] : id;
}

export interface FooterOptions {
	/** elapsed 与 spinner 帧的时钟源 */
	now: number;
	/** 语义色注入(默认无色,测试友好) */
	fg?: Fg;
}

/**
 * Footer 投影:回答"系统在忙吗?有决策在等我吗?"。
 * 工作区:单 worker(spinner+name+工具名心跳+elapsed),多 worker 聚合
 * (最早创建者具名 +N、Σtok);决策区按严重度 ✗failed>✓done>⏾exited
 * 计数。终态(done/failed 之外)与瞬态(killing)不投影;无内容 → undefined。
 */
export function formatFooter(records: WorkerRecord[], opts: FooterOptions): string | undefined {
	const fg = opts.fg ?? plainFg;
	const working = records
		.filter((r) => WORKING_STATES.has(r.state))
		.sort((a, b) => a.createdAt - b.createdAt);

	let workZone = "";
	if (working.length === 1) {
		const r = working[0];
		// 帧随状态选族,3 列固定槽防宽度漂移;stopping 警示色
		const spinner = fg(r.state === "stopping" ? "warning" : "accent", spinnerSlot(r.state, opts.now));
		const parts = [spinner, r.name];
		const activity = footerActivity(r.currentActivity);
		if (activity) parts.push(activity);
		parts.push(formatRuntime(r, opts.now));
		workZone = parts.join(" · ").replace(" · ", " "); // spinner 后是空格不是 ·
	} else if (working.length > 1) {
		// 高可信聚合:代表名(最早创建)+ 运行时长 + Σtok;turns 是内部计数,决策价值低于耗时
		const tokens = working.reduce((s, r) => {
			const t = extractTokens(latestStats(r));
			return s + (typeof t === "number" && Number.isFinite(t) ? t : 0);
		}, 0);
		const parts = [
			`${spinnerSlot(working[0].state, opts.now)} ${working[0].name} +${working.length - 1}`,
			formatRuntime(working[0], opts.now),
		];
		if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
		workZone = parts.join(" · ");
	}

	let failed = 0;
	let done = 0;
	let exited = 0;
	for (const r of records) {
		if (r.state === "failed") failed++;
		else if (r.state === "idle") done++;
		else if (r.state === "exited") exited++;
	}
	const decisionParts: string[] = [];
	if (failed > 0) decisionParts.push(fg("error", `✗ ${failed} failed`));
	if (done > 0) decisionParts.push(fg("dim", `✓ ${done} done`));
	if (exited > 0) decisionParts.push(fg("warning", `⏾ ${exited} exited`));
	// 有决策待办时给行动入口(status item click-through 的 TUI 等价物)
	if (failed > 0) decisionParts.push(fg("dim", "/pi-worker"));
	const decisionZone = decisionParts.join(" · ");

	if (!workZone && !decisionZone) return undefined;
	if (workZone && decisionZone) return `${workZone} │ ${decisionZone}`;
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
	params: { id?: string; name?: string; task?: string; message?: string; model?: string; thinking?: string },
): string {
	const target = params.name || (params.id ? displayNameOf(params.id) : "");
	const parts = [action];
	if (target) parts.push(target);
	if (action === "run") {
		if (params.task?.trim()) parts.push(quotedParam(params.task));
		if (params.model?.trim()) {
			parts.push(`· ${params.model.trim()}${params.thinking?.trim() ? ` think:${params.thinking.trim()}` : ""}`);
		} else if (params.thinking?.trim()) {
			parts.push(`· think:${params.thinking.trim()}`);
		}
	} else if (action === "message" && params.message?.trim()) {
		parts.push(quotedParam(params.message));
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
	return STATE_MARKS[r.state];
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
 * 单行主行定宽列(图标+name+runtime右对齐+tN,可扫读);模型/活动/cost
 * 收进 details,渲染层固定底部预览窗格(选中行)。渲染不截断。
 * role 不进显示层:name 即身份,角色是 dispatch 参数。
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
	/** 选中行才渲染的补充行(模型 / 活动·cost) */
	details: OverlayLine[];
}

export function formatOverlayRows(
	records: WorkerRecord[],
	now: number,
	providerNameFor?: (id: string) => string | undefined,
): OverlayRow[] {
	const live = records.filter((r) => r.state !== "done" && r.state !== "killing");
	const sorted = [...live].sort((a, b) => {
		const ma = markOf(a);
		const mb = markOf(b);
		return ma.order - mb.order || a.createdAt - b.createdAt;
	});
	// 定宽列(可扫读):name / runtime(右对齐);列宽按行集最大可见宽,
	// 纯函数内计算,渲染层不截断。
	const nameW = Math.max(...sorted.map((r) => colWidth(r.name)));
	const timeW = Math.max(...sorted.map((r) => colWidth(formatRuntime(r, now))));
	return sorted.map((r) => {
		const mark = markOf(r);
		const cols = [padCol(r.name, nameW), padStartCol(formatRuntime(r, now), timeW), `t${r.turns}`];
		const main = `${mark.icon} ${cols.join(" ")}`;
		const details: OverlayLine[] = [];
		const model = formatModelInfo(r, providerNameFor?.(r.id));
		if (model) details.push({ text: model, color: "dim" });
		const stats = latestStats(r);
		const extraBits: string[] = [];
		if (r.currentActivity) extraBits.push(r.currentActivity);
		const cost = extractCost(stats);
		if (cost !== undefined) extraBits.push(`cost $${cost}`);
		if (extraBits.length > 0) details.push({ text: extraBits.join(" · "), color: "dim" });
		return {
			value: r.id,
			section: mark.section,
			main: { text: main, color: mark.color },
			details,
		};
	});
}

// ---------- 判决消息(slice 3:注入父 session 的结构化文本) ----------

/** 撤换归因四路:failed/kill 后清账(collect) + 重派引导。
 * 唯一保留 LLM 注入的动作:修合约/重派是真判断,不是查表。 */
export function formatAttributionMessage(
	id: string,
	path: "输入" | "能力" | "胜任度" | "收益递减",
	detail?: string,
): string {
	const next: Record<string, string> = {
		输入: "修合约后同 name 重派",
		能力: "同 name 带 model/thinking 重派",
		胜任度: "换 name 重派",
		收益递减: "父收尾不重派",
	};
	return `对 ${id} 撤换归因:${path}${detail ? `,${detail}` : ""} → 请执行 pi_worker collect id=${id},${next[path]}`;
}

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
	/** 不可逆语义(丢弃/强制放行):动作层需二次确认 */
	irreversible?: boolean;
}

/** 每子状态 → 合法动作集(与状态机合法集一致,不给非法 action)。 */
export function actionsFor(rec: WorkerRecord): WorkerAction[] {
	if (rec.state === "idle") {
		return [
			{ value: "通过", label: "通过", description: "验收通过,收尾" },
			{ value: "消息", label: "消息", description: "发消息触发新轮(打回/追加轮次)", needsInput: true, inputPrompt: "消息内容:" },
			{ value: "丢弃", label: "丢弃", irreversible: true },
			{ value: "强制放行", label: "强制放行", needsInput: true, inputPrompt: "放行理由:", irreversible: true },
		];
	}
	if (rec.state === "failed") {
		return [
			{ value: "归因:输入", label: "归因:输入", description: "修合约同 name 重派", irreversible: true },
			{ value: "归因:能力", label: "归因:能力", description: "同 name 带 model/thinking 重派", irreversible: true },
			{ value: "归因:胜任度", label: "归因:胜任度", description: "换 name", irreversible: true },
			{ value: "归因:收益递减", label: "归因:收益递减", description: "父 agent 收尾", irreversible: true },
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

/** overlay 动作 → 执行操作:判决到人即终局,直调 manager(无 LLM 中转);
 * 仅归因四路保留注入(修合约/重派需要父 agent 判断)。audit 为直调动作的
 * 陈述式留痕(落 session display,不唤醒父)。 */
export type ActionOp =
	| { kind: "stop" | "kill" | "collect"; audit: string }
	| { kind: "message"; message: string; audit: string }
	| { kind: "inject"; text: string };

export function opFor(action: WorkerAction, id: string, input?: string): ActionOp {
	switch (action.value) {
		case "通过":
			return { kind: "collect", audit: `已对 ${id} 验收通过(collect)` };
		case "强制放行":
			return { kind: "collect", audit: `已对 ${id} 强制放行(collect)${input ? `,理由:${input}` : ""}` };
		case "丢弃":
			return { kind: "kill", audit: `已对 ${id} 丢弃(kill)` };
		case "消息":
			return { kind: "message", message: input ?? "", audit: `已对 ${id} 发送 message:${input ?? ""}` };
		case "stop":
		case "kill":
		case "collect":
			return { kind: action.value, audit: formatActionMessage(id, action.value) };
		default:
			if (action.value.startsWith("归因:")) {
				const path = action.value.slice(3) as "输入" | "能力" | "胜任度" | "收益递减";
				return { kind: "inject", text: formatAttributionMessage(id, path) };
			}
			throw new WorkerError(`未知动作: ${action.value}`);
	}
}
