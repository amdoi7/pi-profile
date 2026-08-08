/**
 * Custom Footer Extension - Enhanced status bar
 *
 * Displays: ctx used, ctx %, cost, cwd, git branch, provider/model
 * Color semantics: meters fire signal colors only past healthy thresholds
 * (ctx: green <70 / amber 70-84 / red >=85; quota bars: green <50 / neutral
 * 50-69 / amber 70-89 / red >=90). The thinking level label echoes the
 * editor border's thinking* tokens; extension statuses use customMessageLabel.
 * Cost always renders from session usage (usage.cost.total, 0 when the model
 * has no price table); the quota line (usage windows / balance) renders only
 * for the subscription providers (anthropic / openai-codex / kimi-coding).
 *
 * Ownership: lifecycle + data access live here; presentation (formatting,
 * layout) lives in custom-footer-format.ts and is unit-tested there.
 */

import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { on } from "../_shared/mode-gate.ts";
import { createGitStatusCache, createGitWatcher } from "./custom-footer-git.ts";
import { createTpsTracker } from "./custom-footer-tps.ts";
import { createSessionStats } from "./custom-footer-stats.ts";
import {
	extensionStatusLines,
	formatCwd,
	formatGitSegment,
	formatModel,
	formatSessionRow,
	formatUsageLine,
	layoutFooter,
} from "./custom-footer-format.ts";
import {
	createUsageFetcher,
	detectUsageProvider,
	type ProviderUsageFetcher,
	type UsageProviderName,
} from "./custom-footer-usage.ts";

export default function (pi: ExtensionAPI) {
	let sessionStart = Date.now();
	let footerTui: TUI | null = null;
	const readGitStatus = createGitStatusCache();
	const watchGitChanges = createGitWatcher();
	const readTps = createTpsTracker();
	// 会话聚合（flow/cost/waste）快照：message_end 增量 O(1)，entries 替换
	// （session_start / session_tree / session_compact）全量重建；render 只读。
	const readStats = createSessionStats();

	// 统一渲染调度：流式期间（message_update 每 token 块）节流到 1s 一次
	// （本轮时长是 1s 粒度，更高的渲染频率零收益）；消息/轮完成或配置变化立即 flush。
	let renderPending = false;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleRender = () => {
		if (renderPending) return;
		renderPending = true;
		renderTimer = setTimeout(() => {
			renderPending = false;
			footerTui?.requestRender();
		}, 1000);
	};
	const flushRender = () => {
		if (renderTimer) clearTimeout(renderTimer);
		renderTimer = undefined;
		renderPending = false;
		footerTui?.requestRender();
	};

	on(pi, "thinking_level_select", () => flushRender(), ["tui"]);

	// 模型切换：hook 即时刷新，不等 30s 轮询兜底。
	on(pi, "model_select", () => flushRender(), ["tui"]);

	on(pi, "turn_start", async (event, ctx) => {
		// 本轮经过时间的起点（React 模式一轮含多次消息/思考，轮级时长是用户体感）；
		// 同时是 TTFB 起点：pi 在 LLM 请求发出前同步触发此事件（message_start 在
		// 响应头到达时才触发，与首块同批毫秒级，作起点测得恒 0）。
		readTps.onTurnStart(ctx.sessionManager.getCwd());
		scheduleRender();
	}, ["tui"]);

	on(pi, "turn_end", async (event, ctx) => {
		readTps.onTurnEnd(ctx.sessionManager.getCwd());
		// 一轮完成：立即渲染本轮总时长（固定值，实时已失效）。
		flushRender();
	}, ["tui"]);

	on(pi, "message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		// 响应流开始（非 TTFB 起点：事件在响应头到达时才触发，见 turn_start 注释）。
		readTps.onMessageStart(ctx.sessionManager.getCwd());
	}, ["tui"]);

	on(pi, "message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		// TTFB 点：首个响应块到达（幂等，后续块不重置）。
		readTps.onFirstChunk(ctx.sessionManager.getCwd());
		scheduleRender();
	}, ["tui"]);

	on(pi, "message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const m = event.message as AssistantMessage;
		readTps.onMessageEnd(ctx.sessionManager.getCwd(), m.usage?.output ?? 0);
		// 会话聚合增量（O(1)）：flow/cost/cache-waste 只在消息完成时变化。
		readStats.addMessage(m, {
			find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		});
		// 完成时刻立即渲染最终值（不等节流）。
		flushRender();
	}, ["tui"]);

	on(pi, "session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "new") {
			sessionStart = Date.now();
		}

		// 会话装载/切换：entries 就绪，全量重建聚合快照。
		rebuildStats(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// 外部 git 变化（其他终端改文件、merge 冲突等）→ 即时重渲染；
			// watch 不可用时静默降级，30s 轮询兜底。
			const stopWatchingGit = watchGitChanges(ctx.sessionManager.getCwd(), () =>
				tui.requestRender(),
			);
			let usageProvider: UsageProviderName = null;
			let usageFetcher: ProviderUsageFetcher | null = null;
			// The usage line follows the current model's provider: only subscription
			// providers (claude/codex/kimi) show it; pay-as-you-go providers (e.g.
			// deepseek) hide it even when other accounts have credentials.
			const ensureUsageFetcher = (provider: UsageProviderName): ProviderUsageFetcher | null => {
				if (provider !== usageProvider) {
					usageProvider = provider;
					usageFetcher = createUsageFetcher(provider);
				}
				return usageFetcher;
			};
			// 30s 轮询：usage 窗口 TTL 刷新 + 配额 elapsed 文本推进 + git 兜底。
			// refresh 由 TTL/backoff 内部节流，不在 render 路径发网络请求。
			const timer = setInterval(() => {
				const fetcher = ensureUsageFetcher(detectUsageProvider(ctx.model?.provider));
				void fetcher?.refresh().then((updated) => {
					if (updated) tui.requestRender();
				});
				tui.requestRender();
			}, 30000);

			return {
				dispose() {
					footerTui = null;
					unsub();
					stopWatchingGit();
					clearInterval(timer);
					// 清理节流渲染 timer（防止 session 切换后幽灵触发）。
					if (renderTimer) clearTimeout(renderTimer);
					renderTimer = undefined;
					renderPending = false;
				},
				invalidate() {},
				render(width: number): string[] {
					const cwd = ctx.sessionManager.getCwd();
					const usage = ctx.getContextUsage();
					const model = ctx.model;
					const providerName = model
						? ctx.modelRegistry?.getProviderDisplayName(model.provider) ?? model.id
						: "no-model";
					const thinking = pi.getThinkingLevel();
					const segments = {
						model: formatModel(theme, providerName, model?.id, thinking),
						providerOnly: formatModel(theme, providerName, undefined, thinking),
						cwd: formatCwd(theme, cwd, homedir()),
						branch: formatGitSegment(theme, readGitStatus(cwd)),
					};
					const usageProvider = detectUsageProvider(model?.provider);
					const snapshot = readStats.getSnapshot();
					const sessionRow = formatSessionRow(theme, {
						used: usage?.tokens,
						pct: usage?.percent,
						contextWindow: usage?.contextWindow,
						cost: snapshot.cost,
						tps: readTps.getLast(cwd),
						ttfbMs: readTps.getLastTtfbMs(cwd),
						// 进行中：该 turn 的经过时间（每秒增长）；完成态：最近一轮总时长。
						currentElapsedMs: readTps.getCurrentElapsedMs(cwd),
						turnMs: readTps.getLastTurnMs(cwd),
						flow: snapshot.flow,
						waste: snapshot.waste.missCount > 0 ? snapshot.waste : null,
					});

					const fetcher = ensureUsageFetcher(usageProvider);
					const usageSnapshot = fetcher?.getSnapshot() ?? null;
					const usageLine = usageSnapshot ? formatUsageLine(theme, usageSnapshot, Date.now()) : null;

					const lines = layoutFooter(
						width,
						segments,
						sessionRow,
						usageLine,
						theme.fg("muted", " │ "),
					).map((line) => truncateToWidth(line, width));

					for (const line of extensionStatusLines(footerData.getExtensionStatuses())) {
						lines.push(truncateToWidth(theme.fg("customMessageLabel", line), width));
					}
					return lines;
				},
			};
		});
	});

	// session_tree（/tree 导航）与 session_compact（自动/手动压缩）都会替换
	// entries 且无 message_end 增量信号——全量重建（pi 在两者触发时 entries 已更新）。
	on(pi, "session_tree", async (_event, ctx) => {
		rebuildStats(ctx);
		flushRender();
	}, ["tui"]);

	on(pi, "session_compact", async (_event, ctx) => {
		rebuildStats(ctx);
		flushRender();
	}, ["tui"]);

	function rebuildStats(ctx: ExtensionContext) {
		readStats.rebuild(ctx.sessionManager.getEntries(), {
			find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		});
	}
}
