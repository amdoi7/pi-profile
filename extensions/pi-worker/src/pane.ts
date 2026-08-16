import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkerManager } from "./manager.ts";
import {
	actionsFor,
	displayNameOf,
	EXITED_FOLD_ID,
	formatOverlayRows,
	formatPaneStats,
	formatRuntime,
	opFor,
	type FooterColor,
	type OverlayRow,
	type WorkerAction,
} from "./present.ts";
import { TranscriptZone, transcriptTitle } from "./transcript.ts";
import { WorkerError } from "./state-machine.ts";
import type { SessionEntry, WorkerRecord } from "./types.ts";

/**
 * worker 合并窗口(终局单窗口):grok tasks pane + framed 子视图的合并形态。
 * 上 = 决策队列(每行即 worker 的交互代表);选中行的判决证据在 list 下方的
 * 预览条带(只对选中行展开);下 = 选中 worker 的 live transcript,高度按内容
 * 分配(空/短 transcript 不独占窗口)。
 * 交互:list 焦点下 ↑↓ 恒在 list 选择(transcript 自动跟随),PgUp/PgDn 直接翻看
 * transcript(不改变选中);空格显式进入 history 焦点(借鉴 grok build 详情区:
 * ↑↓ 消息粒度移动、transcript 唯一光标),space/esc 返回;enter 动作流;esc 分层退出
 * (动作流 → 关窗)。光标:list 焦点 = 选中行恒 → + selectedBg 整行高亮;history 焦点
 * = 锚点行 → 前缀(列表光标让位)。段头是纯分区标签,不可选中——↑↓ 跳过。
 * 动作语义:判决/撤换 = 机械收尾(collect 立即生效)+ 指引注入父 session;
 * 消息/机械直调 manager,不可逆二次确认。任何动作不关窗(esc 才关,批量连续操作)。
 */

/** 合并窗口布局:居中宽窗(transcript 需要宽度);窄终端 95% 回退;
 * 超宽终端宽度封顶 ≈160 列(行不过长,居中留白)。 */
export function paneOverlayOptions(cols: number, _rows: number): Record<string, unknown> {
	if (cols < 100) return { anchor: "center", width: "95%", maxHeight: "90%", margin: 0 };
	const width = Math.min(85, Math.round((160 / cols) * 100));
	return { anchor: "center", width: `${width}%`, maxHeight: "90%", margin: 0 };
}

interface PaneDeps {
	records: () => WorkerRecord[];
	providerNameFor: (id: string) => string | undefined;
	/** transcript 数据源(manager 持有:live 事件流+回填,dead 文件缓存);undefined → 缺失提示 */
	transcriptView: (id: string) => SessionEntry[] | undefined;
	theme: Theme;
	tui: { terminal: { rows: number; columns: number }; requestRender(): void };
	onClose: () => void;
	/** 执行动作;返回 true = 成功(输入草稿清空),false = 失败(草稿保留可重试) */
	execute: (action: WorkerAction, rec: WorkerRecord, input?: string) => Promise<boolean>;
}

type Stage = "list" | "actions" | "input" | "confirm";

/** 边框+标题+统计+hint 的固定预留;内容区高度 = 终端 90% - 该值。 */
const FRAME_LINES = 5;

/** 判决证据 preview 上限(固定):list 窗口高度稳定,不随选中行详情长度抖动。 */
const PREVIEW_MAX = 4;

/** 段头伪行的 value 前缀(value = 前缀 + section);pane 据此识别段头、导航跳过。 */
const SECTION_HEADER_PREFIX = "__section_header__";

/** 决策队列分区(与 present.ts 同构);段头伪行归属其段,供折叠集合索引。 */
type Section = "decision" | "working";

function sectionHeaderId(section: Section): string {
	return SECTION_HEADER_PREFIX + section;
}

function isSectionHeader(row: OverlayRow): boolean {
	return row.value.startsWith(SECTION_HEADER_PREFIX);
}

export class WorkerPaneComponent {
	private stage: Stage = "list";
	private rows: OverlayRow[] = [];
	/** refresh 时的记录快照:统计行与列表投影同源,1 tick 窗口内不出现计数/空态矛盾 */
	private snapshot: WorkerRecord[] = [];
	private selectedId: string | undefined;
	private actionSel = 0;
	private actions: WorkerAction[] = [];
	private currentAction: WorkerAction | undefined;
	private scrollTop = 0;
	/** transcript 区当前可视高度(render 时更新;PgUp/PgDn 翻页步长基准) */
	private transViewport = 0;
	private readonly transcript: TranscriptZone;
	private readonly input = new Input();
	/** exited 折叠行 enter 展开(窗口生命周期内保持,重开复位) */
	private expandExited = false;
	/** history 焦点(list 态空格进入):transcript 内消息粒度浏览,列表选中冻结 */
	private historyMode = false;

	constructor(private readonly deps: PaneDeps) {
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			if (this.currentAction) {
				void this.deps.execute(this.currentAction, this.selected()!, value).then((ok) => {
					// btw 草稿语义借鉴:提交成功清草稿(下次输入干净),失败保留(可编辑重试)
					if (ok) this.input.setValue("");
					this.stage = "list";
				});
			} else {
				this.stage = "list";
			}
		};
		this.input.onEscape = () => {
			this.stage = "actions";
		};
		this.refresh();
		this.transcript = new TranscriptZone({
			view: () => {
				const r = this.selected();
				return r ? deps.transcriptView(r.id) : undefined;
			},
			theme: deps.theme,
			state: () => this.selected()?.state,
		});
	}

	private selected(): WorkerRecord | undefined {
		return this.deps.records().find((r) => r.id === this.selectedId);
	}

	private selectedIndex(): number {
		return Math.max(0, this.rows.findIndex((r) => r.value === this.selectedId));
	}

	/** 重建投影(记录是活引用;选中按 id 保持,消失回落首行;段头/折叠过滤在此统一;transcript 跟随选中)。
	 * 快照与 rows 同一 records() 调用(浅拷贝防原地变更):统计行/列表/transcript 同源,
	 * 渲染间一致(1s tick 才换帧)。 */
	refresh(): void {
		const before = this.selectedId;
		this.snapshot = this.deps.records().map((r) => ({ ...r }));
		this.rows = this.withSectionHeaders(
			formatOverlayRows(this.snapshot, Date.now(), {
				expandExited: this.expandExited,
				providerNameFor: (id) => this.deps.providerNameFor(id),
			}),
		);
		// 选中有效性兜底:选中不可见(记录消失)即回落首个真实行(段头不抢占)
		if (!this.rows.some((r) => r.value === this.selectedId)) {
			this.selectedId = this.firstSelectableValue();
		}
		if (this.transcript && this.selectedId !== before) this.syncTranscript();
	}

	/** 段头注入:纯分区标签(待决策/工作中 + count),不可选中、不可折叠——
	 * 光标只落真实 worker(身份恒连续);exited 自动折叠(exited fold 行)除外。 */
	/** 段头注入:纯分区标签(待决策/工作中 + count),不可选中、不可折叠——
	 * 光标只落真实 worker(身份恒连续);分区结构恒在(空分区也给 (0) 段头,
	 * 补全隔离);exited 自动折叠(exited fold 行)除外。 */
	private withSectionHeaders(rows: OverlayRow[]): OverlayRow[] {
		if (rows.length === 0) return rows; // 空态由渲染层占位,不造空段头
		const counts = new Map<Section, number>();
		for (const r of rows) counts.set(r.section, (counts.get(r.section) ?? 0) + 1);
		const out: OverlayRow[] = [];
		for (const section of ["decision", "working"] as const) {
			const label = section === "decision" ? "待决策" : "工作中";
			out.push({
				value: sectionHeaderId(section),
				section,
				main: { text: `${label} (${counts.get(section) ?? 0})`, color: "dim" },
				details: [],
			});
			for (const row of rows) {
				if (row.section === section) out.push(row);
			}
		}
		return out;
	}

	/** 默认/兜底选中:首个真实行优先(段头伪行不抢占初始选中,transcript 区跟随真实 worker)。 */
	private firstSelectableValue(): string | undefined {
		return this.rows.find((r) => !isSectionHeader(r))?.value ?? this.rows[0]?.value;
	}

	/** ↑↓ 移动:跳过段头伪行,光标只落真实 worker(身份恒连续);环绕保留。 */
	private moveSelection(dir: -1 | 1): void {
		const i = this.selectedIndex();
		const n = this.rows.length;
		if (n === 0) return;
		for (let k = 1; k <= n; k++) {
			const j = (((i + dir * k) % n) + n) % n;
			const row = this.rows[j];
			if (!isSectionHeader(row)) {
				this.selectedId = row.value;
				this.syncTranscript();
				return;
			}
		}
	}

	/** transcript 跟随选中;折叠行是伪行,不抢占(保持上一真实选中)。 */
	private syncTranscript(): void {
		if (this.selected()) this.transcript.resetView();
	}

	get inputStage(): boolean {
		return this.stage === "input";
	}

	setInputFocused(v: boolean): void {
		this.input.focused = v;
	}

	/** 错误恢复:重建后回 list stage(状态过期时动作流不再有效)。 */
	toListStage(): void {
		this.stage = "list";
	}

	/** list 区内容行:list stage = 分区头 + 行 + 拆封 details;其余 stage = 动作流。
	 * 光标语义:选中行恒 → + selectedBg 整行高亮(pi session-selector 同款);
	 * transcript 区焦点时箭头让位给标题行(选中行仅保留高亮)。 */
	private listZoneLines(listW: number): { lines: string[]; selectedLine: number } {
		const { theme } = this.deps;
		// 行定宽:内容截断到 listW-1(右缘留 1 列不贴分隔线),短行补白到同宽——
		// 选中行高亮恒整行(右缘齐平),段头 ─ 线同界不延伸
		const fitRow = (s: string): string => {
			const t = truncateToWidth(s, listW - 1, theme.fg("dim", "…"));
			const w = visibleWidth(t);
			return w < listW - 1 ? t + " ".repeat(listW - 1 - w) : t;
		};
		const lines: string[] = [];
		let selectedLine = 0;
		// 单焦点:选中行恒 → + selectedBg 整行高亮;history 焦点下列表光标让位
		// (transcript 唯一光标,选中行保留高亮);动作流 stage 高亮选中动作
		if (this.stage === "list") {
			const selIdx = this.selectedIndex();
			// 树形引导(opencode 风格):组内条目用 ├─/└─ 连接线(末条 └─),
			// 段头用 ─ 水平线到栏宽(Claude Code section divider)
			const sectionRows = new Map<Section, number[]>();
			this.rows.forEach((row, i) => {
				if (!isSectionHeader(row)) {
					const arr = sectionRows.get(row.section) ?? [];
					arr.push(i);
					sectionRows.set(row.section, arr);
				}
			});
			this.rows.forEach((row, i) => {
				if (i === selIdx) selectedLine = lines.length;
				// 定宽标记槽(2 列):→ 光标 / 空格(history 焦点下列表无 →)
				const cursor = i === selIdx && !this.historyMode;
				const prefix = cursor ? "→ " : "  ";
				let line: string;
				if (isSectionHeader(row)) {
					// 段头纯分区标签:段名加粗 + count,右侧淡线到栏宽-3(不延伸到分隔线,
					// 与内容行右缘留白区分);不可选中
					const label = prefix + theme.bold(row.main.text);
					const fill = Math.max(1, listW - 3 - visibleWidth(label));
					line = theme.fg("dim", label + "─".repeat(fill));
				} else {
					const idxs = sectionRows.get(row.section) ?? [i];
					const guide = idxs[idxs.length - 1] === i ? "└─ " : "├─ ";
					line = prefix + guide + theme.fg(row.main.color as ThemeColor, i === selIdx ? theme.bold(row.main.text) : row.main.text);
				}
				lines.push(i === selIdx ? theme.bg("selectedBg", fitRow(line)) : fitRow(line));
			});
			if (lines.length === 0) {
				// 空态兜底:全终态/无记录时左栏不空白(esc 关闭在底部 hint 唯一出现,不重复)
				lines.push(fitRow(theme.fg("dim", " 无 worker 记录")));
			}
			return { lines, selectedLine };
		}
		if (this.stage === "actions") {
			const rec = this.selected();
			lines.push(fitRow(theme.fg("muted", `决策对象:${rec ? displayNameOf(rec.id) : "?"}`)));
			this.actions.forEach((a, i) => {
				const text = `${a.label}${a.description ? ` — ${a.description}` : ""}${a.irreversible ? " ⚠" : ""}`;
				const line = (i === this.actionSel ? "→ " : "  ") + theme.fg("warning", i === this.actionSel ? theme.bold(text) : text);
				lines.push(i === this.actionSel ? theme.bg("selectedBg", fitRow(line)) : fitRow(line));
			});
			return { lines, selectedLine };
		}
		if (this.stage === "confirm") {
			const rec = this.selected();
			lines.push(fitRow(theme.fg("warning", theme.bold(`确认${this.currentAction?.label ?? ""} ${rec ? displayNameOf(rec.id) : "?"}?`))));
			lines.push(fitRow(theme.fg("dim", "⚠ 不可逆操作 · enter 确认执行 · esc 取消")));
			return { lines, selectedLine };
		}
		// input
		lines.push(fitRow(theme.fg("warning", this.currentAction?.inputPrompt ?? "输入:")));
		lines.push(...this.input.render(60).map(fitRow));
		lines.push(fitRow(theme.fg("dim", "enter 提交 · esc 返回")));
		return { lines, selectedLine };
	}

	private hint(): string {
		if (this.stage !== "list") return "";
		if (this.rows.length === 0) return "esc 关闭";
		if (this.historyMode) return "↑↓ 消息 · PgUp/PgDn 翻页 · space/esc 返回列表";
		return "↑↓ 选择 · enter 动作 · space 看 history · PgUp/PgDn 翻看 · esc 关闭";
	}

	/** 左栏内容自适应(grok build 任务列同款):静态列(图标+name+runtime+tN)所需宽
	 * + 8 呼吸;list 焦点右栏 ≥56,history 焦点再缩一档(右栏 ≥70,左栏只留身份)。
	 * 动态尾巴(活动摘要)允许被 fitL 截断,不参与宽度。 */
	private staticNeededWidth(): number {
		const now = Date.now();
		const live = this.deps.records().filter((r) => r.state !== "done" && r.state !== "killing");
		return (
			Math.max(0, ...live.map((r) => 1 + visibleWidth(r.name) + 1 + visibleWidth(formatRuntime(r, now)) + String(r.turns).length + 2)) + 8
		);
	}

	render(width: number): string[] {
		const { theme, tui } = this.deps;
		// 所有内容行按 overlay 宽度截尾:长 stderr/报告行不得溢出边框
		const fit = (s: string): string => truncateToWidth(s, width, theme.fg("dim", "…"));
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const out: string[] = [];
		out.push(...border.render(width));
		// 留白:标题/统计/hint 等自由行统一左侧 1 列(不贴边框)
		out.push(fit(theme.fg("accent", theme.bold(" worker "))));
		// 标题统计行:聚合全局状态(与 footer 同词汇同色);全终态省略。与列表同快照
		// (见 refresh):1 tick 窗口内不出现计数与列表矛盾
		const stats = formatPaneStats(this.snapshot, (c: FooterColor, t: string) => theme.fg(c as ThemeColor, t));
		if (stats) out.push(fit(theme.fg("dim", ` ${stats}`)));
		const viewport = Math.max(6, Math.floor(tui.terminal.rows * 0.9) - FRAME_LINES);
		// 双栏 master-detail:左 = 决策队列 + 判决证据预览;右 = 选中 worker 的
		// live transcript。左栏内容自适应(见 staticNeededWidth),窄终端由
		// paneOverlayOptions 95% 兜底;左栏截断,右栏正文按可见宽折行(不截断),
		// 分隔 " │" 固定 2 列。面板恒满高(补全):内容短时窗内留白,
		// 底边框位置恒定,不随 live 内容增长重排。
		const staticNeeded = this.staticNeededWidth();
		// 下限 34 = 判决证据可读(诊断行 ≈31 列),不以 28 硬缩
		const listW = this.historyMode
			? Math.max(20, Math.min(staticNeeded, width - 70))
			: Math.max(34, Math.min(staticNeeded, width - 56));
		const rightW = Math.max(1, width - listW - 2);
		const fitL = (s: string): string => {
			// 截断到 listW-1;短行补白(右缘齐平;listZoneLines 已补,预览行在此补)
			const t = truncateToWidth(s, listW - 1, theme.fg("dim", "…"));
			const w = visibleWidth(t);
			return w < listW - 1 ? t + " ".repeat(listW - 1 - w) : t;
		};
		const fitR = (s: string): string => truncateToWidth(s, rightW, theme.fg("dim", "…"));
		// 左栏:list 滚动窗口(选中行恒可见)+ 选中行判决证据(仅 list 焦点;
		// 动作流 stage 的 selectedId 语义已过期,不渲染)。preview 上限固定
		// PREVIEW_MAX:list 窗口 = viewport - 预留,不随选中行详情长度抖动。
		const { lines, selectedLine } = this.listZoneLines(listW);
		const preview = this.stage === "list" && !this.historyMode ? (this.rows[this.selectedIndex()]?.details ?? []).slice(0, PREVIEW_MAX) : [];
		const leftH = Math.min(lines.length, Math.max(3, viewport - (this.stage === "list" && !this.historyMode ? PREVIEW_MAX : 0)));
		if (selectedLine < this.scrollTop) this.scrollTop = selectedLine;
		if (selectedLine >= this.scrollTop + leftH) this.scrollTop = selectedLine - leftH + 1;
		const leftLines: string[] = lines.slice(this.scrollTop, this.scrollTop + leftH).map(fitL);
		preview.forEach((d, di) => {
			// 判决证据对齐条目内容(5 列槽 = 光标 2 + 树线 3)
			leftLines.push(fitL(`     ${di === 0 ? "⎿ " : "  "}${theme.fg(d.color as ThemeColor, d.text)}`));
		});
		// 右栏:标题行 + transcript 正文(正文缩进 2 列与标题对齐;正文在
		// 可见宽 rightW-2 内折行,宽度变化自动重渲染;fitR 只留给标题)。
		// exited 折叠行选中 = 成员预览。
		const transW = Math.max(1, rightW - 2);
		const rightLines: string[] = [];
		if (this.rows.length === 0) {
			// 空态:无任何可列记录(全终态/未派发)——panel 照常打开,右栏给派发引导
			// (esc 关闭在底部 hint 唯一出现,文案去重)
			rightLines.push(fitR(theme.fg("dim", `  ${theme.bold("尚无 worker")}`)));
			rightLines.push(fitR(theme.fg("dim", "  用 pi_worker run 派发第一个 worker")));
		} else if (this.selectedId === EXITED_FOLD_ID) {
			const exited = this.deps.records().filter((r) => r.state === "exited");
			rightLines.push(fitR(theme.fg("dim", `  ${theme.bold(`⏾ exited ×${exited.length}(折叠中 · enter 展开)`)}`)));
			for (const r of exited.slice(0, viewport - 1)) rightLines.push(fitR(theme.fg("dim", `  ⏾ ${r.name}`)));
		} else {
			const rec = this.selected();
			const title = transcriptTitle(rec, {
				// 段头不可选中,标题恒跟随真实 worker;无 rec 仅剩 exited 折叠预览分支
				providerName: rec ? this.deps.providerNameFor(rec.id) : undefined,
			});
			// 标题与正文同列对齐(2 列缩进),grok 详情区同款
			rightLines.push(fitR(theme.fg(title.color, `  ${theme.bold(title.text)}`)));
			const transH = Math.max(1, Math.min(viewport - 1, this.transcript.measureBody(transW)));
			this.transViewport = transH;
			// 状态先行:renderBody 一次完成 offset/follow 对齐(pendingDelta 消费),
			// 再取光标行——否则 follow 回底/锚点对齐后的行号取不到
			this.transcript.renderBody(transW, transH);
			const cursorRow = this.historyMode ? this.transcript.cursorRowInView() : -1;
			for (const [i, l] of this.transcript.renderBody(transW, transH).entries()) {
				// history 焦点:锚点行 → 前缀(与列表光标同词汇,2 列槽位不变)
				rightLines.push(l === "" ? "" : i === cursorRow ? `→ ${l}` : `  ${l}`);
			}
		}
		// 双栏拼行:短栏补空;面板恒满高(补全:底边框位置恒定,内容增长不重排);
		// 分隔线降饱和并贯穿全高(分区隔离);行总宽 = listW + 2 + rightW
		const rows = viewport;
		const sep = theme.fg("dim", " │");
		for (let i = 0; i < rows; i++) {
			const l = i < leftLines.length ? leftLines[i] : "";
			const r = i < rightLines.length ? rightLines[i] : "";
			out.push(`${l || " ".repeat(listW)}${sep}${r}`);
		}
		const hint = this.hint();
		if (hint) out.push(fit(theme.fg("dim", ` ${hint}`)));
		out.push(...border.render(width));
		return out;
	}

	invalidate(): void {
		this.refresh();
	}

	private enterActions(): void {
		const rec = this.selected();
		if (!rec) return;
		this.actions = actionsFor(rec);
		this.actionSel = 0;
		this.stage = "actions";
	}

	private pickAction(): void {
		const action = this.actions[this.actionSel];
		const rec = this.selected();
		if (!action || !rec) return;
		this.currentAction = action;
		if (action.irreversible) {
			this.stage = "confirm";
		} else if (action.needsInput) {
			// 草稿保持(btw 借鉴):进入输入态不清空——上次失败的重试文本可编辑;
			// 成功提交后由 onSubmit 清空
			this.stage = "input";
		} else {
			void this.deps.execute(action, rec, undefined);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.stage === "confirm") {
			if (kb.matches(data, "tui.select.confirm") && this.currentAction) {
				void this.deps.execute(this.currentAction, this.selected()!, undefined);
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.stage = "actions";
			}
			return;
		}
		if (this.stage === "input") {
			this.input.handleInput(data);
			return;
		}
		if (this.stage === "actions") {
			if (kb.matches(data, "tui.select.up")) {
				this.actionSel = this.actionSel === 0 ? this.actions.length - 1 : this.actionSel - 1;
			} else if (kb.matches(data, "tui.select.down")) {
				this.actionSel = this.actionSel === this.actions.length - 1 ? 0 : this.actionSel + 1;
			} else if (kb.matches(data, "tui.select.confirm")) {
				this.pickAction();
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.stage = "list";
			}
			return;
		}
		// list stage:↑↓ 选择 worker;空格进 history(transcript 焦点,选中冻结);
		// PgUp/PgDn 仅翻看 transcript,不改变选中
		if (this.historyMode) {
			// history 焦点:↑↓ 消息粒度移动(列表选中冻结),PgUp/PgDn 整页;space/esc 返回
			if (kb.matches(data, "tui.select.up")) {
				this.transcript.scrollToAnchor(-1);
			} else if (kb.matches(data, "tui.select.down")) {
				this.transcript.scrollToAnchor(1);
			} else if (kb.matches(data, "tui.select.pageUp")) {
				this.transcript.scroll(-Math.max(1, this.transViewport));
			} else if (kb.matches(data, "tui.select.pageDown")) {
				this.transcript.scroll(Math.max(1, this.transViewport));
			} else if (data === " ") {
				this.historyMode = false;
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.historyMode = false;
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.transcript.scroll(-Math.max(1, this.transViewport));
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.transcript.scroll(Math.max(1, this.transViewport));
		} else if (kb.matches(data, "tui.select.confirm")) {
			// 伪行 enter 分流:exited 折叠行展开;段头不可选中,无折叠语义
			if (this.selectedId === EXITED_FOLD_ID) {
				this.expandExited = true;
				this.refresh();
				return;
			}
			this.enterActions();
		} else if (data === " ") {
			// 空格进 history:transcript 焦点(选中冻结,消息粒度浏览)
			this.historyMode = true;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.deps.onClose();
		}
	}
}

/** 面板动作执行依赖面(openWorkerPane 接线,executePaneAction 可单测)。 */
export interface PaneActionDeps {
	manager: WorkerManager;
	/** 注入父 session(steer 投递;判决 frontmatter 落笔 / 撤换归因指引) */
	sendUserMessage: (text: string) => void;
	/** 机械动作审计留痕(display 不唤醒) */
	sendAudit: (content: string, id: string) => void;
	notify: (text: string, level?: "info" | "error") => void;
}

/** 面板动作执行(可单测):判决/撤换 = 机械收尾(collect 立即落记录+verdict,反馈即实际状态)
 * + 指引注入父 session(frontmatter 落笔/归因分流归父 agent 判断);stop/kill/collect 直调
 * manager;message 走 bus。任何动作不关窗——关窗权只在 esc(批量连续操作不反复开关面板)。
 * 返回 false = 执行失败(输入草稿保留,可编辑重试)。 */
export async function executePaneAction(deps: PaneActionDeps, action: WorkerAction, rec: WorkerRecord, input?: string): Promise<boolean> {
	const op = opFor(action, rec.id, input);
	try {
		if (op.kind === "verdict" || op.kind === "replacement") {
			if (op.kind === "verdict") deps.manager.collect(rec.id, op.verdict);
			else deps.manager.collect(rec.id);
			deps.sendUserMessage(op.text);
			deps.sendAudit(op.audit, rec.id);
			deps.notify(`${op.audit};frontmatter/归因指引已注入父会话`, "info");
			return true;
		}
		if (op.kind === "stop") await deps.manager.stop(rec.id);
		else if (op.kind === "kill") await deps.manager.kill(rec.id);
		else if (op.kind === "collect") deps.manager.collect(rec.id);
		else if (op.kind === "message") {
			const result = await deps.manager.bus.post("parent", rec.id, op.message);
			if (!result.ok) throw new WorkerError(result.reason);
		}
		deps.sendAudit(op.audit, rec.id);
		deps.notify(`已处理:${op.audit}`, "info");
		return true;
	} catch (e) {
		// 状态过期(窗口打开期间 worker 已迁移)/ 投递失败:错误可见,草稿保留可重试
		deps.notify(`${action.label} 失败:${e instanceof Error ? e.message : String(e)}`, "error");
		return false;
	}
}

/** 打开窗口所需的最小宿主面(command 与 shortcut handler 共用)。 */
export type PaneHost = Pick<ExtensionContext, "mode" | "ui" | "modelRegistry">;

/**
 * 打开 worker 合并窗口(入口复用:/pi-worker 命令与 alt+w 快捷键同路,peer chat 入口)。
 * RPC 模式降级到 pi_worker status 工具。
 */
export async function openWorkerPane(pi: ExtensionAPI, manager: WorkerManager, ctx: PaneHost): Promise<void> {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pane 仅 TUI 可用;RPC 下用 pi_worker status 工具查询", "warning");
				return;
			}
			const records = manager.status() as WorkerRecord[];
			// 无记录也打开:panel 是 chat 入口,空态给派发引导(见 render 空态分支)
			await manager.refreshModelInfoAll();
			// provider 显示名(如 "OpenCode Go")查父侧 registry,fallback provider id
			const providerNames = new Map<string, string>();
			for (const r of records) {
				if (r.modelInfo && !providerNames.has(r.modelInfo.provider)) {
					const name = ctx.modelRegistry.getProvider(r.modelInfo.provider)?.name;
					if (name) providerNames.set(r.modelInfo.provider, name);
				}
			}
			await ctx.ui.custom<null>(
				(tui, theme, _kb, done) => {
					const pane = new WorkerPaneComponent({
						records: () => manager.status() as WorkerRecord[],
						providerNameFor: (id) => {
							const all = manager.status() as WorkerRecord[];
							const mi = all.find((r) => r.id === id)?.modelInfo;
							return mi ? providerNames.get(mi.provider) : undefined;
						},
						transcriptView: (id) => manager.transcriptView(id),
						theme,
						tui,
						onClose: () => done(null),
						execute: async (action, rec, input) => {
							const ok = await executePaneAction(
								{
									manager,
									sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "steer" }),
									sendAudit: (content, id) =>
										pi.sendMessage({ customType: "pi-worker", content, display: true, details: { type: "action-done", id } }),
									notify: (text, level) => ctx.ui.notify(text, level),
								},
								action,
								rec,
								input,
							);
							// 任何动作不关窗:refresh + 回 list 连续操作(批量收尾/聊天循环);
							// 关窗权只在 esc。失败同样回 list(状态过期重建投影)。
							pane.refresh();
							pane.toListStage();
							return ok;
						},
					});
					// 1s tick:行内容(elapsed/活动/脉冲)与 transcript 区随状态迁移刷新
					const tick = setInterval(() => {
						pane.refresh();
						tui.requestRender();
					}, 1000);
					return {
						render: (w) => pane.render(w),
						invalidate: () => pane.refresh(),
						get focused() {
							return pane.inputStage;
						},
						set focused(v: boolean) {
							pane.setInputFocused(v);
						},
						handleInput: (data) => {
							pane.handleInput(data);
							tui.requestRender();
						},
						dispose: () => clearInterval(tick),
					};
				},
				{
					overlay: true,
					overlayOptions: () => paneOverlayOptions(process.stdout.columns ?? 120, process.stdout.rows ?? 40),
				},
			);
}

/** /pi-worker 命令:打开合并窗口;RPC 模式降级到 pi_worker status 工具。 */
export function registerWorkerPaneCommand(pi: ExtensionAPI, manager: WorkerManager): void {
	pi.registerCommand("pi-worker", {
		description:
			"worker 合并窗口:决策队列(待决策在前)+ 选中 worker 的 live transcript 同屏;判决/撤换机械收尾 + 指引注入父 session,消息/机械直调 manager",
		handler: async (_args, ctx) => openWorkerPane(pi, manager, ctx),
	});
}
