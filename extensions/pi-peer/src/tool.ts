import { statSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatOutgoingCall } from "./messages.ts";
import { WindowQuota } from "./quota.ts";
import { discoverPeers, resolvePeer } from "./roster.ts";
import { sendPeerMessage, socketPathFor, type PeerIdentity, type PeerMessage } from "./transport.ts";

/** 发送配额配置(判定内核见 quota.ts):超限/重复的文案归本工具。 */
export const PEER_SEND_QUOTA = { max: 10, windowMs: 300_000, repeatWindowMs: 60_000 };

export interface PeerRuntime {
	self: PeerIdentity;
	quota: WindowQuota;
}

/**
 * 发现与投递是两个工具,不是一个 action 参数的两个取值:塞进一个对象时
 * to/text 只能声明成可选,schema 拦不住「send 缺 to」(语料:269 次 send 里 6 次)。
 * 拆开后两边都是全形状——list 零参数无从写错,send 的 to/text 必填即必填。
 */
const listParams = Type.Object({}, { additionalProperties: false });

const sendParams = Type.Object({
	// 广发 = N 次独立投递，不是事务（消息没有 un-send）：谁送到了、谁没送到逐个报。
	to: Type.Array(Type.String(), { minItems: 1 }),
	text: Type.String(),
}, { additionalProperties: false });

type SendParams = Static<typeof sendParams>;

type SendFailure = { target: string; reason: string };

interface PeerToolDetails {
	peerCount?: number;
	/** OS 确证挂起(T/D)的 socket 占位:文件名 + pid。 */
	suspended?: { path: string; pid: number }[];

	/** 实际接收了的会话（已去重）。 */
	to?: string[];
}

/** 一行一个 peer:id 即地址（同目录内不需别的）;idle 帮它跳过弃用会话
 * (窗口还开着但人已离开的会话在线活性正常,只有闲置时长能暴露它);session 是审计指针。 */
export function formatPeerLine(p: PeerIdentity, idleMs?: number): string {
	const idle = idleMs !== undefined ? ` idle=${humanizeIdle(idleMs)}` : "";
	return `- id=${p.sessionId.slice(0, 8)}${idle}${p.sessionFile ? ` session=${p.sessionFile}` : ""}`;
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

/** 挂起占位:文件名 + OS 确证 pid + 可行动下一步(唤醒或移除)。 */
export function describeSuspended(path: string, pid: number): string {
	return `- ${path} suspended pid=${pid} (fg 或 kill -CONT 唤醒;kill 移除)`;
}

/** 无证据占位:直接过滤,不占认知(见 rosterText)。 */

function failureText(failed: SendFailure[]): string {
	return failed.map((f) => `- ${f.target}: ${f.reason}`).join("\n");
}

function rosterText(alive: PeerIdentity[], suspended: { path: string; pid: number }[], now: number): string {
	const lines = alive.map((p) => formatPeerLine(p, idleOf(p, now)));
	const sus = suspended.map((s) => describeSuspended(s.path, s.pid));
	if (lines.length === 0 && sus.length === 0) return "No other online pi sessions.";
	const head = `Online pi sessions (${alive.length}):`;
	return [
		head,
		...lines,
		...(sus.length > 0 ? ["", "Suspended sockets (T/D, pid):", ...sus] : []),
	].join("\n");
}

/** 未知键不能静默忽略:语料里的 { quiet: true } 被当成默认模式投出,模型要的语义
 * 静默丢失。报错说本工具接受什么（模型自己就能把意图映到这些键），而不是只说「删掉」。 */
function rejectUnknownKeys(tool: string, params: object, known: readonly string[]): void {
	const unknown = Object.keys(params).filter((k) => !known.includes(k));
	if (unknown.length === 0) return;
	const accepts = known.length > 0 ? `accepts ${known.join(", ")}` : "takes no parameters";
	throw new Error(`unknown parameter ${unknown.join(", ")}; ${tool} ${accepts}`);
}

export function registerPeerTools(pi: ExtensionAPI, getRt: () => PeerRuntime | undefined): void {
	const runtime = (): PeerRuntime => {
		const rt = getRt();
		if (!rt) throw new Error("peer tools not ready (session not started); retry later");
		return rt;
	};

	pi.registerTool({
		name: "peer_list",
		label: "Peer",
		description: "Online pi sessions in this directory.",
		promptSnippet: "List online pi sessions",
		parameters: listParams,
		async execute(_id: string, p: object, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<PeerToolDetails>> {
			const rt = runtime();
			rejectUnknownKeys("peer_list", p ?? {}, []);
			const now = Date.now();
			const roster = await discoverPeers(rt.self.sessionId, ctx.cwd);
			// 自身 id 先给:模型的 sessionId 不在任何别处可得,自报家门与
			// 「这个目标是不是我自己」都要它(语料:5 次发给自己)。
			return {
				content: [{ type: "text", text: `you: id=${rt.self.sessionId.slice(0, 8)}\n${rosterText(roster.alive, roster.suspended, now)}` }],
				details: {
					peerCount: roster.alive.length,
					suspended: roster.suspended,
				},
			};
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer",
		// prompt 面只写「与后训练先验的差量」:ack 不等于已读、回复异步到达。
		// 配额数字、失败分类都在错误正文里(只在命中时付 token)。
		description:
			"Message another pi session. Accepted ≠ read; a reply, if any, arrives later as its own peer message.",
		promptSnippet: "Message another pi session",
		parameters: sendParams,
		// 发出去的正文就是这次调用的载荷:不渲染人只能从参数 JSON 里认。
		renderCall(args: unknown, theme, context) {
			const view = formatOutgoingCall(args, context.expanded === true);
			const rows = [
				theme.fg("toolTitle", theme.bold("peer_send")) + (view.head ? ` ${theme.fg("accent", view.head)}` : ""),
				...view.lines.map((line) => theme.fg("dim", line)),
				...(view.folded > 0 ? [theme.fg("muted", `… +${view.folded} lines`)] : []),
			];
			return new Text(rows.join("\n"), 0, 0);
		},
		// 成功行与未送达行同屏:部分失败不能长得像全成功。
		renderResult(result: AgentToolResult<PeerToolDetails>, _options, theme) {
			const [accepted = "", ...rest] = (result.content ?? [])
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n")
				.split("\n");
			const rows = [theme.fg("success", accepted), ...rest.map((line) => theme.fg("error", line))];
			return new Text(rows.join("\n"), 0, 0);
		},
		async execute(_id: string, p: SendParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<PeerToolDetails>> {
			const rt = runtime();
			rejectUnknownKeys("peer_send", p ?? {}, ["to", "text"]);
			const now = Date.now();
			// 模型的先验是标量 to；单目标写成裸字符串语义无歧义，当一元列表收。
			const targets = (typeof p.to === "string" ? [p.to] : p.to ?? [])
				.map((t) => (typeof t === "string" ? t.trim() : ""))
				.filter((t) => t !== "");
			if (targets.length === 0) throw new Error("missing to; peer_send needs at least one target session name/sessionId");
			if (!p.text?.trim()) throw new Error("missing text; peer_send needs a message");
			const text = p.text.trim();
			const roster = await discoverPeers(rt.self.sessionId, ctx.cwd);
			const alive = roster.alive;

			const delivered: PeerIdentity[] = [];
			const failed: SendFailure[] = [];
			const reached = new Set<string>();
			for (const to of targets) {
				// 自己被 discoverPeers 排除在 resolve 面外,先按 id 前缀撞库自投,给明确错误
				if (rt.self.sessionId.startsWith(to)) {
					failed.push({ target: to, reason: "cannot send to yourself (same session)" });
					continue;
				}
				const target = resolvePeer(alive, to);
				if (!target.ok) {
					failed.push({ target: to, reason: target.reason });
					continue;
				}
				// name 与 id 前缀可能指向同一会话:只投一次
				if (reached.has(target.peer.sessionId)) continue;
				const pair = `${rt.self.sessionId}→${target.peer.sessionId}`;
				const v = rt.quota.check(pair, text, now);
				if (!v.ok) {
					failed.push({
						target: to,
						reason: v.kind === "repeat"
							? `duplicate message (same text within ${PEER_SEND_QUOTA.repeatWindowMs / 1000}s), dropped`
							: `send quota exceeded (${PEER_SEND_QUOTA.max}/${PEER_SEND_QUOTA.windowMs / 60000}min); retry later`,
					});
					continue;
				}
				const msg: PeerMessage = { from: rt.self.sessionId, text, ts: now };
				try {
					// 同步投递:成功返回 = 对方进程已接管(排队注入);不可达/被拒/超时抛错
					await sendPeerMessage(socketPathFor(target.peer.sessionId, ctx.cwd), msg);
				} catch (e) {
					// 一个目标投不进去不能拖累其他人:记下原因,继续下一个
					failed.push({ target: to, reason: e instanceof Error ? e.message : String(e) });
					continue;
				}
				// 送达成功才记账:失败尝试不烧配额、不刷新同文基线,重试可放行
				rt.quota.commit(pair, text, now);
				reached.add(target.peer.sessionId);
				delivered.push(target.peer);
			}

			// 零送达不是成功:全部失败走错误信封,并把手上的名册一并交回
			if (delivered.length === 0) {
				throw new Error(`not delivered:\n${failureText(failed)}\n${rosterText(alive, roster.suspended, now)}`);
			}
			// 结果只说新事实:谁接收了、谁没接收。异步投递与回执语义在工具描述里
			// (每请求一份)——在每次成功里再背一遍是重复付费。
			const accepted = delivered.map((peer) => peer.sessionId.slice(0, 8)).join(", ");
			return {
				content: [{
					type: "text",
					text: failed.length > 0
						? `accepted by ${accepted}\nnot delivered:\n${failureText(failed)}`
						: `accepted by ${accepted}`,
				}],
				details: { to: delivered.map((peer) => peer.sessionId) },
			};
		},
	});
}
