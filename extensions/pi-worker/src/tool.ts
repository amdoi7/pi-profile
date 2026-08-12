import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { WorkerManager } from "./manager.ts";
import { extractCost, formatRecentEntry, formatToolCallLine, latestStats } from "./present.ts";
import { WorkerError } from "./state-machine.ts";
import type { WorkerRecord } from "./types.ts";

const piWorkerParams = Type.Object({
	action: StringEnum(["run", "message", "stop", "collect", "kill", "status"]),
	id: Type.Optional(Type.String({ description: "worker id(pi-worker-<name>#<hash>)" })),
	name: Type.Optional(Type.String({ description: "稳定身份,重派复用" })),
	task: Type.Optional(Type.String({ description: "任务描述(必填)" })),
	role: Type.Optional(Type.String({ description: "角色标注(自由文本,注入子 prompt)" })),
	acceptance: Type.Optional(Type.String({ description: "验收标准(可证伪断言清单)" })),
	context_refs: Type.Optional(Type.String({ description: "上下文引用(文件路径等)" })),
	model: Type.Optional(Type.String({ description: "worker 模型(provider/id)" })),
	thinking: Type.Optional(Type.String({ description: "思考档位 off|minimal|low|medium|high|xhigh|max" })),
	message: Type.Optional(Type.String({ description: "message 的文本(按子状态投递:running→turn 边界生效;idle→触发新轮)" })),
	oneshot: Type.Optional(Type.Boolean({ description: "true=报告送达后自动收尾" })),
});

export type PiWorkerParams = Static<typeof piWorkerParams>;

export function registerPiWorkerTool(pi: ExtensionAPI, manager: WorkerManager): void {
	pi.registerTool({
		name: "pi_worker",
		label: "Pi Worker",
		description:
			"pi-worker 模块契约面:机制/状态/回调格式/worker 治理(charter 注入子进程)均以本模块为准,父 AGENTS.md 引用不复制;改契约改本模块。\n" +
			"分发与管理 pi worker(独立 session 的异步任务);run 立即返回,结果以回调送达。\n" +
			"- run: 创建worker。name 必填(稳定身份,重派复用;id 自动生成);task 必填;" +
			"role/acceptance/context_refs 可选;model/thinking 指定子模型与思考档位;" +
			"oneshot=true 时报告送达后自动收尾(默认 false,留在 settled 等指令)。\n" +
			"- message: 给子发消息(同一功能,按子状态投递:running→当前 turn 完毕后生效;idle→触发新轮;打回/追加轮次同路)。\n" +
			"- stop: 子 running 时要求立即停止新工作、只收尾呈报;软指令有硬兑底(宽限内未收尾→abort→硬终止转 failed 带诊断),收尾回调 settled(软)或 failed(硬)。\n" +
			"- collect: 父验收子产出后调用,收尾并释放进程。\n" +
			"- kill: 撤换。kill 后修合约重新 run。\n" +
			"- status: 查询状态与用量,id 缺省列全部。\n" +
			"回调消息:failed id= exit= stderr尾。settled 为 XML 结构化消息:\n" +
			"<worker-settled><id>..</id><name>..</name><role>..</role><status>settled</status><turns>N</turns>" +
			"<usage><tool_calls>N</tool_calls><tokens><input>..</input><output>..</output><cacheRead>..</cacheRead><cacheWrite>..</cacheWrite><total>..</total></tokens><cost>..</cost></usage>" +
			"<report>四要素呈报全文</report></worker-settled>\n" +
			"呈报全文在 <report> 内;usage 段字段缺省省略,可机器断言(用量/轮数)。",
		promptSnippet: "分发异步worker 任务(并行/超出能力/独立上下文),结果以回调送达",
		promptGuidelines: [
			"pi_worker 的 run 立即返回,结果以回调送达;不要轮询 status 等待完成。",
		],
		parameters: piWorkerParams,
		renderCall(args, theme, _context) {
			const line = formatToolCallLine(String(args.action ?? ""), args);
			return new Text(theme.fg("toolTitle", theme.bold("pi_worker ")) + theme.fg("muted", line), 0, 0);
		},
		async execute(_toolCallId, params: PiWorkerParams, _signal, _onUpdate, ctx) {
			try {
				const result = await dispatch(manager, params, ctx.cwd);
				return { content: [{ type: "text", text: result }], details: { params } };
			} catch (e) {
				if (e instanceof WorkerError) throw new Error(e.message);
				throw e;
			}
		},
	});
}

async function dispatch(manager: WorkerManager, p: PiWorkerParams, cwd: string): Promise<string> {
	switch (p.action) {
		case "run": {
			const { id, pid } = manager.run(
				{
					name: p.name ?? "",
					task: p.task ?? "",
					role: p.role,
					acceptance: p.acceptance,
					contextRefs: p.context_refs,
					model: p.model,
					thinking: p.thinking,
					oneshot: p.oneshot,
				},
				cwd,
			);
			return `run 已接受:id=${id} pid=${pid ?? "?"};完成/提问/崩溃将以回调消息送达。`;
		}
		case "message": {
			requireField(p, "id", "message");
			requireField(p, "message", "message");
			const result = await manager.bus.post("parent", p.id!, p.message!);
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
			manager.collect(p.id!);
			return `已收尾:${p.id} → done。`;
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
		default:
			throw new WorkerError(`未知 action: ${String(p.action)}`);
	}
}

function requireField(p: PiWorkerParams, field: "id" | "message", action: string): void {
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
			if (r.pid) bits.push(`pid=${r.pid}`);
			if (r.oneshot) bits.push("oneshot");
			if (r.role) bits.push(`role=${r.role}`);
			if (r.modelInfo) bits.push(`model=${r.modelInfo.provider}/${r.modelInfo.id}`);
			if (r.processExited) bits.push(`exit=${r.exitCode ?? r.exitSignal ?? "?"}`);
			// 失败诊断:exit=? 时 stderrTail 是唯一原因(spawn 失败等),状态行带出
			if (r.stderrTail) bits.push(`stderr="${r.stderrTail.slice(0, 120)}"`);
			const cost = extractCost(latestStats(r));
			if (cost !== undefined) bits.push(`cost=${cost}`);
			const recentLines = r.recent.slice(-6).map((e) => `  ${formatRecentEntry(e)}`);
			if (r.recent.length > 6) recentLines.push(`  … +${r.recent.length - 6} more`);
			const recent = recentLines.length > 0 ? `\n${recentLines.join("\n")}` : "";
			return `- ${bits.join(" ")}${recent}`;
		})
		.join("\n");
}
