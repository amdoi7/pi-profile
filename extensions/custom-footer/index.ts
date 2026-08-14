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
	// （本轮时长是 1s 粒度，更高的渲染频率零收益）；commit（消息/轮完成）
	// 与配置变化立即 flush。调度由下方数据源 onChange hook 驱动。
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

	// 进行中每秒 tick：事件驱动（message_update）之外兜底——纯 thinking 期
	// （首块未到）与工具执行期无事件，实时值（本轮 Xs）会停摆；tick 保证
	// 有进行中的轮时每秒刷新。agent_start 启动、agent_settled 停止。
	let liveTick: ReturnType<typeof setInterval> | undefined;
	const startLiveTick = () => {
		if (liveTick) return;
		liveTick = setInterval(() => footerTui?.requestRender(), 1000);
	};
	const stopLiveTick = () => {
		if (liveTick) clearInterval(liveTick);
		liveTick = undefined;
	};

	// 渲染 hook 集中调度：数据源变化时通知，事件处理器只更新数据不碰渲染。
	// tps：live（流式/等待期）节流，commit（消息/轮完成）立即。
	readTps.onChange((change) => {
		if (change === "commit") flushRender();
		else scheduleRender();
	});
	// 会话聚合（flow/cost/waste）变化 → 立即（消息完成/entries 重建）。
	readStats.onChange(() => flushRender());

	on(pi, "thinking_level_select", () => flushRender(), ["tui"]);

	// 模型切换：hook 即时刷新，不等 30s 轮询兜底。
	on(pi, "model_select", () => flushRender(), ["tui"]);

	on(pi, "agent_start", async (_event, ctx) => {
		// 轮级：本轮（用户发送消息 → 不再输出）起点，agent_start 在用户消息提交时触发，
		// retry/compaction 后的 continue 会再次触发，tracker 内幂等（不重置起点）。
		// 渲染由 tps onChange hook 驱动；每秒 tick 保证无事件期实时值刷新。
		readTps.onAgentStart(ctx.sessionManager.getCwd());
		startLiveTick();
	}, ["tui"]);

	on(pi, "agent_settled", async (_event, ctx) => {
		readTps.onAgentSettled(ctx.sessionManager.getCwd());
		stopLiveTick();
	}, ["tui"]);

	on(pi, "agent_end", async (event, ctx) => {
		// tps 批量源（锁定值）：一次累加本 run 段全部 assistant 消息的 usage.output。
		// 官方消息源——失败/aborted 消息无 message_end（agent-loop 错误路径直接
		// emit agent_end），增量源漏计，批量源不依赖事件流完整性。
		readTps.onAgentEnd(ctx.sessionManager.getCwd(), event.messages);
	}, ["tui"]);

	on(pi, "turn_start", async (_event, ctx) => {
		// turn 级（每条 LLM 响应）：本条消息的 TTFB 起点。
		// 边界：初始 turn_start 配消息1（用户消息 → 首块 = 用户首字等待）；
		// toolResult/user 消息无 turn_start，不会污染配对。
		readTps.onTurnStart(ctx.sessionManager.getCwd());
	}, ["tui"]);

	on(pi, "message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		// message 级：本条消息首块（TTFB 点 + 流式起点）。幂等；
		// message_end 后重置，无输出消息不污染下一条。
		readTps.onFirstChunk(ctx.sessionManager.getCwd());
	}, ["tui"]);

	on(pi, "message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const m = event.message as AssistantMessage;
		// message 级：本条消息完成——速率/ttfb 计算（tps 分子含 thinking）。
		// user/toolResult 消息也触发 message_end，被 role 过滤。
		readTps.onMessageEnd(ctx.sessionManager.getCwd(), m.usage?.output ?? 0);
		// 会话聚合增量（O(1)）：flow/cost/cache-waste 只在消息完成时变化。
		readStats.addMessage(m, {
			find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		});
	}, ["tui"]);

	on(pi, "session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "new") {
			sessionStart = Date.now();
		}

		// 会话装载/切换：entries 就绪，全量重建聚合快照。
		rebuildStats(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const unsub = footerData.onBranchChange(() => flushRender());
			// 外部 git 变化（其他终端改文件、merge 冲突等）→ 即时重渲染；
			// watch 不可用时静默降级，30s 轮询兜底。
			const stopWatchingGit = watchGitChanges(ctx.sessionManager.getCwd(), () =>
				flushRender(),
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
					if (updated) flushRender();
				});
				tui.requestRender();
			}, 30000);

			return {
				dispose() {
					footerTui = null;
					unsub();
					stopWatchingGit();
					clearInterval(timer);
					stopLiveTick();
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
						// 新轮清零后 last* 恒为轮内最近完成消息的值（进行中/完成态同源，无混搭）。
						tps: readTps.getLast(cwd),
						ttfbMs: readTps.getLastTtfbMs(cwd),
						// 进行中：该轮经过时间（每秒增长）；完成态：最近一轮总时长。
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
	}, ["tui"]);

	// session_tree（/tree 导航）与 session_compact（自动/手动压缩）都会替换
	// entries 且无 message_end 增量信号——全量重建（pi 在两者触发时 entries 已更新）；
	// 渲染由 readStats 的 onChange hook 驱动（rebuild 内部 notify）。
	on(pi, "session_tree", async (_event, ctx) => {
		rebuildStats(ctx);
	}, ["tui"]);

	on(pi, "session_compact", async (_event, ctx) => {
		rebuildStats(ctx);
	}, ["tui"]);

	function rebuildStats(ctx: ExtensionContext) {
		readStats.rebuild(ctx.sessionManager.getEntries(), {
			find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		});
	}
}
