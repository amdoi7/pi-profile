import { isatty } from "node:tty";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { buildInjectedContent, formatPeerCard } from "./src/messages.ts";
import { WindowQuota } from "./src/quota.ts";
import { startReconciler, type Reconciler } from "./src/reconciler.ts";
import { PEER_SEND_QUOTA, registerPeerTool, type PeerRuntime } from "./src/tool.ts";
import { sendPeerMessage, socketPathFor, startPeerServer, type PeerIdentity, type PeerMessage, type PeerServer } from "./src/transport.ts";

/**
 * pi-peer:同机 pi 会话互发消息。
 * 发送面 = pi_peer 工具(src/tool.ts);接收与身份面 = 每会话一个 unix socket
 * (src/transport.ts:deliver + who),socket 目录即名册(src/roster.ts),
 * 零磁盘缓存;在场性由 reconciler(src/reconciler.ts)维持:接管重试 + 退役门。
 */
export default function (pi: ExtensionAPI): void {
	const quota = new WindowQuota(PEER_SEND_QUOTA);
	let rt: PeerRuntime | undefined;
	let server: PeerServer | undefined;
	let rec: Reconciler | undefined;

	registerPeerTool(pi, () => rt);

	// 收件卡片:人面只要来源行 + 原文(安全声明是 LLM 面契约,留在 content 不上屏)
	pi.registerMessageRenderer("pi-peer", (message, { outputPad }, theme) => {
		const view = formatPeerCard((message as { details?: unknown }).details);
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg(view.tone, theme.bold(view.header)), 0, 0));
		if (view.body) box.addChild(new Markdown(view.body, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.on("session_start", async (_event, ctx) => {
		const sm = ctx.sessionManager;
		const sessionId = sm.getSessionId();
		const startedAt = Date.now();
		const socketPath = socketPathFor(sessionId);
		// 身份每次实时求值(who 应答与发送方 from 均新鲜,改名即时可见)
		const identity = (): PeerIdentity => ({
			sessionId,
			name: sm.getSessionName() ?? undefined,
			cwd: ctx.cwd,
			sessionFile: sm.getSessionFile() ?? undefined,
			startedAt,
		});
		rt = { self: identity(), quota };
		// 终端脱离判定基准:只认「运行中发生的脱离事件」,启动即 headless(rpc/print/
		// nohup)的会话不退役。两个信号任一命中:父死被 launchd 收养(ppid→1,
		// tmux detach 不命中——父是 tmux server);pty 被吊销(isatty 翻 false)。
		const startPpid = process.ppid;
		const hadTTY = process.stdout.isTTY === true;
		const detached = (): boolean =>
			(startPpid !== 1 && process.ppid === 1) || (hadTTY && !isatty(1));

		const deliver = async (msg: PeerMessage): Promise<void> => {
			// quiet = 留痕不唤醒;followUp/steer 直译内核 deliverAs
			const opts = msg.mode === "quiet" ? undefined : ({ deliverAs: msg.mode, triggerTurn: true } as const);
			void Promise.resolve(
				pi.sendMessage(
					{
						customType: "pi-peer",
						display: true,
						content: buildInjectedContent(msg),
						// text 单独入 details:渲染卡片直取原文,不从 content 剥安全声明
						details: { from: msg.from, mode: msg.mode, ts: msg.ts, text: msg.text },
					},
					opts,
				),
			).catch((e: unknown) => {
				// ack 后异步注入失败:回执显形给发送方(quiet,不烧对方轮次)。
				// socket 路径是 sessionId 的纯函数,回执地址直接 derive;失败即放弃(best-effort)
				void sendPeerMessage(socketPathFor(msg.from.sessionId), {
					from: { sessionId, name: sm.getSessionName() ?? undefined, cwd: ctx.cwd },
					text: `delivery failure report: ${e instanceof Error ? e.message : String(e)}; not injected: ${msg.text.slice(0, 200)}`,
					mode: "quiet",
					ts: Date.now(),
				}).catch(() => {});
			});
		};

		let warnedError = false;
		rec = await startReconciler({
			tryServe: async () => {
				const srv = await startPeerServer(socketPath, { who: () => { const self = identity(); if (rt) rt.self = self; return self; }, deliver });
				if (srv.serving) server = srv;
				return srv.serving;
			},
			onYield: () => {
				if (ctx.hasUI) ctx.ui.notify("pi-peer: 本会话已有另一进程在线收信,已退让并周期重试接管(发送不受影响)", "warning");
			},
			shouldRetire: detached,
			onRetire: (wasServing) => {
				// 退役 = 退出 peer 平面(释放 socket),让位给 resume 的真会话;进程本体不动
				if (wasServing) server?.close();
				server = undefined;
			},
			onError: (e) => {
				if (warnedError || !ctx.hasUI) return;
				warnedError = true;
				ctx.ui.notify(`pi-peer: 收信接管失败(周期重试中): ${e instanceof Error ? e.message : String(e)}`, "warning");
			},
		});
	});

	pi.on("session_shutdown", () => {
		rec?.stop();
		server?.close(); // close 即 unlink socket = 从名册消失,一步完成
		rec = undefined;
		server = undefined;
		rt = undefined;
	});
}
