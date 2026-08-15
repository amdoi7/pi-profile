import {
	DynamicBorder,
	type ExtensionAPI,
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
	opFor,
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
 * 交互:单焦点,无 tab/无模式切换——↑↓ 恒在 list 选择(transcript 自动跟随),
 * PgUp/PgDn 直接翻看 transcript(不改变选中);enter 动作流;esc 分层退出
 * (动作流 → 关窗)。光标:选中行恒 → + selectedBg 整行高亮。段头是纯分区标签,
 * 不可选中——↑↓ 跳过,光标只落真实 worker(身份恒连续)。
 * 动作语义不变:判决/撤换注入父 session,消息/机械直调 manager,不可逆二次确认。
 */

/** 合并窗口布局:居中宽窗(transcript 需要宽度);窄终端 95% 回退。 */
export function paneOverlayOptions(cols: number, _rows: number): Record<string, unknown> {
	if (cols < 100) return { anchor: "center", width: "95%", maxHeight: "90%", margin: 0 };
	return { anchor: "center", width: "85%", maxHeight: "90%", margin: 0 };
}

interface PaneDeps {
	records: () => WorkerRecord[];
	providerNameFor: (id: string) => string | undefined;
	/** transcript 数据源(manager 持有:live 事件流+回填,dead 文件缓存);undefined → 缺失提示 */
	transcriptView: (id: string) => SessionEntry[] | undefined;
	theme: Theme;
	tui: { terminal: { rows: number; columns: number }; requestRender(): void };
	onClose: () => void;
	execute: (action: WorkerAction, rec: WorkerRecord, input?: string) => Promise<void>;
}

type Stage = "list" | "actions" | "input" | "confirm";

/** 边框+标题+hint 的固定预留;内容区(双栏)高度 = 终端 90% - 该值。 */
const FRAME_LINES = 4;

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

	constructor(private readonly deps: PaneDeps) {
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			if (this.currentAction) void this.deps.execute(this.currentAction, this.selected()!, value);
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

	/** 重建投影(记录是活引用;选中按 id 保持,消失回落首行;段头/折叠过滤在此统一;transcript 跟随选中)。 */
	refresh(): void {
		const before = this.selectedId;
		this.rows = this.withSectionHeaders(
			formatOverlayRows(this.deps.records(), Date.now(), { expandExited: this.expandExited }),
		);
		// 选中有效性兜底:选中不可见(记录消失)即回落首个真实行(段头不抢占)
		if (!this.rows.some((r) => r.value === this.selectedId)) {
			this.selectedId = this.firstSelectableValue();
		}
		if (this.transcript && this.selectedId !== before) this.syncTranscript();
	}

	/** 段头注入:纯分区标签(待决策/工作中 + count),不可选中、不可折叠——
	 * 光标只落真实 worker(身份恒连续);exited 自动折叠(exited fold 行)除外。 */
	private withSectionHeaders(rows: OverlayRow[]): OverlayRow[] {
		const counts = new Map<Section, number>();
		for (const r of rows) counts.set(r.section, (counts.get(r.section) ?? 0) + 1);
		const out: OverlayRow[] = [];
		let lastSection: Section | undefined;
		for (const row of rows) {
			if (row.section !== lastSection) {
				const label = row.section === "decision" ? "待决策" : "工作中";
				out.push({
					value: sectionHeaderId(row.section),
					section: row.section,
					main: { text: `${label} (${counts.get(row.section) ?? 0})`, color: "dim" },
					details: [],
				});
				lastSection = row.section;
			}
			out.push(row);
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
		const lines: string[] = [];
		let selectedLine = 0;
		// 单焦点:选中行恒 → + selectedBg 整行高亮;动作流 stage 高亮选中动作
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
				// 定宽标记槽(2 列):→ 光标 / 空格。
				const cursor = i === selIdx;
				const prefix = cursor ? "→ " : "  ";
				let line: string;
				if (isSectionHeader(row)) {
					// 段头纯分区标签:段名 + count,右侧淡线延伸到栏宽;不可选中
					const label = prefix + row.main.text;
					const fill = Math.max(1, listW - visibleWidth(label));
					line = theme.fg("dim", label + "─".repeat(fill));
				} else {
					const idxs = sectionRows.get(row.section) ?? [i];
					const guide = idxs[idxs.length - 1] === i ? "└─ " : "├─ ";
					line = prefix + guide + theme.fg(row.main.color as ThemeColor, i === selIdx ? theme.bold(row.main.text) : row.main.text);
				}
				lines.push(i === selIdx ? theme.bg("selectedBg", line) : line);
			});
			return { lines, selectedLine };
		}
		if (this.stage === "actions") {
			const rec = this.selected();
			lines.push(theme.fg("muted", `决策对象:${rec ? displayNameOf(rec.id) : "?"}`));
			this.actions.forEach((a, i) => {
				const text = `${a.label}${a.description ? ` — ${a.description}` : ""}${a.irreversible ? " ⚠" : ""}`;
				const line = (i === this.actionSel ? "→ " : "  ") + theme.fg("warning", i === this.actionSel ? theme.bold(text) : text);
				lines.push(i === this.actionSel ? theme.bg("selectedBg", line) : line);
			});
			return { lines, selectedLine };
		}
		if (this.stage === "confirm") {
			const rec = this.selected();
			lines.push(theme.fg("warning", theme.bold(`确认${this.currentAction?.label ?? ""} ${rec ? displayNameOf(rec.id) : "?"}?`)));
			lines.push(theme.fg("dim", "⚠ 不可逆操作 · enter 确认执行 · esc 取消"));
			return { lines, selectedLine };
		}
		// input
		lines.push(theme.fg("warning", this.currentAction?.inputPrompt ?? "输入:"));
		lines.push(...this.input.render(60));
		lines.push(theme.fg("dim", "enter 提交 · esc 返回"));
		return { lines, selectedLine };
	}

	private hint(): string {
		if (this.stage !== "list") return "";
		return "↑↓ 选择 · enter 动作 · PgUp/PgDn 翻看 transcript · esc 关闭";
	}

	render(width: number): string[] {
		const { theme, tui } = this.deps;
		// 所有内容行按 overlay 宽度截尾:长 stderr/报告行不得溢出边框
		const fit = (s: string): string => truncateToWidth(s, width, theme.fg("dim", "…"));
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const out: string[] = [];
		out.push(...border.render(width));
		out.push(fit(theme.fg("accent", theme.bold(" worker"))));
		const viewport = Math.max(6, Math.floor(tui.terminal.rows * 0.9) - FRAME_LINES);
		// 双栏 master-detail:左 = 决策队列 + 判决证据预览;右 = 选中 worker 的
		// live transcript。左栏 42% 宽(至少 28 列、留右栏 ≥ 45 列),窄终端由
		// paneOverlayOptions 95% 兜底;两栏各自截断,分隔 " │ " 固定 3 列。
		const listW = Math.max(28, Math.min(Math.floor(width * 0.42), width - 48));
		const rightW = Math.max(1, width - listW - 3);
		const fitL = (s: string): string => truncateToWidth(s, listW, theme.fg("dim", "…"));
		const fitR = (s: string): string => truncateToWidth(s, rightW, theme.fg("dim", "…"));
		// 左栏:list 滚动窗口(选中行恒可见)+ 选中行判决证据(仅 list stage;
		// 动作流 stage 的 selectedId 语义已过期,不渲染)
		const { lines, selectedLine } = this.listZoneLines(listW);
		const preview = this.stage === "list" ? (this.rows[this.selectedIndex()]?.details ?? []) : [];
		const leftH = Math.min(lines.length, Math.max(3, viewport - preview.length));
		if (selectedLine < this.scrollTop) this.scrollTop = selectedLine;
		if (selectedLine >= this.scrollTop + leftH) this.scrollTop = selectedLine - leftH + 1;
		const leftLines: string[] = lines.slice(this.scrollTop, this.scrollTop + leftH).map(fitL);
		preview.forEach((d, di) => {
			// 判决证据对齐条目内容(5 列槽 = 光标 2 + 树线 3)
			leftLines.push(fitL(`     ${di === 0 ? "⎿ " : "  "}${theme.fg(d.color as ThemeColor, d.text)}`));
		});
		// 右栏:标题行 + transcript 正文(正文缩进 2 列与标题对齐);exited 折叠行
		// 选中 = 成员预览。短内容不补满(布局稳定,底部空行由布局契约控制)
		const rightLines: string[] = [];
		if (this.selectedId === EXITED_FOLD_ID) {
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
			const transH = Math.max(1, Math.min(viewport - 1, this.transcript.measureBody(rightW)));
			this.transViewport = transH;
			for (const l of this.transcript.renderBody(rightW, transH)) {
				rightLines.push(l === "" ? "" : fitR(`  ${l}`));
			}
		}
		// 双栏拼行:短栏补空;分隔线降饱和(克制,不抢内容);行总宽 = listW + 3 + rightW
		const rows = Math.max(leftLines.length, rightLines.length);
		const sep = theme.fg("dim", " │ ");
		for (let i = 0; i < rows; i++) {
			const l = i < leftLines.length ? leftLines[i] : "";
			const r = i < rightLines.length ? rightLines[i] : "";
			out.push(`${l || " ".repeat(listW)}${sep}${r}`);
		}
		const hint = this.hint();
		if (hint) out.push(fit(theme.fg("dim", hint)));
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
			this.input.setValue("");
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
		// list stage(单焦点):↑↓ 选择 worker;PgUp/PgDn 仅翻看 transcript,不改变选中
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
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.deps.onClose();
		}
	}
}

/** /pi-worker 命令:打开合并窗口;RPC 模式降级到 pi_worker status 工具。 */
export function registerWorkerPaneCommand(pi: ExtensionAPI, manager: WorkerManager): void {
	pi.registerCommand("pi-worker", {
		description:
			"worker 合并窗口:决策队列(待决策在前)+ 选中 worker 的 live transcript 同屏;判决/撤换注入父 session,消息/机械直调 manager",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pane 仅 TUI 可用;RPC 下用 pi_worker status 工具查询", "warning");
				return;
			}
			const records = manager.status() as WorkerRecord[];
			if (records.length === 0) {
				ctx.ui.notify("无 worker 记录", "info");
				return;
			}
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
							try {
								const op = opFor(action, rec.id, input);
								if (op.kind === "inject") {
									// 判决/撤换:落 verdict/归因分流需要父 agent 判断;user message 落 session 即审计
									pi.sendUserMessage(op.text, { deliverAs: "steer" });
									ctx.ui.notify(`已处理:${op.text}`, "info");
								} else {
									if (op.kind === "stop") await manager.stop(rec.id);
									else if (op.kind === "kill") await manager.kill(rec.id);
									else if (op.kind === "collect") manager.collect(rec.id);
									else if (op.kind === "message") {
										const result = await manager.bus.post("parent", rec.id, op.message);
										if (!result.ok) throw new WorkerError(result.reason);
									}
									pi.sendMessage({
										customType: "pi-worker",
										content: op.audit,
										display: true,
										details: { type: "action-done", id: rec.id },
									});
									ctx.ui.notify(`已处理:${op.audit}`, "info");
								}
								done(null);
							} catch (e) {
								// 状态过期(窗口打开期间 worker 已迁移):重建投影回列表,不崩溃不静默
								ctx.ui.notify(`${action.label} 失败:${e instanceof Error ? e.message : String(e)}`, "error");
								pane.refresh();
								pane.toListStage();
							}
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
		},
	});
}
