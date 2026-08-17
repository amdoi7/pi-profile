import {
	getMarkdownTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { WindowQuota } from "../_shared/window-quota.ts";
import { registerWorkerMessagingTool } from "./src/messaging.ts";
	import { WorkerManager } from "./src/manager.ts";
import { openWorkerPane, registerWorkerPaneCommand } from "./src/pane.ts";
import { formatCallbackView, formatFooter, toastFor } from "./src/present.ts";
import { peersRoot, registerSelf, unregisterSelf, type PeerInfo } from "./src/registry.ts";
import { registerPiWorkerTool } from "./src/tool.ts";
import { sendPeerMessage, socketPathFor, startPeerServer, type PeerServer } from "./src/transport.ts";
import { buildInjectedContent, PEER_SEND_QUOTA, registerPeerTool, type PeerRuntime } from "./src/peer-tool.ts";
import type { WorkerRecord } from "./src/types.ts";

interface UiLike {
	setStatus: (key: string, text: string | undefined) => void;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

interface ThemeLike {
	fg: (color: "accent" | "warning" | "error" | "dim", text: string) => string;
}

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_WORKER_CHILD === "1") {
		// 子进程:只注册 send_message 通信工具,不注册 dispatch 工具(防递归分发)。
		// 父自身可能是 tui 或 rpc,只能靠环境标记区分。
		registerWorkerMessagingTool(pi);
		return;
	}

	// ui 在 session_start 捕获(setStatus/notify 是 fire-and-forget,不需要事件点 ctx);
	// 状态变化由 manager 的 onChange 钩子推出,不嗅探消息流。
	let ui: UiLike | undefined;
	let theme: ThemeLike | undefined;
	// elapsed/活动心跳需要秒级重绘:有工作态 worker 时开 1s tick,全静即停。
	let liveTick: ReturnType<typeof setInterval> | undefined;

	const refreshFooter = (): void => {
		if (!ui) return;
		const records = manager.status() as WorkerRecord[];
		ui.setStatus(
			"pi-worker",
			formatFooter(records, { now: Date.now(), fg: (c, t) => (theme ? theme.fg(c, t) : t), openHint: "alt+w" }),
		);
		const anyWorking = records.some(
			(r) => r.state === "starting" || r.state === "running" || r.state === "stopping",
		);
		if (anyWorking && !liveTick) {
			liveTick = setInterval(refreshFooter, 1000);
		} else if (!anyWorking && liveTick) {
			clearInterval(liveTick);
			liveTick = undefined;
		}
	};

	const manager = new WorkerManager({
		deliver: (msg, opts) => {
			// quiet = peer 流量审计等安静留痕(不烧父轮次);缺省唤醒(回调/parent-bound 消息)
			if (opts?.quiet) {
				pi.sendMessage({ ...msg, display: true });
			} else {
				pi.sendMessage({ ...msg, display: true }, { deliverAs: "followUp", triggerTurn: true });
			}
			const toast = toastFor(msg);
			if (toast && ui) ui.notify(toast.text, toast.level);
			refreshFooter();
		},
		onChange: () => refreshFooter(),
	});
	registerPiWorkerTool(pi, manager);
	registerWorkerPaneCommand(pi, manager);
	// peer:同机 session 互发消息的 socket 服务
	const quota = new WindowQuota(PEER_SEND_QUOTA);
	let rt: PeerRuntime | undefined;
	let server: PeerServer | undefined;
	// 入口复用:footer 的 /pi-worker 是纯文本,alt+w 是唯一可交互通道(peer chat 入口)。
	// alt+w 未被 pi 默认/编辑器占用(ctrl+w 被编辑器删词占用);键冲突由 runner 诊断。
	pi.registerShortcut("alt+w", {
		description: "打开 worker 决策队列/聊天窗口(与 /pi-worker 命令同路)",
		handler: (ctx) => openWorkerPane(pi, manager, ctx),
	});

	// 回调 renderer:呈报即验收界面。settled 报告全文(核验证据段)不折叠;
	// failed 诊断 + stderr 尾;action 审计(路由/机械动作)dim。
	pi.registerMessageRenderer("pi-worker", (message, { outputPad }, theme) => {
		const view = formatCallbackView(message as never);
		const headColor = view.kind === "failed" ? "error" : view.kind === "action" ? "dim" : "accent";
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg(headColor, theme.bold(view.header)), 0, 0));
		// ⎿ 续行摘要:紧随 header(Claude 保真:回执先于详情,长报告不埋卡底)
		if (view.summary) box.addChild(new Text(theme.fg("dim", `  ${view.summary}`), 0, 0));
		if (view.body) {
			if (view.bodyIsMarkdown) {
				box.addChild(new Markdown(view.body, 0, 0, getMarkdownTheme()));
			} else {
				box.addChild(new Text(theme.fg(view.kind === "failed" ? "error" : view.kind === "action" ? "dim" : "warning", view.body), 0, 0));
			}
		}
		return box;
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		theme = ctx.ui.theme as unknown as ThemeLike;
		// worker:重启认领(父重启后子进程随父死,session jsonl 在磁盘)
		const n = await manager.claimLeftovers(ctx.cwd);
		if (n > 0 && ui) ui.notify(`${n} leftover worker session(s) recovered from disk: send to wake (cold-resume) or collect to clear`, "info");
		refreshFooter();
		// peer:注册 + socket 收信服务(吸收自原 pi-peer/index.ts)
		const sessionId = ctx.sessionManager.getSessionId();
		const self: PeerInfo = {
			v: 2,
			sessionId,
			name: ctx.sessionManager.getSessionName() ?? undefined,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			socketPath: socketPathFor(sessionId),
			startedAt: Date.now(),
		};
		rt = { root: peersRoot(), self, quota };
		server = await startPeerServer(self.socketPath, async (msg) => {
			const opts:
				| { deliverAs: "followUp" | "steer"; triggerTurn: boolean }
				| undefined = msg.mode === "quiet" ? undefined : { deliverAs: msg.mode === "steer" ? "steer" : "followUp", triggerTurn: true };
			void Promise.resolve(
				pi.sendMessage(
					{
						customType: "pi-peer",
						display: true,
						content: buildInjectedContent(msg),
						details: { from: msg.from, mode: msg.mode, ts: msg.ts },
					},
					opts,
				),
			).catch((e: unknown) => {
				void sendPeerMessage(socketPathFor(msg.from.sessionId), {
					from: { sessionId: self.sessionId, name: self.name, cwd: self.cwd },
					text: `delivery failure report: ${e instanceof Error ? e.message : String(e)}; not injected: ${msg.text.slice(0, 200)}`,
					mode: "quiet",
					ts: Date.now(),
				}).catch(() => {});
			});
		});
		if (server.serving) {
			registerSelf(rt.root, self);
		} else if (ctx.hasUI) {
			ctx.ui.notify("pi-peer: 本会话已有另一进程在线,收信已退让(发送不受影响)", "warning");
		}
	});
	pi.on("session_shutdown", () => {
		// peer:关闭 socket 服务 + 注销注册
		const wasServing = server?.serving === true;
		server?.close();
		server = undefined;
		if (rt && wasServing) unregisterSelf(rt.root, rt.self.sessionId);
		rt = undefined;
		// worker:清 UI + killAll
		ui = undefined;
		theme = undefined;
		if (liveTick) {
			clearInterval(liveTick);
			liveTick = undefined;
		}
		manager.killAll();
	});
	registerPeerTool(pi, () => rt);
}
