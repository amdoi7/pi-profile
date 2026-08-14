import { CALLBACK_TYPE, formatCallback, type CallbackMessage } from "./bridge.ts";
import { appendFileSync, existsSync } from "node:fs";
import { buildInitialPrompt, makeWorkerId, normalizeTools, validateRunInput, workerSessionDir } from "./contract.ts";
import { COLLECTED_MARKER, defaultPidAlive, scanWorkerSessions, type RecoveredSession, type ScanResult } from "./recovery.ts";
import { RoomBus } from "./room-bus.ts";
import { displayNameOf } from "./present.ts";
import { RpcClient } from "./rpc-client.ts";
import { spawnChild, terminate } from "./spawner.ts";
import { WorkerError, WorkerStateMachine } from "./state-machine.ts";
import { latestStats } from "./present.ts";
import type { CollectVerdict, RunInput, WorkerRecord } from "./types.ts";
import { attachWatcher, type WorkerEvent } from "./watcher.ts";

const RECENT_CAP = 10;

function pushRecent(rec: { recent: string[] }, entry: string): void {
	rec.recent.push(entry);
	if (rec.recent.length > RECENT_CAP) rec.recent.splice(0, rec.recent.length - RECENT_CAP);
}

const HANDSHAKE_TIMEOUT_MS = 30000;
const ABORT_TIMEOUT_MS = 5000;

/** 握手 get_state → 记录映射(纯函数,可单测)。sessionFile 是 pi 原生会话 jsonl
 * 路径(RpcSessionState.sessionFile)——回调携带后,父的事实核验第三层
 * (子 session 审计)一步可达,无需自建文件发现逻辑。 */
export function applyHandshakeState(
	rec: WorkerRecord,
	state: { model?: { provider?: string; id?: string } | null; thinkingLevel?: string; sessionFile?: string },
): void {
	if (state.model?.id) {
		rec.modelInfo = {
			provider: state.model.provider ?? "",
			id: state.model.id,
			thinkingLevel: state.thinkingLevel ?? "",
		};
	}
	if (state.sessionFile) rec.sessionFile = state.sessionFile;
}

/** stop 软指令的宽限期:STOP 依赖子 LLM 自愿服从(live 实测 20-60s 不等),超时后 abort */
const STOP_GRACE_MS = 30000;
/** abort 后等待 settled 的窗口;仍不 settled → terminate(SIGTERM→SIGKILL),worst case 有界 */
const STOP_ABORT_WINDOW_MS = 15000;

/** stop 的线上传输:一条 canonical steer 收尾指令;意图记录在状态机(stopping)。 */
export const STOP_MESSAGE = "STOP:立即停止新工作,只收尾并按四要素呈报当前结果。";

interface Handle {
	proc: import("node:child_process").ChildProcess;
	rpc: RpcClient;
	watcher: { dispose: () => void };
	sessionDir: string;
}

export interface ManagerDeps {
	/** parent session 出口:quiet=true → 安静 display;缺省 → 唤醒(followUp + triggerTurn)。
	 * 生命周期回调与 RoomBus 消息共用此口。 */
	deliver: (msg: CallbackMessage, opts?: { quiet?: boolean }) => void;
	/** 任何状态迁移后触发:footer 投影全量重算(事件驱动,无轮询) */
	onChange?: () => void;
}

/**
 * registry(Map<id, handle>)+ 生命周期属主。状态机(纯)管合法性,
 * manager 管副作用:spawn/ready/prompt、abort/terminate、watcher 接线、句柄回收。
 */
export class WorkerManager {
	readonly sm = new WorkerStateMachine();
	/** message plane:parent/worker 互发统一入口(resolve/deliver/audit fan-out/failure receipt)。 */
	readonly bus: RoomBus;
	private readonly handles = new Map<string, Handle>();

	constructor(private readonly deps: ManagerDeps) {
		this.bus = new RoomBus({
			deliver: deps.deliver,
			resolve: (to) => {
				// 仅可收消息的状态(running/idle)可寻址;starting/stopping 未就绪,终态出局
				const t = [...this.sm.records.values()].filter(
					(r) => (r.state === "running" || r.state === "idle") && (r.name === to || r.id === to),
				);
				return t.length === 1 ? t[0].id : undefined;
			},
			transport: (id, text) => this.message(id, text),
			displayNameOf: (id) => this.sm.records.get(id)?.name ?? displayNameOf(id),
		});
	}

	/** run:校验合约 → 生成 id → spawn → starting → 握手 → prompt 接受后 running。立即返回,结果走回调。 */
	run(input: RunInput, cwd: string): { id: string; pid?: number } {
		const errors = validateRunInput(input);
		if (errors.length > 0) {
			throw new WorkerError(`合约缺字段: ${errors.join(", ")};补全后重试`);
		}

		const id = makeWorkerId(input);
		const rec = this.sm.run({ id, name: input.name.trim() });
		const sessionDir = workerSessionDir(cwd, process.pid); // 归属命名空间(恢复按目录判定所有者)
		const tools = normalizeTools(input.tools);

		let proc: import("node:child_process").ChildProcess;
		try {
			proc = spawnChild({
				cwd,
				id,
				name: input.name.trim(),
				model: input.model?.trim() || undefined,
				thinking: input.thinking?.trim() || undefined,
				tools,
			});
		} catch (e) {
			this.sm.onExit(id, { code: null, signal: null, stderrTail: `spawn 失败: ${e instanceof Error ? e.message : String(e)}` });
			throw new WorkerError(`spawn 失败: ${e instanceof Error ? e.message : String(e)}`);
		}
		rec.pid = proc.pid;
		rec.model = input.model?.trim() || undefined;
		rec.thinking = input.thinking?.trim() || undefined;
		if (tools) rec.tools = tools;

		const rpc = new RpcClient(proc);
		const handle: Handle = { proc, rpc, watcher: { dispose: () => {} }, sessionDir };
		// 先注册句柄再接事件流:watcher 任何事件(dialog 等)到达时 handles 必有。
		this.handles.set(id, handle);
		handle.watcher = attachWatcher(
			{ events: rpc, stderr: proc.stderr! /* stdio: ["pipe",...] 保证非 null */ },
			(ev) => this.onWorkerEvent(id, ev),
		);
		this.deps.onChange?.();

		const prompt = buildInitialPrompt({ ...input, id });
		void rpc
			.send({ type: "get_state" }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
			.then((state) => {
				// 握手顺带取实际生效模型/档位 + 原生 sessionFile(审计指针)
				const live = this.sm.records.get(id);
				if (live) {
					applyHandshakeState(live, state as { model?: { provider?: string; id?: string } | null; thinkingLevel?: string; sessionFile?: string });
				}
				return rpc.send({ type: "prompt", message: prompt });
			})
			.then(() => {
				// 仅 starting→running 一次转移;若期间已被 kill(→killing)则忽略
				this.sm.onStarted(id);
			})
			.catch((e: unknown) => {
				const message = e instanceof Error ? e.message : String(e);
				const live = this.sm.records.get(id);
				if (!live || live.state !== "starting") return; // 已由 watcher 转移(进程先死/error 路径)
				// 谁执行 starting→failed 转移谁投递;watcher 侧状态守卫防双投
				this.sm.onExit(id, { code: null, signal: null, stderrTail: `启动失败: ${message}` });
				this.deps.deliver(
					formatCallback({ type: "failed", id, exitCode: null, exitSignal: null, stderrTail: `启动失败: ${message}`, sessionFile: live.sessionFile }),
				);
				this.dropHandle(id);
				terminate(proc);
			});

		return { id, pid: proc.pid };
	}

	/** 句柄回收:先解除 watcher 订阅(流监听不泄漏),再删句柄。 */
	private dropHandle(id: string): void {
		const h = this.handles.get(id);
		if (h) {
			h.watcher.dispose();
			this.handles.delete(id);
		}
	}

	/** 同 turn 并发拉取合并(settled 复用 turn_end 在途快照,每 turn 至多一次 RPC)。 */
	private readonly statsFetches = new Map<string, Promise<Record<string, unknown> | undefined>>();

	/** 拉取会话用量快照并覆写 latestStats;失败不覆写,返回 undefined。 */
	private snapshotStats(id: string): Promise<Record<string, unknown> | undefined> {
		const existing = this.statsFetches.get(id);
		if (existing) return existing;
		const handle = this.handles.get(id);
		if (!handle) return Promise.resolve(undefined);
		const p = handle.rpc
			.send({ type: "get_session_stats" }, { timeoutMs: 15000 })
			.then((stats) => {
				const rec = this.sm.records.get(id);
				if (!rec) return undefined;
				rec.latestStats = stats;
				this.deps.onChange?.();
				return stats;
			})
			.catch(() => undefined)
			.finally(() => this.statsFetches.delete(id));
		this.statsFetches.set(id, p);
		return p;
	}

	/** steer:running 中注入干预,turn 间隙生效。 */
	async steer(id: string, message: string): Promise<void> {
		this.sm.steer(id);
		await this.sendCmd(id, { type: "steer", message }, "steer");
		this.deps.onChange?.();
	}

	/** stop:要求worker 立即停止新工作、只收尾呈报;settled 后并入普通 idle。
	 * 软指令有两段硬兑底:宽限期(STOP_GRACE_MS)内未 settled → abort 当前 turn;
	 * abort 窗口(STOP_ABORT_WINDOW_MS)后仍未 settled → terminate(SIGTERM→SIGKILL),
	 * 走 exit 路径转 failed 带诊断,worst case 有界,不无限卡 stopping。
	 * 注:pi 的 abort 不打断在途 LLM 生成(信号在操作间隙检查,生成完才退出),
	 * settle 时间依赖生成剩余时长——故 abort 是软升级,terminate 才是硬兑底。
	 * 正常路径不受影响:timer fire 时已 settled/kill → 状态守卫跳过。 */
	async stop(id: string): Promise<void> {
		this.sm.stop(id);
		// 代次令牌:同合约原样重跑复用同 id(终端记录被替换,新句柄),本代次的兑底
		// 计时器 fire 时按 id 查到的已是新代次——句柄比对不一致即失效,不串扰。
		const generation = this.handles.get(id);
		try {
			await this.sendCmd(id, { type: "steer", message: STOP_MESSAGE }, "stop");
		} catch (e) {
			// 停止指令没落地 ⇒ 子仍在跑本轮:回退 running 才是真相。此处 return 前
			// 兑底计时器尚未 armed,stopping 不会无兑底悬挂;调用方按错误重试或 kill。
			this.sm.rollback(id, "stopping", "running");
			this.deps.onChange?.();
			throw e;
		}
		this.deps.onChange?.();
		setTimeout(() => {
			if (this.handles.get(id) !== generation) return;
			const rec = this.sm.records.get(id);
			if (!rec || rec.state !== "stopping") return;
			const handle = this.handles.get(id);
			if (!handle) return;
			handle.rpc.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => {
				// abort 失败(管道断/进程死):状态机已由 watcher 转移到 failed/exited,无需动作
			});
			setTimeout(() => {
				if (this.handles.get(id) !== generation) return;
				const rec2 = this.sm.records.get(id);
				if (!rec2 || rec2.state !== "stopping") return;
				const handle2 = this.handles.get(id);
				if (!handle2) return;
				terminate(handle2.proc);
			}, STOP_ABORT_WINDOW_MS).unref();
		}, STOP_GRACE_MS).unref();
	}

	/** message:父→子统一通道(同一功能,按接收方状态选投递语义)。
	 * running → steer(当前 turn 工具执行完毕后生效);idle → prompt(触发新轮)。 */
	async message(id: string, text: string): Promise<"steer" | "prompt"> {
		const rec = this.sm.records.get(id);
		if (!rec) {
			throw new WorkerError(`message 失败: ${id} 不存在;存活: ${this.sm.liveIds().join(", ") || "(无)"}`);
		}
		if (rec.state === "running") {
			await this.steer(id, text);
			return "steer";
		}
		if (rec.state === "idle") {
			await this.followUp(id, text);
			return "prompt";
		}
		throw new WorkerError(
			`message 失败: ${id} 当前 ${rec.state};可投递状态: running(turn 边界生效)/ idle(触发新轮)`,
		);
	}

	/** follow_up:idle 后追加轮次。 */
	async followUp(id: string, message: string): Promise<void> {
		this.sm.followUp(id);
		// follow_up RPC 只排队不触发:agent 空闲时队列无消费者(running 时入队才会在
		// 本轮结束后自动接续)。本状态机 follow_up 仅合法于 idle,故映射 prompt
		// (idle 时立即触发新一轮)——语义同为追加轮次,不产生空窗。
		try {
			await this.sendCmd(id, { type: "prompt", message }, "follow_up");
		} catch (e) {
			// prompt 没落地 ⇒ 新一轮没起来,子仍 idle。若留在 running:settled 永不
			// 到达(无 turn 可结束),message 走 steer 入无消费者的队列,collect 被拒——
			// 只剩 kill 可逃。回退 idle 保住 message/collect 两条正常出路。
			this.sm.rollback(id, "running", "idle");
			this.deps.onChange?.();
			throw e;
		}
		this.deps.onChange?.();
	}

	/**
	 * sm 校验通过后的发送。状态机放行 ⇒ 句柄必在(非终态才有合法 action);
	 * 句柄缺失 = invariant 被破坏,fail fast,不静默降级。
	 */
	private async sendCmd(id: string, cmd: Record<string, unknown>, action: string): Promise<void> {
		const handle = this.handles.get(id);
		if (!handle) {
			throw new WorkerError(`${action} 失败: ${id} 状态合法但进程句柄缺失(invariant 破坏);kill 后重新 run`);
		}
		try {
			await handle.rpc.send(cmd);
		} catch (e) {
			throw new WorkerError(`${action} 发送失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** collect:父验收后收尾,终止进程并释放。verdict = 终审结论(工具参数面,
	 * 落记录供 status 审计);非法状态抛错(fail fast),不落 verdict。 */
	collect(id: string, verdict?: CollectVerdict): void {
		this.sm.collect(id);
		const rec = this.sm.records.get(id);
		if (rec && verdict) rec.verdict = verdict;
		const handle = this.handles.get(id);
		if (handle) terminate(handle.proc);
		// 收起标记落 session 尾部:恢复去重(不复活),审计保留(不删文件);
		// 标记失败仅影响去重——下次重启重新浮现,可再 collect,不阻塞收尾
		if (rec?.sessionFile && existsSync(rec.sessionFile)) {
			try {
				appendFileSync(
					rec.sessionFile,
					JSON.stringify({
						type: "custom",
						customType: COLLECTED_MARKER,
						id: "worker-collect",
						parentId: null,
						timestamp: new Date().toISOString(),
						data: verdict ? { verdict } : {},
					}) + "\n",
				);
			} catch {
				// 见上注释:去重降级,不 fail 收尾
			}
		}
		this.deps.onChange?.();
	}

	/** 遗留检测(只读):启动时调用,不建记录——认领是显式动作(pi_worker recover)。 */
	async scanLeftovers(cwd: string): Promise<ScanResult> {
		return scanWorkerSessions(workerSessionDir(cwd), { pid: process.pid, pidAlive: defaultPidAlive });
	}

	/**
	 * 显式认领(pi_worker action=recover / 测试直接调用):worker-sessions 目录即
	 * registry(single source of truth,零并行文件)。
	 * jsonl → exited × recovered 显式状态组合记录,进 records 供 status/pane 审计;
	 * 幂等(在册 id 跳过,reload 安全)。认领即 quiet 留痕(不烧父轮次),
	 * 丢弃范围(skipped/heldElsewhere)随留痕显式声明。
	 */
	async recoverFromDisk(
		cwd: string,
		opts?: { claim?: (id: string) => boolean },
	): Promise<{ recovered: number; skippedFiles: string[]; heldElsewhere: string[]; foreign: RecoveredSession[] }> {
		const { sessions, skipped, heldElsewhere } = await scanWorkerSessions(workerSessionDir(cwd), {
			pid: process.pid,
			pidAlive: defaultPidAlive,
		});
		const ids: string[] = [];
		const foreign: RecoveredSession[] = [];
		for (const s of sessions) {
			if (this.sm.records.has(s.id)) continue;
			if (opts?.claim && !opts.claim(s.id)) {
				foreign.push(s); // 非本会话:不建记录,由调用方给新会话指引
				continue;
			}
			this.sm.recover(s);
			ids.push(s.id);
		}
		if (ids.length > 0) {
			const parts = [`认领 ${ids.length} 个遗留 worker(state=exited,最后状态未知,以 jsonl 为准)`];
			if (ids.length > 0) parts.push(ids.join(", "));
			if (skipped.length > 0) parts.push(`跳过不可解析文件: ${skipped.join(", ")}`);
			if (heldElsewhere.length > 0) parts.push(`另有 ${heldElsewhere.length} 个由其他活窗口持有(未认领): ${heldElsewhere.join(", ")}`);
			parts.push("status 审计,collect 清理");
			this.deps.deliver(
				{ customType: CALLBACK_TYPE, content: parts.join(";"), details: { type: "recovery", id: "recovery" } },
				{ quiet: true },
			);
		}
		if (ids.length > 0) this.deps.onChange?.();
		return { recovered: ids.length, skippedFiles: skipped, heldElsewhere, foreign };
	}

	/** kill:撤换。abort(停止当前 turn)+ 终止进程;进程退出后状态 → done。 */
	async kill(id: string): Promise<void> {
		this.sm.kill(id);
		const handle = this.handles.get(id);
		if (!handle) {
			throw new WorkerError(`kill 失败: ${id} 状态合法但进程句柄缺失(invariant 破坏);重新 run`);
		}
		try {
			await handle.rpc.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS });
		} catch {
			// abort 尽力而为;SIGTERM/SIGKILL 兜底
		}
		terminate(handle.proc);
		this.deps.onChange?.();
	}

	/**
	 * worker 事件的唯一反应者:watcher 翻译的全部领域事件在此落实政策——
	 * 状态机迁移、显示态更新、呈报获取与投递、消息路由、dialog 回应。
	 */
	onWorkerEvent(id: string, ev: WorkerEvent): void {
		switch (ev.type) {
			case "message":
				// worker 发出的异步消息(send_message):RoomBus 统一路由;quiet=安静送达(不唤醒)
				void this.bus.post(id, ev.to, ev.text, ev.quiet);
				return;
			case "settled":
				void this.handleSettled(id);
				return;
			case "exited": {
				const before = this.sm.records.get(id)?.state;
				this.sm.onExit(id, { code: ev.code, signal: ev.signal, stderrTail: ev.stderrTail });
				this.deps.onChange?.();
				const rec = this.sm.records.get(id);
				if (!rec) return;
				if (
					(before === "starting" || before === "running" || before === "stopping") &&
					rec.state === "failed"
				) {
					// 谁执行 →failed 转移谁投递:启动失败由 run 先行投递,此处状态已
					// failed 则不重投(状态守卫防双投)。spawn error 路径:stderr 无尾,
					// 诊断回退 rpc.spawnError。
					const handle = this.handles.get(id);
					this.deps.deliver(
						formatCallback({
							type: "failed",
							id,
							exitCode: rec.exitCode ?? null,
							exitSignal: rec.exitSignal ?? null,
							stderrTail: ev.stderrTail || handle?.rpc.spawnError || "",
							sessionFile: rec.sessionFile,
						}),
					);
					this.dropHandle(id);
				} else if (rec.state === "done" || rec.state === "exited") {
					// done:正常收尾/kill 后 reap;exited:idle 后进程崩了,记录留 last known
					this.dropHandle(id);
				}
				return;
			}
			case "turnEnd": {
				const rec = this.sm.records.get(id);
				if (!rec) return;
				rec.turns++;
				rec.currentActivity = undefined;
				pushRecent(rec, "turn_end");
				this.deps.onChange?.();
				// 每 turn 一次用量快照(append-only 账本;事件驱动,无轮询)
				void this.snapshotStats(id);
				return;
			}
			case "toolStart": {
				const rec = this.sm.records.get(id);
				if (!rec) return;
				rec.currentActivity = `tool: ${ev.toolName} ${ev.args}`;
				pushRecent(rec, `start:${ev.toolName} ${ev.args}`);
				return;
			}
			case "activity": {
				// 阶段词汇(retrying/compacting):set 覆写;end 只清同 phase,不误清 tool 活动
				const rec = this.sm.records.get(id);
				if (!rec) return;
				if (ev.label) rec.currentActivity = ev.label;
				else if (rec.currentActivity?.startsWith(ev.phase)) rec.currentActivity = undefined;
				this.deps.onChange?.();
				return;
			}
			case "toolEnd": {
				const rec = this.sm.records.get(id);
				if (!rec) return;
				if (rec.currentActivity?.startsWith(`tool: ${ev.toolName}`)) {
					rec.currentActivity = undefined;
				}
				pushRecent(rec, `end:${ev.toolName}`);
				return;
			}
			case "dialog": {
				// 子进程 extension 的 dialog 会阻塞等 response;不回 = 永久挂起(僵尸)。
				// 统一回 cancelled,不替父决策。句柄缺失 = invariant 破坏:事件流上 throw
				// 无捕获者(父进程 uncaughtException),改 deliver 诊断,不 crash 不静默。
				const handle = this.handles.get(id);
				if (!handle) {
					this.deps.deliver(
						formatCallback({
							type: "failed",
							id,
							exitCode: null,
							exitSignal: null,
							stderrTail: "dialog 回应失败:进程句柄缺失(invariant 破坏);已忽略该 dialog",
						}),
					);
					return;
				}
				handle.rpc.writeRaw({ type: "extension_ui_response", id: ev.id, cancelled: true });
				return;
			}
		}
	}

	/** settled 反应:取呈报与用量 → 投递回调;父验收后显式 collect。 */
	private async handleSettled(id: string): Promise<void> {
		this.sm.onSettled(id);
		this.deps.onChange?.();
		const rec = this.sm.records.get(id);
		if (!rec || rec.state !== "idle") return; // 竞态:settled 后已被 kill/collect

		const handle = this.handles.get(id);
		if (!handle) return; // settled 后句柄已被 exited/kill 路径回收
		let report = "";
		let reportError: string | undefined;
		try {
			const reportRes = (await handle.rpc.send({ type: "get_last_assistant_text" })) as { text?: string | null };
			report = reportRes.text ?? "";
		} catch (e) {
			reportError = e instanceof Error ? e.message : String(e);
		}
		// 用量快照:turn_end 在途则等待其结果(本轮快照);已完成则取尾;
		// 两者皆无(异常)才补拉。每 turn 至多一次拉取,append 不重复。
		const pending = this.statsFetches.get(id);
		let stats: Record<string, unknown> | undefined;
		if (pending) {
			stats = await pending;
		} else {
			stats = latestStats(rec);
			if (!stats) stats = await this.snapshotStats(id);
		}
		// 竞态:取呈报期间被 kill/collect → 不送达 stale 回调
		if (this.sm.records.get(id)?.state !== "idle") return;
		rec.report = report;

		this.deps.deliver(
			formatCallback({ type: "settled", id, name: rec.name, report, reportError, stats, turns: rec.turns, sessionFile: rec.sessionFile }),
		);
	}

	status(id?: string): WorkerRecord | WorkerRecord[] {
		return this.sm.status(id);
	}

	/** overlay 显示用:子 session 审计路径。 */
	getSessionDir(id: string): string | undefined {
		return this.handles.get(id)?.sessionDir;
	}

	/**
	 * overlay 打开前补查:modelInfo 缺失(握手未完成)的活记录经 get_state 补齐,
	 * 快命令,无定时器。失败的记录跳过。
	 */
	async refreshModelInfoAll(): Promise<void> {
		const targets: Array<{ id: string; handle: Handle }> = [];
		for (const [id, handle] of this.handles) {
			const rec = this.sm.records.get(id);
			if (rec && !rec.modelInfo && (rec.state === "starting" || rec.state === "running" || rec.state === "stopping")) {
				targets.push({ id, handle });
			}
		}
		await Promise.all(
			targets.map(async ({ id, handle }) => {
				try {
					const state = (await handle.rpc.send({ type: "get_state" }, { timeoutMs: 5000 })) as {
						model?: { provider?: string; id?: string } | null;
						thinkingLevel?: string;
						sessionFile?: string;
					};
					const rec = this.sm.records.get(id);
					if (rec) applyHandshakeState(rec, state);
				} catch {
					// 子进程不可达,跳过
				}
			})
		);
	}

	/** session_shutdown:杀全部活子进程(先 kill 状态,exit 后走 done,无 failed 回调)。 */
	killAll(): void {
		for (const [id, handle] of this.handles) {
			try {
				this.sm.kill(id);
			} catch {
				// 已终态,忽略
			}
			try {
				handle.rpc.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => {});
			} catch {
				// 忽略
			}
			terminate(handle.proc);
		}
	}
}
