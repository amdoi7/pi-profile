import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatLifecycle, type LifecycleEntryData } from "./present.ts";
import type { WorkerRecord } from "./types.ts";

/**
 * transcript 生命周期 block:grok subagent scrollback block 的对等物。
 * 数据面:run 成功时 appendEntry 一条(TUI-only,不进 LLM 上下文——
 * LLM 已由 run 回执与 settled/failed 回调覆盖,block 是纯显示态)。
 * 显示面:EntryRenderer 返回的组件每次 render 重读 manager 活记录
 * (pi-tui 每帧走树调 render,无树级缓存;重绘由 footer 刷新路径
 * onChange + 1s liveTick 触发),实现 grok 式原位更新,不依赖消息编辑 API。
 */

/** entry customType:与回调消息的 "pi-worker"(registerMessageRenderer)分属两个注册表,不冲突。 */
export const LIFECYCLE_ENTRY_TYPE = "pi-worker-lifecycle";

interface StatusSource {
	status: () => WorkerRecord | WorkerRecord[];
}

/** run 成功追加生命周期 entry;数据是记录消失(collect)后静态回退渲染的最小集。 */
export function appendLifecycleEntry(pi: Pick<ExtensionAPI, "appendEntry">, rec: WorkerRecord, prompt: string): void {
	pi.appendEntry(LIFECYCLE_ENTRY_TYPE, {
		id: rec.id,
		name: rec.name,
		prompt,
		createdAt: rec.createdAt,
	} satisfies LifecycleEntryData);
}

/**
 * 生命周期 block 组件。collapsed 单行(图标 + name + 引号 prompt + elapsed + 活动);
 * expanded(ctrl+o 全局展开)追加 details(模型/sessionFile/recent 尾)。
 * 活性不变式:render 不缓存——状态迁移后下一帧即反映,无需 invalidate 外部触发。
 */
export class LifecycleBlockComponent {
	constructor(
		private readonly manager: StatusSource,
		private readonly data: LifecycleEntryData,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		const all = this.manager.status();
		const rec = (Array.isArray(all) ? all : [all]).find((r) => r.id === this.data.id);
		const view = formatLifecycle(rec, this.data, Date.now());
		const line = `${this.theme.fg(view.iconColor, view.icon)} ${this.theme.fg(view.textColor, view.text)}`;
		const lines = [truncateToWidth(line, width)];
		if (this.expanded) {
			for (const d of view.details) {
				lines.push(truncateToWidth(`  ⎿ ${this.theme.fg(d.color, d.text)}`, width));
			}
		}
		return lines;
	}

	invalidate(): void {}
}

/** 注册 entry renderer;data 缺损(历史 session/手改 jsonl)不渲染,不抛错。 */
export function registerLifecycleRenderer(pi: ExtensionAPI, manager: StatusSource): void {
	pi.registerEntryRenderer(LIFECYCLE_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as LifecycleEntryData | undefined;
		if (!data || typeof data.id !== "string" || typeof data.name !== "string") return undefined;
		return new LifecycleBlockComponent(
			manager,
			{
				id: data.id,
				name: data.name,
				prompt: typeof data.prompt === "string" ? data.prompt : "",
				createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
			},
			theme,
			expanded,
		);
	});
}
