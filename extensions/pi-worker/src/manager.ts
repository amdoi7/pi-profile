import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { formatCallback, type CallbackMessage } from "./bridge.ts";
import { buildInitialPrompt, makeWorkerId, validateRunInput } from "./contract.ts";
import { RoomBus } from "./room-bus.ts";
import { displayNameOf } from "./present.ts";
import { RpcClient } from "./rpc-client.ts";
import { spawnChild, terminate } from "./spawner.ts";
import { WorkerError, WorkerStateMachine } from "./state-machine.ts";
import { latestStats } from "./present.ts";
import type { RunInput, WorkerRecord } from "./types.ts";
import { attachWatcher, type WorkerEvent } from "./watcher.ts";

const RECENT_CAP = 10;

/** 子 session 审计目录:<cwd>/.pi/worker/sessions(HARNESS.md「有状态事实源」契约)。 */
export function sessionDirFor(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "worker", "sessions");
}

function pushRecent(rec: { recent: string[] }, entry: string): void {
	rec.recent.push(entry);
	if (rec.recent.length > RECENT_CAP) rec.recent.splice(0, rec.recent.length - RECENT_CAP);
}

const HANDSHAKE_TIMEOUT_MS = 30000;
const ABORT_TIMEOUT_MS = 5000;
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
	/** 消息平面:parent/worker 互发统一入口(寻址/投递/审计/失败回执)。 */
	readonly bus: RoomBus;
	private readonly handles = new Map<string, Handle>();

	constructor(private readonly deps: ManagerDeps) {
		this.bus = new RoomBus({
			deliver: deps.deliver,
			resolve: (to) => {
				const t = [...this.sm.records.values()].filter(
					(r) => r.state !== "done" && r.state !== "killing" && (r.name === to || r.id === to),
				);
				return t.length === 1 ? t[0].id : undefined;
			},
			transport: (id, text) => this.message(id, text),
			nameOf: (id) => this.sm.records.get(id)?.name ?? displayNameOf(id),
		});
	}

	/** run:校验合约 → 生成 id → spawn → starting → 握手 → prompt 接受后 running。立即返回,结果走回调。 */
	run(input: RunInput, cwd: string): { id: string; pid?: number } {
		const errors = validateRunInput(input);
		if (errors.length > 0) {
			throw new WorkerError(`合约缺字段: ${errors.join(", ")};补全后重试`);
		}

		const id = makeWorkerId(input);
		const rec = this.sm.run({ id, name: input.name.trim(), oneshot: input.oneshot });
		const sessionDir = sessionDirFor(cwd);

		let proc: import("node:child_process").ChildProcess;
		try {
			proc = spawnChild({
				cwd,
				sessionDir,
				id,
				name: input.name.trim(),
				model: input.model?.trim() || undefined,
				thinking: input.thinking?.trim() || undefined,
			});
		} catch (e) {
			this.sm.onExit(id, { code: null, signal: null, stderrTail: `spawn 失败: ${e instanceof Error ? e.message : String(e)}` });
			throw new WorkerError(`spawn 失败: ${e instanceof Error ? e.message : String(e)}`);
		}
		rec.pid = proc.pid;
		rec.model = input.model?.trim() || undefined;
		rec.thinking = input.thinking?.trim() || undefined;
		rec.role = input.role?.trim() || undefined;

		const rpc = new RpcClient(proc);
		const handle: Handle = { proc, rpc, watcher: { dispose: () => {} }, sessionDir };
		// 先注册句柄再接事件流:watcher 任何事件(dialog 等)到达时 handles 必有,
		// 时序窗口结构性消除(dialog 分支的句柄缺失 throw 成为不可达断言)。
		this.handles.set(id, handle);
		handle.watcher = attachWatcher(
			{ events: rpc, stderr: proc.stderr! /* stdio: ["pipe",...] 保证非 null */ },
			(ev) => this.onWorkerEvent(id, ev),
		);
		this.deps.onChange?.();

		const prompt = buildInitialPrompt({ ...input, id, sessionDir });
		void rpc
			.send({ type: "get_state" }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })
			.then((state) => {
				// 握手顺带取实际生效模型/档位(含默认值),overlay 显示用
				const data = state as { model?: { provider?: string; id?: string } | null; thinkingLevel?: string };
				const live = this.sm.records.get(id);
				if (live && data.model?.id) {
					live.modelInfo = {
						provider: data.model.provider ?? "",
						id: data.model.id,
						thinkingLevel: data.thinkingLevel ?? "",
					};
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
					formatCallback({ type: "failed", id, exitCode: null, exitSignal: null, stderrTail: `启动失败: ${message}` }),
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
		await this.sendCmd(id, { type: "steer", message: STOP_MESSAGE }, "stop");
		this.deps.onChange?.();
		setTimeout(() => {
			const rec = this.sm.records.get(id);
			if (!rec || rec.state !== "stopping") return;
			const handle = this.handles.get(id);
			if (!handle) return;
			handle.rpc.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => {
				// abort 失败(管道断/进程死):状态机已由 watcher 转移到 failed/exited,无需动作
			});
			setTimeout(() => {
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
		await this.sendCmd(id, { type: "prompt", message }, "follow_up");
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

	/** collect:父验收后收尾,终止进程并释放。 */
	collect(id: string): void {
		this.sm.collect(id);
		const handle = this.handles.get(id);
		if (handle) terminate(handle.proc);
		this.deps.onChange?.();
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
				// 统一回 cancelled,不替父决策。句柄缺失 = invariant 破坏,静默会埋雷。
				const handle = this.handles.get(id);
				if (!handle) throw new WorkerError(`dialog 回应失败: ${id} 进程句柄缺失(invariant 破坏)`);
				handle.rpc.writeRaw({ type: "extension_ui_response", id: ev.id, cancelled: true });
				return;
			}
		}
	}

	/** settled 反应:取呈报与用量 → 投递回调;oneshot 自动 collect。 */
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
			formatCallback({ type: "settled", id, name: rec.name, role: rec.role, report, reportError, stats, turns: rec.turns }),
		);
		if (rec.oneshot) this.collect(id);
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
					};
					const rec = this.sm.records.get(id);
					if (rec && state.model?.id) {
						rec.modelInfo = {
							provider: state.model.provider ?? "",
							id: state.model.id,
							thinkingLevel: state.thinkingLevel ?? "",
						};
					}
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
