import { CALLBACK_TYPE, type CallbackMessage } from "./bridge.ts";

/**
 * RoomBus:room(parent + live workers 协作空间)的 message plane,单一管道。
 * 不变式:一种语义——异步 fire-and-forget(无阻塞/gateway 变体);
 * 地址 = name / id / "parent";传输由目标类型与 delivery primitive 决定,发送方不关心。
 * 成员目录不在此维护(派生自 manager registry 活记录);本模块只拥有消息语义:
 * resolve、deliver、audit fan-out、failure receipt。生命周期事件(settled/failed)不是消息,不走本管道。
 */

export interface RoomBusDeps {
	/** parent session 出口:quiet=true → 安静 display;false/缺省 → 唤醒(triggerTurn)。 */
	deliver: (msg: CallbackMessage, opts?: { quiet?: boolean }) => void;
	/** name/id → live worker id;未命中(不存在或歧义)undefined。 */
	resolve: (to: string) => string | undefined;
	/** worker delivery primitive:FSM 按状态选 steer(running)/ prompt(idle);非法状态抛错。 */
	transport: (id: string, text: string) => Promise<"steer" | "prompt">;
	/** id → 显示名(审计文本用)。 */
	displayNameOf: (id: string) => string;
}

export type PostResult =
	| { ok: true; via: "steer" | "prompt" | "display" }
	| { ok: false; reason: string };

const PARENT = "parent";

export class RoomBus {
	constructor(private readonly deps: RoomBusDeps) {}

	/** 唯一入口:任何节点 → 任何节点的异步消息。quiet 仅 parent 目标生效(安静留痕,不烧父轮次)。 */
	async post(from: string, to: string, text: string, quiet = false): Promise<PostResult> {
		if (to === PARENT) {
			if (from === PARENT) return { ok: false, reason: "parent 不能给自己发消息" };
			// worker → parent:消息卡;quiet=true 安静留痕(display 不 triggerTurn),缺省唤醒——
			// 消息即请求注意,想要安静就带 quiet
			this.deps.deliver(
				{
					customType: CALLBACK_TYPE,
					content: `msg ${this.deps.displayNameOf(from)} → parent:${text}`,
					details: { type: "message", id: from, text },
				},
				{ quiet },
			);
			return { ok: true, via: "display" };
		}
		const target = this.deps.resolve(to);
		if (target === undefined) {
			const reason = `目标「${to}」不存在或歧义(活 worker 中无法唯一解析)`;
			await this.notifySender(from, `投递失败:${reason};原文:${text}`);
			return { ok: false, reason };
		}
		const fromName = from === PARENT ? "parent" : this.deps.displayNameOf(from);
		try {
			const via = await this.deps.transport(target, `来自「${fromName}」的消息:${text}`);
			if (from !== PARENT) {
				// peer 流量 audit fan-out:父 session 安静留痕(不烧父轮次),世界模型不瞎
				this.deps.deliver(
					{
						customType: CALLBACK_TYPE,
						content: `msg ${fromName} → ${this.deps.displayNameOf(target)}:${text}`,
						details: { type: "action-done", id: from },
					},
					{ quiet: true },
				);
			}
			return { ok: true, via };
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			await this.notifySender(from, `投递失败:目标「${to}」不可收(${reason});原文:${text}`);
			return { ok: false, reason };
		}
	}

	/** failure receipt 到发送方(worker 能自我修正);发送方是 parent 由调用方拿 PostResult;
	 * receipt 自身也失败(发送方已死)→ 安静审计到 parent session,不静默吞没。 */
	private async notifySender(from: string, notice: string): Promise<void> {
		if (from === PARENT) return;
		try {
			await this.deps.transport(from, notice);
		} catch {
			this.deps.deliver(
				{ customType: CALLBACK_TYPE, content: notice, details: { type: "action-done", id: from } },
				{ quiet: true },
			);
		}
	}
}
