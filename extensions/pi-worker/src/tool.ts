import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { ID_RE, NAME_RE, THINKING_LEVELS } from "./contract.ts";
import { appendLifecycleEntry } from "./lifecycle-block.ts";
import type { WorkerManager } from "./manager.ts";
import { actionsFor, extractCost, formatRecentEntry, formatToolCallLine, latestStats } from "./present.ts";
import { WorkerError } from "./state-machine.ts";
import { COLLECT_VERDICTS, type WorkerRecord } from "./types.ts";

const piWorkerParams = Type.Object({
	action: StringEnum(["run", "message", "stop", "collect", "kill", "status", "recover"]),
	// 寻址收紧:id 只收系统生成的完整 id(name 可重名,不进寻址面);
	// pattern 与 contract.ts 单一事实源同源,schema 层先拦截,运行时记录查找仍是兑底
	id: Type.Optional(
		Type.String({
			pattern: ID_RE.source,
			description:
				"worker address: the full id returned by run; required for message/stop/collect/kill; for status, omit to list all",
		}),
	),
	name: Type.Optional(
		Type.String({
			pattern: NAME_RE.source,
			description:
				"required for run: worker name for display and redispatch (names may repeat; addressing uses id only)",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "required for run: self-contained task brief; for message: the message text",
		}),
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
		description:
			"Dispatch and manage pi workers: async tasks in independent sessions. run returns immediately; results arrive as callback messages.\n" +
			"Use when a task is self-contained, needs an independent context, or parallelizes. Do not use for tasks you can complete directly or for simple questions.\n" +
			"- run: create and dispatch a new session → {id, pid}; add rounds to an existing worker via message.\n" +
			"- message: send text to a worker; running → effective at turn boundary, idle → triggers a new turn; terminal states reject.\n" +
			"- stop: stop new work; the worker only finishes its report and settles.\n" +
			"- kill: terminate immediately (exit → done); re-dispatch via run.\n" +
			"- collect: mark done and terminate the process.\n" +
			"- status: return worker records (state, usage, legal actions); omit id to list all; claimed records appear as state=exited with the recovered marker (last state unknown) — collect to clear.\n" +
			"- recover: claim THIS session's leftover workers from disk (never automatic; startup only shows a hint; workers of other parent sessions are listed with a pi --session/--fork path, not claimed) — then status to audit, collect to clear.",
		parameters: piWorkerParams,
		renderCall(args, theme, _context) {
			const line = formatToolCallLine(String(args.action ?? ""), args);
			return new Text(theme.fg("toolTitle", theme.bold("pi_worker ")) + theme.fg("muted", line), 0, 0);
		},
		async execute(_toolCallId, params: PiWorkerParams, _signal, _onUpdate, ctx) {
			try {
				const result = await dispatch(manager, params, ctx.cwd, pi, ctx);
				return { content: [{ type: "text", text: result }], details: { params } };
			} catch (e) {
				if (e instanceof WorkerError) throw new Error(e.message);
				throw e;
			}
		},
	});
}

async function dispatch(manager: WorkerManager, p: PiWorkerParams, cwd: string, pi: Pick<ExtensionAPI, "appendEntry">, ctx: { sessionManager?: { getBranch?: () => unknown[] } }): Promise<string> {
	switch (p.action) {
		case "run": {
			const { id, pid } = manager.run(
				{
					name: p.name ?? "",
					prompt: p.prompt ?? "",
					model: p.model,
					thinking: p.thinking,
					tools: p.tools,
				},
				cwd,
			);
			// transcript 生命周期 block:显示态 entry(TUI-only);RPC 父只持久化不渲染,无害
			appendLifecycleEntry(pi, manager.status(id) as WorkerRecord, p.prompt ?? "");
			return `run 已接受:name=${p.name!.trim()} id=${id}(后续操作一律用此 id) pid=${pid ?? "?"};完成/提问/崩溃将以回调消息送达。`;
		}
		case "message": {
			requireField(p, "id", "message");
			requireField(p, "prompt", "message");
			const result = await manager.bus.post("parent", p.id!, p.prompt!);
			if (!result.ok) throw new WorkerError(`message 失败: ${result.reason}`);
			return result.via === "steer"
				? `message 已注入:${p.id};当前 turn 工具执行完毕后生效。`
				: `message 已投递:${p.id};worker 触发新轮。`;
		}
		case "stop": {
			requireField(p, "id", "stop");
			await manager.stop(p.id!);
			return `stop 已发送:${p.id};worker 将只收尾呈报,settled 后并入 idle。`;
		}
		case "collect": {
			requireField(p, "id", "collect");
			manager.collect(p.id!, p.verdict);
			return p.verdict
				? `已收尾:${p.id} → done,verdict=${p.verdict};deliverable frontmatter 由验收方同步落笔。`
				: `已收尾:${p.id} → done。`;
		}
		case "kill": {
			requireField(p, "id", "kill");
			await manager.kill(p.id!);
			return `kill 已执行:${p.id};进程退出后 → done。`;
		}
		case "status": {
			const records = manager.status(p.id);
			return formatStatus(records);
		}
		case "recover": {
			const branchText = JSON.stringify(ctx.sessionManager?.getBranch?.() ?? []);
			const res = await manager.recoverFromDisk(cwd, { claim: (id) => branchText.includes(id) });
			const parts = [`认领 ${res.recovered} 个本会话遗留 worker`];
			if (res.foreign.length > 0) {
				parts.push(
					`非本会话遗留 ${res.foreign.length} 个(不建记录;直接新会话查看): ` +
						res.foreign.map((s) => `${s.id} → pi --session ${s.sessionFile}(查看/续接) 或 pi --fork ${s.sessionFile}(新会话)`).join("; "),
				);
			}
			if (res.skippedFiles.length > 0) parts.push(`跳过不可解析: ${res.skippedFiles.join(", ")}`);
			if (res.heldElsewhere.length > 0) parts.push(`其他活窗口持有: ${res.heldElsewhere.join(", ")}`);
			parts.push(res.recovered > 0 ? "status 审计,collect 清理" : "无需认领");
			return parts.join(";");
		}
		default:
			throw new WorkerError(`未知 action: ${String(p.action)}`);
	}
}

function requireField(p: PiWorkerParams, field: "id" | "prompt", action: string): void {
	if (!p[field]?.trim()) {
		throw new WorkerError(`缺 ${field} 参数;action=${action} 需要 ${field}。`);
	}
}

function formatStatus(records: WorkerRecord | WorkerRecord[]): string {
	const list = Array.isArray(records) ? records : [records];
	if (list.length === 0) return "无worker 记录。";
	return list
		.map((r) => {
			const bits = [`id=${r.id}`, `state=${r.state}`];
			if (r.recovered) bits.push("recovered");
			if (r.pid) bits.push(`pid=${r.pid}`);
			if (r.modelInfo) bits.push(`model=${r.modelInfo.provider}/${r.modelInfo.id}`);
			if (r.processExited) bits.push(`exit=${r.exitCode ?? r.exitSignal ?? "?"}`);
			// 失败诊断:exit=? 时 stderrTail 是唯一原因(spawn 失败等),状态行带出
			if (r.stderrTail) bits.push(`stderr="${r.stderrTail.slice(0, 120)}"`);
			if (r.verdict) bits.push(`verdict=${r.verdict}`);
			if (r.tools) bits.push(`tools=${r.tools}`);
			// 遗留记录:jsonl 是唯一事实源,审计指针带出
			if (r.recovered && r.sessionFile) bits.push(`session=${r.sessionFile}`);
			// G4:合法动作列表复用 actionsFor(与 overlay 同一事实源),rpc 父的决策队列
			const actions = actionsFor(r);
			if (actions.length > 0) bits.push(`actions=${actions.map((a) => a.label).join("|")}`);
			const cost = extractCost(latestStats(r));
			if (cost !== undefined) bits.push(`cost=${cost}`);
			const recentLines = r.recent.slice(-6).map((e) => `  ${formatRecentEntry(e)}`);
			if (r.recent.length > 6) recentLines.push(`  … +${r.recent.length - 6} more`);
			const recent = recentLines.length > 0 ? `\n${recentLines.join("\n")}` : "";
			return `- ${bits.join(" ")}${recent}`;
		})
		.join("\n");
}
