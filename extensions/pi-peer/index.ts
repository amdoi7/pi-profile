import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WindowQuota } from "../_shared/window-quota.ts";
import { peersRoot, registerSelf, unregisterSelf, type PeerInfo } from "./src/registry.ts";
import { socketPathFor, startPeerServer, type PeerServer } from "./src/transport.ts";
import { buildInjectedContent, PEER_SEND_QUOTA, registerPeerTool, type PeerRuntime } from "./src/tool.ts";

/**
 * pi-peer:同机 pi 会话互发纯文本消息。三层各一职,无 tick 无队列模拟:
 * - registry(rendezvous):session_start 注册原子落盘、shutdown 注销;活性 = 读时探 socket;
 * - transport(socket 窄协议):投递→注入→ack 同步往返,fail-fast(连接拒绝 = 对方已死);
 * - 注入:收信 handler 直接 pi.sendMessage(ack 在其后,成功即已送达)。
 * 名册发现归 pi_peer 工具 description(L2):先 action=list 发现在线 peer 再 send。
 */

export default function (pi: ExtensionAPI): void {
	const quota = new WindowQuota(PEER_SEND_QUOTA);
	let rt: PeerRuntime | undefined;
	let server: PeerServer | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// 换 session(/new/resume)换 socket:旧注册文件随探测清扫,不手动迁
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
		// 收信服务:注入成功才 ack(= 已送达);handler 抛错 → 发送方收到「对方拒绝接收: <原因>」
		server = await startPeerServer(self.socketPath, async (msg) => {
			pi.sendMessage(
				{
					customType: "pi-peer",
					display: true,
					content: buildInjectedContent(msg),
					details: { from: msg.from, mode: msg.mode, ts: msg.ts },
				},
				// 投递模式与 worker message 同词汇:steer = 对方运行中注入当前轮(turn 间隙
				// 生效),followUp = 当前轮后投递再唤醒;quiet = 只留痕不唤醒
				msg.mode === "quiet"
					? undefined
					: { deliverAs: msg.mode === "steer" ? "steer" : "followUp", triggerTurn: true },
			);
		});
		if (server.serving) {
			registerSelf(rt.root, self);
		} else if (ctx.hasUI) {
			// 同 sessionId 已有活进程在服务(resume 撞车):退让不注册,发送能力不受影响
			ctx.ui.notify("pi-peer: 本会话已有另一进程在线,收信已退让(发送不受影响)", "warning");
		}
	});

	// 名册发现归 pi_peer 工具 description:先 list 再 send,无系统提示注入

	pi.on("session_shutdown", () => {
		const wasServing = server?.serving === true;
		server?.close();
		server = undefined;
		if (rt && wasServing) unregisterSelf(rt.root, rt.self.sessionId);
		rt = undefined;
	});

	registerPeerTool(pi, () => rt);
}
