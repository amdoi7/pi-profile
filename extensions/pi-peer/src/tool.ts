import { statSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WindowQuota } from "./quota.ts";
import { discoverPeers, resolvePeer } from "./roster.ts";
import { sendPeerMessage, socketPathFor, type PeerIdentity, type PeerMessage } from "./transport.ts";

/** 发送配额配置(判定内核见 quota.ts;mode=quiet 旁路在 execute):超限/重复的文案归本工具。 */
export const PEER_SEND_QUOTA = { max: 10, windowMs: 300_000, repeatWindowMs: 60_000 };

export interface PeerRuntime {
	self: PeerIdentity;
	quota: WindowQuota;
}

const piPeerParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("send")], {
		description: "list=discover online sessions; send=deliver a message",
	}),
	to: Type.Optional(Type.String({ description: "target session name or sessionId (prefix ok); required for action=send" })),
	text: Type.Optional(Type.String({ description: "message text (plain text, exactly what the peer sees); required for action=send" })),
	// 投递模式:枚举值即语义(与 pi 内核 deliverAs 同词);prose 只写缺省,不重复枚举
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("quiet")],
			{ description: "send delivery mode; default followUp (deliver after peer's current turn, then wake)" },
		),
	),
});

type Params = Static<typeof piPeerParams>;

/** details 联合统一:list 带 peerCount,send 带 to/mode(两处返回形状一致,tsc 推断不分裂)。
 * 名册全文只在 content.text,不复制进 details(双份 token)。 */
interface PeerToolDetails {
	peerCount?: number;
	to?: string;
	mode?: "followUp" | "steer" | "quiet";
}

/** 决策优先的一行一个 peer;[same-dir] 帮 LLM 优先挑同 repo 会话,idle 帮它跳过
 * 弃用会话(窗口还开着但人已离开的会话在线活性正常,只有闲置时长能暴露它)。 */
export function formatPeerLine(p: PeerIdentity, selfCwd: string, idleMs?: number): string {
	const same = p.cwd === selfCwd ? " [same-dir]" : "";
	const idle = idleMs !== undefined ? ` idle=${humanizeIdle(idleMs)}` : "";
	return `- ${p.name ?? "(unnamed)"} id=${p.sessionId.slice(0, 8)} cwd=${p.cwd}${p.sessionFile ? ` session=${p.sessionFile}` : ""}${idle}${same}`;
}

export function humanizeIdle(ms: number): string {
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** 闲置时长 = session jsonl 自上次写入的时间差(同机可直读);无文件/不可读不标。 */
function idleOf(p: PeerIdentity, now: number): number | undefined {
	if (!p.sessionFile) return undefined;
	try {
		return Math.max(0, now - statSync(p.sessionFile).mtimeMs);
	} catch {
		return undefined;
	}
}

export function registerPeerTool(pi: ExtensionAPI, getRt: () => PeerRuntime | undefined): void {
	pi.registerTool({
		name: "pi_peer",
		label: "Peer",
		description:
			"Message other pi sessions on this machine (Claude cross-session peers): action=list discovers online sessions (the entry point — always list first) — " +
			"send delivers asynchronously — success means the peer accepted the message for delivery into its session (injection happens there; a delivery failure returns as a peer-message receipt; failures fail loudly: offline/rejected/timeout); text states who you are, what you want, relevant paths; " +
			"mode selects delivery (enum is semantics, same words as pi's deliverAs; default followUp). " +
			"Quota: 10 msgs per 5min per pair; identical text within 60s is dropped; mode=quiet does not count. " +
			"Replies (if any) return as peer messages to this session. No injected roster — action=list to discover online peers first, address by name/sessionId prefix; prefer low idle= peers (high idle = likely abandoned).",
		promptSnippet: "Message other online pi sessions (list/send)",
		parameters: piPeerParams,
		async execute(_toolCallId: string, p: Params, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<PeerToolDetails>> {
			const rt = getRt();
			if (!rt) throw new Error("pi_peer not ready (session not started); retry later");
			const now = Date.now();
			if (p.action === "list") {
				const { alive, mute } = await discoverPeers(rt.self.sessionId);
				const lines = alive.map((peer) => formatPeerLine(peer, ctx.cwd, idleOf(peer, now)));
				const head = lines.length > 0 ? `Online pi sessions (${lines.length}):` : "No other online pi sessions.";
				const tail = mute > 0 ? `\n(${mute} unresponsive sockets skipped)` : "";
				return {
					content: [{ type: "text", text: head + (lines.length > 0 ? `\n${lines.join("\n")}` : "") + tail }],
					details: { peerCount: alive.length },
				};
			}
			// send
			if (!p.to?.trim()) throw new Error("missing to; action=send needs a target session name/sessionId");
			if (!p.text?.trim()) throw new Error("missing text; action=send needs a message");
			const to = p.to.trim();
			// 自己被 discoverPeers 排除在 resolve 面外,先按 name/id 撞库自投,给明确错误
			if (to === rt.self.name || to === rt.self.sessionId || rt.self.sessionId.startsWith(to)) {
				throw new Error("cannot send to yourself (same session)");
			}
			const { alive } = await discoverPeers(rt.self.sessionId);
			const target = resolvePeer(alive, to, ctx.cwd);
			if (!target.ok) throw new Error(target.reason);
			if (p.mode !== "quiet") {
				// quiet 不占配额(不烧对方轮次)
				const v = rt.quota.check(`${rt.self.sessionId}→${target.peer.sessionId}`, p.text.trim(), now);
				if (!v.ok) {
					throw new Error(
						v.kind === "repeat"
							? `duplicate message (same text within ${PEER_SEND_QUOTA.repeatWindowMs / 1000}s), dropped`
							: `send quota exceeded (${PEER_SEND_QUOTA.max}/${PEER_SEND_QUOTA.windowMs / 60000}min); retry later or use mode=quiet for silent record`,
					);
				}
			}
			const msg: PeerMessage = {
				from: { sessionId: rt.self.sessionId, name: rt.self.name, cwd: rt.self.cwd },
				text: p.text.trim(),
				mode: p.mode ?? "followUp",
				ts: now,
			};
			// 同步投递:成功返回 = 对方进程已接管(排队注入);不可达/被拒/超时抛错显形
			await sendPeerMessage(socketPathFor(target.peer.sessionId), msg);
			if (p.mode !== "quiet") {
				// 送达成功才记账:失败尝试不烧配额、不刷新同文基线,重试可放行
				rt.quota.commit(`${rt.self.sessionId}→${target.peer.sessionId}`, msg.text, now);
			}
			return {
				content: [
					{
						type: "text",
						text: `accepted by ${target.peer.name ?? target.peer.sessionId.slice(0, 8)} (${p.mode === "quiet" ? "silent, no wake" : p.mode === "steer" ? "injected into current turn, no queue" : "peer woken"}); injection is asynchronous — a delivery failure returns as a peer-message receipt; reply (if any) returns as a peer message.`,
					},
				],
				details: { to: target.peer.sessionId, mode: p.mode ?? "followUp" },
			};
		},
	});
}
