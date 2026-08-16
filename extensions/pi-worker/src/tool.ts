import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { ID_RE, NAME_RE, THINKING_LEVELS } from "./contract.ts";
import type { WorkerManager } from "./manager.ts";
import { extractCost, formatToolCallLine, latestStats } from "./present.ts";
import { WorkerError } from "./state-machine.ts";
import { COLLECT_VERDICTS, type WorkerRecord } from "./types.ts";

const piWorkerParams = Type.Object({
	action: StringEnum(["run", "send", "stop", "collect", "kill", "status"]),
	// 寻址收紧:id 只收系统生成的完整 id(name 可重名,不进寻址面);
	// pattern 与 contract.ts 单一事实源同源,schema 层先拦截,运行时记录查找仍是兑底
	id: Type.Optional(
		Type.String({
			pattern: ID_RE.source,
			description: "worker address: the full id returned by run; required for send/stop/collect/kill; for status, omit to list all",
		}),
	),
	name: Type.Optional(
		Type.String({
			pattern: NAME_RE.source,
			description:
				"required for run: worker name for display and redispatch (names may repeat; addressing uses id only)",
		}),
	),
	text: Type.Optional(
		Type.String({
			description: "required for run: self-contained task brief; for send: the message text",
		}),
	),
	// 投递模式(仅 send 用):running 时 steer(缺省,当前轮边界生效)或 followUp(排队,settled 后新轮);
	// idle/exited 忽略 mode(prompt/冷恢复语义不变)。枚举值即语义,与 pi 内核 deliverAs 同词汇。
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("steer"), Type.Literal("followUp")],
			{
				description:
					"for send: delivery to a running worker — steer (default) = effective at the current turn boundary; followUp = queued until the current turn settles, then a new turn starts with this text (idle/exited ignore mode)",
			},
		),
	),
	model: Type.Optional(Type.String({ description: "for run: worker model as provider/id; omit = default model" })),
	// CLI 对非法档位只警告并丢弃(静默降级);枚举在 schema 层 fail fast,THINKING_LEVELS 为单一事实源
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "for run: thinking level; omit = default level" })),
	// 工具面收缩(只准在已知集合内,无扩权):只读审计/调研 worker 的真隔离机制
	tools: Type.Optional(
		Type.String({
			pattern: "^[a-zA-Z0-9_-]+(\\s*,\\s*[a-zA-Z0-9_-]+)*$",
			description:
				"for run: tool allowlist (set semantics); allowed: read,bash,edit,write,grep,find,ls,send_message; default read,bash,edit,write,send_message; use read,grep,find,ls for read-only audit; contract field — changing it creates a new id",
		}),
	),
	verdict: Type.Optional(
		StringEnum(COLLECT_VERDICTS, {
			description: "for collect: final-review verdict, recorded on the record and shown in status; omit for plain cleanup (no verdict)",
		}),
	),
});

export type PiWorkerParams = Static<typeof piWorkerParams>;

export function registerPiWorkerTool(pi: ExtensionAPI, manager: WorkerManager): void {
	pi.registerTool({
		name: "pi_worker",
		label: "Pi Worker",
		// 回调线格式(settled XML / failed 线)是 bridge.ts 的 wire contract,注释已载;
		// 渲染层已呈现 header/report,父模型无需知道格式才能行动——不进 prompt
		description: `Dispatch and manage pi workers: async tasks in independent sessions. run returns immediately; results arrive as callback messages.
Use when a task is self-contained, needs an independent context, or parallelizes. Do not use for tasks you can complete directly or for simple questions.

Actions:
- run: spawn a worker session → returns {id} (the address for all later actions)
- send: deliver text; running → steer (effective after current tool call) or mode=followUp (queued until the current turn settles, then starts a new turn); idle → triggers a new turn; exited → cold-resume via --session with full history; other terminal states reject
- stop: stop new work; the worker only finishes its report and settles
- collect: mark done and clear the record; optional verdict = final review conclusion
- status: worker records (state, usage, legal actions); omit id to list all; exited records can be cold-resumed via send, cleared via collect`,

		parameters: piWorkerParams,
		renderCall(args, theme, _context) {
			const line = formatToolCallLine(String(args.action ?? ""), args);
			return new Text(theme.fg("toolTitle", theme.bold("pi_worker ")) + theme.fg("muted", line), 0, 0);
		},
		async execute(_toolCallId, params: PiWorkerParams, _signal, _onUpdate, ctx) {
			try {
				const result = await dispatch(manager, params, ctx.cwd, ctx);
				return { content: [{ type: "text", text: result }], details: { params } };
			} catch (e) {
				if (e instanceof WorkerError) throw new Error(e.message);
				throw e;
			}
		},
	});
}

async function dispatch(manager: WorkerManager, p: PiWorkerParams, cwd: string, ctx: { sessionManager?: { getBranch?: () => unknown[]; getSessionFile?: () => string | null | undefined } }): Promise<string> {
	switch (p.action) {
		case "run": {
			const { id } = manager.run(
				{
					name: p.name ?? "",
					prompt: p.text ?? "",
					model: p.model,
					thinking: p.thinking,
					tools: p.tools,
				},
				cwd,
				// O4 授权链:父 session 文件写入 worker jsonl header(parentSession),
				// 恢复归属变数据;ephemeral 父(print 无文件)为 null,走 legacy 恢复
				{ parentSessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined },
			);
			return `accepted: name=${p.name!.trim()} id=${id} (use this id for all later actions); completion/questions/crash arrive as callback messages.`;
		}
		case "send": {
			requireField(p, "id", "send");
			requireField(p, "text", "send");
			// exited 直调 manager(bus resolve 只含 running/idle——peer 不得复活死 worker;
			// 冷恢复是父独占的生命周期动作)。status 抛错即「id 不存在 + 存活列表」
			const target = manager.status(p.id!) as WorkerRecord;
			if (target.state === "exited") {
				await manager.message(p.id!, p.text!);
				return `cold-resume started: ${p.id} (--session same file, full history); the text triggers a new turn; results arrive as callbacks.`;
			}
			const result = await manager.bus.post("parent", p.id!, p.text!, false, p.mode === "followUp" ? "followUp" : "steer");
			if (!result.ok) throw new WorkerError(`send failed: ${result.reason}`);
			if (result.via === "steer") {
				return `steer injected: ${p.id}; effective after current tool call.`;
			}
			if (result.via === "queued") {
				return `follow-up queued: ${p.id}; a new turn starts after the current one settles.`;
			}
			return `delivered: ${p.id}; worker starts a new turn.`;
		}
		case "stop": {
			requireField(p, "id", "stop");
			await manager.stop(p.id!);
			return `stop sent: ${p.id}; worker finishes its report and settles (→ idle).`;
		}
		case "collect": {
			requireField(p, "id", "collect");
			manager.collect(p.id!, p.verdict);
			return p.verdict
				? `collected: ${p.id} → done, verdict=${p.verdict}; deliverable frontmatter is written by the accepting side.`
				: `collected: ${p.id} → done.`;
		}
		case "kill": {
			requireField(p, "id", "kill");
			await manager.kill(p.id!);
			return `kill executed: ${p.id}; → done after process exit.`;
		}
		case "status": {
			const records = manager.status(p.id);
			return formatStatus(records);
		}
		default:
			throw new WorkerError(`unknown action: ${String(p.action)}`);
	}
}

function requireField(p: PiWorkerParams, field: "id" | "text", action: string): void {
	if (!p[field]?.trim()) {
		throw new WorkerError(`missing ${field}; action=${action} requires ${field}.`);
	}
}

/** status 列表排序:决策优先(failed/idle/exited 需父行动)> 工作态 > 终态(done 是噪音居尾)。
 * 与 overlay formatOverlayRows 的 decision 区同语义,但本地映射——markOf 对 done 抛错,不可复用。 */
const STATUS_RANK: Record<string, number> = {
	failed: 0,
	idle: 1,
	exited: 2,
	starting: 3,
	running: 3,
	stopping: 3,
	done: 4,
	killing: 4,
};

/** status 的合法动作面:工具枚举 + 参数提示(能力同构抽象)——RPC 父拿到即可直接
 * 调用工具,零 label→action 映射。治理语义(判决/归因)就事论事落在可执行面:
 * collect 带 verdict 枚举、failed 提示清账后重派。与 pane 的 UI 文案(actionsFor)
 * 分离:前者是机器契约,后者是显示层。 */
export function statusActionsFor(r: WorkerRecord): string {
	switch (r.state) {
		case "idle":
			return "send|collect(verdict=通过|丢弃|强制放行)";
		case "failed":
			return "collect(clear, then redispatch per attribution)";
		case "running":
			return "send|stop|kill";
		case "starting":
		case "stopping":
			return "kill";
		case "exited":
			// 报告已交(报告先于进程死),判决不因进程死失效——与 idle 同款判决集
			return "send(cold-resume)|collect(verdict=通过|丢弃|强制放行)";
		default:
			return "";
	}
}

function formatStatus(records: WorkerRecord | WorkerRecord[]): string {
	const list = Array.isArray(records) ? records : [records];
	if (list.length === 0) return "No worker records.";
	const sorted = [...list].sort(
		(a, b) => (STATUS_RANK[a.state] ?? 9) - (STATUS_RANK[b.state] ?? 9) || a.createdAt - b.createdAt,
	);
	// 多条时给一行汇总头:父 LLM 扫读不用自数;决策态在前(与行序一致)
	let header = "";
	if (sorted.length > 1) {
		const counts = new Map<string, number>();
		for (const r of sorted) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
		const summary = [...counts.entries()]
			.sort((a, b) => (STATUS_RANK[a[0]] ?? 9) - (STATUS_RANK[b[0]] ?? 9))
			.map(([s, n]) => `${s}×${n}`)
			.join(" · ");
		header = `${sorted.length} workers: ${summary}\n`;
	}
	const body = sorted
		.map((r) => {
			const bits = [`id=${r.id}`, `state=${r.state}`];
			// 非正常收尾(length 截断/aborted 中断)是验收信号,RPC 父只看本输出,必须带出
			if (r.stopReason && r.stopReason !== "stop") bits.push(`stopReason=${r.stopReason}`);
			bits.push(`turns=${r.turns}`);
			if (r.processExited) bits.push(`exit=${r.exitCode ?? r.exitSignal ?? "?"}`);
			// 失败诊断:exit=? 时 stderrTail 是唯一原因(spawn 失败等),状态行带出
			if (r.stderrTail) bits.push(`stderr="${r.stderrTail.slice(0, 120)}"`);
			// 呈报获取/deliver 失败诊断(pane 之外的唯一可见面)
			if (r.reportError) bits.push(`reportError="${r.reportError.slice(0, 120)}"`);
			if (r.verdict) bits.push(`verdict=${r.verdict}`);
			// 合法动作列表:工具面直出(statusActionsFor),决策队列
			const actions = statusActionsFor(r);
			if (actions) bits.push(`actions=${actions}`);
			const cost = extractCost(latestStats(r));
			if (cost !== undefined) bits.push(`cost=${cost.toFixed(4)}`);
			return `- ${bits.join(" ")}`;
		})
		.join("\n");
	return header + body;
}
