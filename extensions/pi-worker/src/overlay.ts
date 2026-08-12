import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkerManager } from "./manager.ts";
import { WorkerError } from "./state-machine.ts";
import {
	actionsFor,
	displayNameOf,
	formatOverlayRows,
	opFor,
	type OverlayLine,
	type OverlayRow,
	type WorkerAction,
} from "./present.ts";
import type { WorkerRecord } from "./types.ts";

/**
 * /pi-worker worker 决策队列 overlay(slice 2+3)。
 * 排序即治理:等决策(failed/idle/exited)在前,工作中在后;终态不列出。
 * 动作集来自 present.actionsFor(与状态机合法集一致,不给非法 action)。
 * 执行路径:判决/消息/机械动作 → opFor 直调 manager(人到人决,无 LLM 中转),
 * 审计陈述式留痕(display,不唤醒父);仅归因四路注入父 session(修合约是真判断)。
 * 不可逆动作(丢弃/强制放行/归因/kill)需 enter 二次确认。
 */

export function registerWorkerOverlayCommand(pi: ExtensionAPI, manager: WorkerManager): void {
	pi.registerCommand("pi-worker", {
		description: "worker 决策队列:等决策(failed/idle/exited)在前,工作中在后;动作直调 manager,归因注入父 session",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("overlay 仅 TUI 可用;RPC 下用 pi_worker status 工具查询", "warning");
				return;
			}
			await showOverlay(pi, manager, ctx);
		},
	});
}

/** 多行单选列表:主行单行(图标+核心信息),details 仅选中行展开(渐进披露)。 */
class RowList {
	selected = 0;

	constructor(
		private readonly rows: OverlayRow[],
		private readonly renderLine: (line: OverlayLine, isSelected: boolean, li: number) => string,
		readonly onSelect: (value: string) => void,
		readonly onCancel: () => void,
		private readonly opts: { showSections?: boolean; renderSection?: (section: string) => string } = {},
	) {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selected = this.selected === 0 ? this.rows.length - 1 : this.selected - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = this.selected === this.rows.length - 1 ? 0 : this.selected + 1;
		} else if (kb.matches(data, "tui.select.confirm")) {
			const row = this.rows[this.selected];
			if (row) this.onSelect(row.value);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	render(): string[] {
		// 列表恒定高度:details 不进行间(行随选中移动会跳),固定渲染在列表底部。
		const out: string[] = [];
		let lastSection = "";
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (this.opts.showSections && row.section !== lastSection && this.opts.renderSection) {
				out.push(this.opts.renderSection(row.section));
				lastSection = row.section;
			}
			out.push(this.renderLine(row.main, i === this.selected, 0));
		}
		// 预览窗格:选中行详情固定底部(fzf/lazygit 式,扫读不跳动);
		// actions stage 无 details → 不渲染窗格。
		const sel = this.rows[this.selected];
		if (sel && sel.details.length > 0) {
			out.push("");
			sel.details.forEach((d, di) => out.push(this.renderLine(d, false, di + 1)));
		}
		return out;
	}
}

/** 单行动作列表(actions stage):label + description 拼接,不截断。 */
function actionRows(actions: WorkerAction[]): OverlayRow[] {
	return actions.map((a) => ({
		value: a.value,
		section: "decision" as const, // actions stage 不显示分区头
		main: { text: `${a.label}${a.description ? ` — ${a.description}` : ""}${a.irreversible ? " ⚠" : ""}`, color: "warning" },
		details: [],
	}));
}

function padTo(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? text : text + " ".repeat(width - w);
}

async function showOverlay(pi: ExtensionAPI, manager: WorkerManager, ctx: ExtensionContext): Promise<void> {
	// 打开前补查模型信息(握手未完成的记录);快命令,无定时器
	await manager.refreshModelInfoAll();

	const records = manager.status() as WorkerRecord[];
	if (records.length === 0) {
		ctx.ui.notify("无 worker 记录", "info");
		return;
	}

	// provider 显示名(如 "OpenCode Go")查父侧 registry,fallback provider id
	const providerNames = new Map<string, string>();
	for (const r of records) {
		if (r.modelInfo && !providerNames.has(r.modelInfo.provider)) {
			const name = ctx.modelRegistry.getProvider(r.modelInfo.provider)?.name;
			if (name) providerNames.set(r.modelInfo.provider, name);
		}
	}

	await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			// 记录是 manager 的活引用(状态变化直接反映),投影文本需重建——execute 失败(状态
			// 过期)时重新投影回列表。
			const buildItems = (now: number): OverlayRow[] =>
				formatOverlayRows(records, now, (id) => {
					const mi = records.find((r) => r.id === id)?.modelInfo;
					return mi ? providerNames.get(mi.provider) : undefined;
				});
			let items = buildItems(Date.now());

			type Stage = "list" | "actions" | "input" | "confirm";
			let stage: Stage = "list";
			let selected: WorkerRecord | null = null;
			let currentAction: WorkerAction | null = null;
			let list: RowList;

			const input = new Input();
			input.focused = true;

			// 打开期间 1s 重建投影:行内容随状态迁移刷新(选中行 details 同步);
			// execute 的 catch 兜底保留(防崩溃),tick 防误导。
			const tick = setInterval(() => {
				items = buildItems(Date.now());
				tui.requestRender();
			}, 1000);
			const close = (): void => {
				clearInterval(tick);
				done(null);
			};

			const renderLine = (line: OverlayLine, isSelected: boolean, li: number): string => {
				const isMain = li === 0;
				// Claude 续行层级:首个副行 ⎿,后续副行对齐;主行选中 → 前缀
				const prefix = (isSelected && isMain ? "→ " : "  ") + (li === 1 ? "⎿ " : li > 1 ? "  " : "");
				const color = line.color as ThemeColor;
				const styled = isMain ? theme.fg(color, theme.bold(line.text)) : theme.fg(color, line.text);
				return prefix + styled;
			};

			const border = new DynamicBorder((s: string) => theme.fg("accent", s));

			const renderAll = (width: number): string[] => {
				const out: string[] = [];
				out.push(...border.render(width));
				out.push(padTo(theme.fg("accent", theme.bold("worker 决策队列")), width));
				if (stage === "list") {
					out.push(...list.render());
					out.push(padTo(theme.fg("dim", "↑↓ 选择 · enter 动作 · esc 关闭"), width));
				} else if (stage === "actions") {
					out.push(padTo(theme.fg("muted", `决策对象:${displayNameOf(selected!.id)}`), width));
					out.push(...list.render());
					out.push(padTo(theme.fg("dim", "↑↓ 选择 · enter 执行 · esc 返回"), width));
				} else if (stage === "confirm") {
					out.push(
						padTo(
							theme.fg("warning", theme.bold(`确认${currentAction?.label ?? ""} ${displayNameOf(selected!.id)}?`)),
							width,
						),
					);
					out.push(padTo(theme.fg("dim", "⚠ 不可逆操作 · enter 确认执行 · esc 取消"), width));
				} else {
					out.push(padTo(theme.fg("warning", currentAction?.inputPrompt ?? "输入:"), width));
					out.push(...input.render(width));
					out.push(padTo(theme.fg("dim", "enter 提交 · esc 返回"), width));
				}
				out.push(...border.render(width));
				return out;
			};

			const execute = async (action: WorkerAction, inputValue: string | undefined): Promise<void> => {
				try {
					const op = opFor(action, selected!.id, inputValue);
					if (op.kind === "inject") {
						// 归因:修合约/重派需要父 agent 判断;user message 落 session 即审计
						pi.sendUserMessage(op.text, { deliverAs: "steer" });
						ctx.ui.notify(`已处理:${op.text}`, "info");
					} else {
						// 判决/消息/机械:直调 manager(有 settled/failed 回调兜底,世界模型不破)
						if (op.kind === "stop") await manager.stop(selected!.id);
						else if (op.kind === "kill") await manager.kill(selected!.id);
						else if (op.kind === "collect") manager.collect(selected!.id);
						else if (op.kind === "message") {
							const result = await manager.bus.post("parent", selected!.id, op.message);
							if (!result.ok) throw new WorkerError(result.reason);
						}
						pi.sendMessage({
							customType: "pi-worker",
							content: op.audit,
							display: true,
							details: { type: "action-done", id: selected!.id },
						});
						ctx.ui.notify(`已处理:${op.audit}`, "info");
					}
					close();
				} catch (e) {
					// 状态过期(overlay 打开期间 worker 已迁移):记录是活引用,重建投影回列表,
					// 不崩溃不静默。
					ctx.ui.notify(`${action.label} 失败:${e instanceof Error ? e.message : String(e)}`, "error");
					items = buildItems(Date.now());
					toListStage();
				}
			};

			const toListStage = (): void => {
				stage = "list";
				list = new RowList(items, renderLine, (value) => {
					selected = records.find((r) => r.id === value) ?? null;
					if (!selected) return;
					const actions = actionsFor(selected);
					stage = "actions";
					list = new RowList(actionRows(actions), renderLine, (value) => {
						currentAction = actions.find((a) => a.value === value) ?? null;
						if (!currentAction) return;
						if (currentAction.irreversible) {
							stage = "confirm";
							tui.requestRender();
						} else if (currentAction.needsInput) {
							input.setValue("");
							stage = "input";
							tui.requestRender();
						} else {
							execute(currentAction, undefined);
						}
					}, () => toListStage());
					tui.requestRender();
				}, () => close(), {
					showSections: true,
					renderSection: (s) => {
						const n = items.filter((r) => r.section === s).length;
						return theme.fg("dim", s === "decision" ? `── 待决策 (${n})` : `── 工作中 (${n})`);
					},
				});
				tui.requestRender();
			};

			input.onSubmit = (value) => {
				if (currentAction) execute(currentAction, value);
			};
			input.onEscape = () => {
				stage = "actions";
				tui.requestRender();
			};

			toListStage();

			return {
				render: (w) => renderAll(w),
				invalidate: () => {},
				// Focusable 传播:input stage 需要 IME 候选窗对齐
				get focused() {
					return stage === "input";
				},
				set focused(v: boolean) {
					input.focused = v;
				},
				handleInput: (data) => {
					const kb = getKeybindings();
					if (stage === "confirm") {
						if (kb.matches(data, "tui.select.confirm") && currentAction) {
							execute(currentAction, undefined);
						} else if (kb.matches(data, "tui.select.cancel")) {
							stage = "actions";
							tui.requestRender();
						}
					} else if (stage === "input") {
						input.handleInput(data);
					} else {
						list.handleInput(data);
					}
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-center",
				width: "60%", // modal 面板不满宽:列对齐 + 预览窗格信息密度足够,稀释焦点
				maxHeight: "80%",
				margin: 0,
			},
		},
	);
}
