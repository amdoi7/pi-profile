import {
	DynamicBorder,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { readdirSync } from "node:fs";
import { join } from "node:path";
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
import type { WorkerRecord } from "./types.ts";

/**
 * worker 合并窗口(终局单窗口):grok tasks pane + framed 子视图的合并形态。
 * 上 = 决策队列(每行即 worker 的交互代表);选中行的判决证据在 list 下方的
 * 预览条带(只对选中行展开);下 = 选中 worker 的 live transcript,高度按内容
 * 分配(空/短 transcript 不独占窗口)。tab 在两区间切换;esc 分层退回。
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
	/** worker → session jsonl 路径(缺省 "" → transcript 区显示缺失提示) */
	sessionFileFor: (rec: WorkerRecord) => string;
	theme: Theme;
	tui: { terminal: { rows: number; columns: number }; requestRender(): void };
	onClose: () => void;
	execute: (action: WorkerAction, rec: WorkerRecord, input?: string) => Promise<void>;
}

type Stage = "list" | "actions" | "input" | "confirm";
type Zone = "list" | "transcript";

/** 边框+标题+提示行的固定预留;list 区至多占正文 45%,余给 transcript 区。 */
const FRAME_LINES = 4;
const LIST_MAX_RATIO = 0.45;

export class WorkerPaneComponent {
	private stage: Stage = "list";
	private zone: Zone = "list";
	private rows: OverlayRow[] = [];
	private selectedId: string | undefined;
	private actionSel = 0;
	private actions: WorkerAction[] = [];
	private currentAction: WorkerAction | undefined;
	private scrollTop = 0;
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
		this.transcript = new TranscriptZone({ file: this.selectedFile(), theme: deps.theme });
	}

	private selected(): WorkerRecord | undefined {
		return this.deps.records().find((r) => r.id === this.selectedId);
	}

	private selectedFile(): string {
		const rec = this.selected();
		return rec ? this.deps.sessionFileFor(rec) : "";
	}

	private selectedIndex(): number {
		return Math.max(0, this.rows.findIndex((r) => r.value === this.selectedId));
	}

	/** 重建投影(记录是活引用;选中按 id 保持,消失回落首行;transcript 跟随选中)。 */
	refresh(): void {
		const before = this.selectedId;
		this.rows = formatOverlayRows(this.deps.records(), Date.now(), { expandExited: this.expandExited });
		if (!this.rows.some((r) => r.value === this.selectedId)) {
			this.selectedId = this.rows[0]?.value;
		}
		if (this.transcript && this.selectedId !== before) this.syncTranscript();
	}

	/** transcript 跟随选中;折叠行是伪行,不抢占(保持上一真实选中)。 */
	private syncTranscript(): void {
		const rec = this.selected();
		if (rec) this.transcript.setFile(this.deps.sessionFileFor(rec));
	}

	get inputStage(): boolean {
		return this.stage === "input";
	}

	setInputFocused(v: boolean): void {
		this.input.focused = v;
	}

	/** 错误恢复:重建后回 list stage/zone(状态过期时动作流不再有效)。 */
	toListStage(): void {
		this.stage = "list";
		this.zone = "list";
	}

	/** list 区内容行:list stage = 分区头 + 行 + 拆封 details;其余 stage = 动作流。 */
	private listZoneLines(): { lines: string[]; selectedLine: number } {
		const { theme } = this.deps;
		const lines: string[] = [];
		let selectedLine = 0;
		if (this.stage === "list") {
			let lastSection = "";
			const selIdx = this.selectedIndex();
			this.rows.forEach((row, i) => {
				if (row.section !== lastSection) {
					const n = this.rows.filter((r) => r.section === row.section).length;
					lines.push(theme.fg("dim", row.section === "decision" ? `── 待决策 (${n})` : `── 工作中 (${n})`));
					lastSection = row.section;
				}
				if (i === selIdx) selectedLine = lines.length;
				const prefix = i === selIdx && this.zone === "list" ? "→ " : "  ";
				lines.push(prefix + theme.fg(row.main.color as ThemeColor, i === selIdx ? theme.bold(row.main.text) : row.main.text));
			});
			return { lines, selectedLine };
		}
		if (this.stage === "actions") {
			const rec = this.selected();
			lines.push(theme.fg("muted", `决策对象:${rec ? displayNameOf(rec.id) : "?"}`));
			this.actions.forEach((a, i) => {
				const text = `${a.label}${a.description ? ` — ${a.description}` : ""}${a.irreversible ? " ⚠" : ""}`;
				lines.push((i === this.actionSel ? "→ " : "  ") + theme.fg("warning", i === this.actionSel ? theme.bold(text) : text));
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
		return this.zone === "list"
			? "↑↓ 选择 · enter 动作 · tab transcript · esc 关闭"
			: "↑↓ 消息 · tab/esc 返回列表";
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
		const { lines, selectedLine } = this.listZoneLines();
		const listH = Math.min(lines.length, Math.max(3, Math.floor(viewport * LIST_MAX_RATIO)));
		if (selectedLine < this.scrollTop) this.scrollTop = selectedLine;
		if (selectedLine >= this.scrollTop + listH) this.scrollTop = selectedLine - listH + 1;
		out.push(...lines.slice(this.scrollTop, this.scrollTop + listH).map(fit));
		// 选中行的判决证据:list 与 transcript 之间的预览条带(仅 list stage;
		// 动作流 stage 的 selectedId 语义已过期,不渲染)
		const preview = this.stage === "list" ? (this.rows[this.selectedIndex()]?.details ?? []) : [];
		preview.forEach((d, di) => {
			out.push(fit(`  ${di === 0 ? "⎿ " : "  "}${theme.fg(d.color as ThemeColor, d.text)}`));
		});
		// transcript 区:高度按内容分配——空/短 transcript 收小,不独占剩余窗口;
		// 内容超出时退回窗口化滚动(renderBody 内部 offset/follow 不变)
		const transAvail = Math.max(1, viewport - listH - preview.length - 1);
		const focusedMark = this.zone === "transcript" && this.stage === "list" ? "→ " : "── ";
		if (this.selectedId === EXITED_FOLD_ID) {
			// 折叠行选中:正文列出被聚合的 exited 记录名(展开前预览)
			const exited = this.deps.records().filter((r) => r.state === "exited");
			out.push(fit(theme.fg("dim", `${focusedMark}${theme.bold(`⏾ exited ×${exited.length}(折叠中 · enter 展开)`)}`)));
			for (const r of exited.slice(0, transAvail)) out.push(fit(theme.fg("dim", `  ⏾ ${r.name}`)));
		} else {
			const rec = this.selected();
			const title = transcriptTitle(rec, {
				fallbackName: rec?.name,
				providerName: rec ? this.deps.providerNameFor(rec.id) : undefined,
			});
			out.push(fit(theme.fg(title.color, `${focusedMark}${theme.bold(title.text)}`)));
			const transH = Math.max(1, Math.min(transAvail, this.transcript.measureBody(width)));
			out.push(...this.transcript.renderBody(width, transH));
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
		// list stage:tab 切区;transcript 区 ↓↑ 滚动、esc/tab 返回;list 区导航
		if (data === "\t") {
			this.zone = this.zone === "list" ? "transcript" : "list";
			return;
		}
		if (this.zone === "transcript") {
			if (kb.matches(data, "tui.select.up")) this.transcript.scrollMessage(-1);
			else if (kb.matches(data, "tui.select.down")) this.transcript.scrollMessage(1);
			else if (kb.matches(data, "tui.select.cancel")) this.zone = "list";
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			const i = this.selectedIndex();
			this.selectedId = this.rows[i === 0 ? this.rows.length - 1 : i - 1]?.value;
			this.syncTranscript();
		} else if (kb.matches(data, "tui.select.down")) {
			const i = this.selectedIndex();
			this.selectedId = this.rows[i === this.rows.length - 1 ? 0 : i + 1]?.value;
			this.syncTranscript();
		} else if (kb.matches(data, "tui.select.confirm")) {
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

/** session 文件解析:record.sessionFile 优先(握手指针);缺失回退 sessionDir 内首个 jsonl。 */
function resolveSessionFile(manager: WorkerManager, rec: WorkerRecord): string {
	if (rec.sessionFile) return rec.sessionFile;
	const dir = manager.getSessionDir(rec.id);
	if (dir) {
		try {
			const f = readdirSync(dir).find((x) => x.endsWith(".jsonl"));
			if (f) return join(dir, f);
		} catch {
			// 目录不可读 → 缺失提示
		}
	}
	return "";
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
						sessionFileFor: (rec) => resolveSessionFile(manager, rec),
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
