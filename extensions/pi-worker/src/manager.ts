import { formatCallback, CALLBACK_TYPE, type CallbackMessage } from "./bridge.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { buildInitialPrompt, cwdFromWorkerSessionFile, makeWorkerId, normalizeTools, summarizeTask, validateRunInput, workerSessionDir, HANDSHAKE_TIMEOUT_MS, STOP_GRACE_MS, STOP_ABORT_WINDOW_MS } from "./contract.ts";
import { COLLECTED_MARKER, scanLeftoverSessions } from "./recovery.ts";
import { RoomBus, type SendMode } from "./room-bus.ts";
import { displayNameOf } from "./present.ts";
import { RpcClient } from "./rpc-client.ts";
import { spawnChild, terminate } from "./spawner.ts";
import { WorkerError, WorkerStateMachine } from "./state-machine.ts";
import { latestStats } from "./present.ts";
import { parseSessionEntries } from "./transcript.ts";
import type { CollectVerdict, RunInput, SessionEntry, WorkerRecord, WorkerState } from "./types.ts";
import { attachWatcher, type WorkerEvent } from "./watcher.ts";

/** transcript buffer 上限(message 粒度;超限丢最旧——视图是尾窗语义,不是归档) */
const TRANSCRIPT_CAP = 1000;

/** transcript 数据源 buffer(manager 持有,视图经 transcriptView 读):
 * live = 事件流增量 + get_messages 回填;dead = 文件一次性解析缓存。 */
interface TranscriptBuffer {
	entries: SessionEntry[];
	hydrated: boolean;
	hydrating: boolean;
	/** 回填飞行期间到达的事件暂存(防覆盖丢失) */
	queue: SessionEntry[];
}

const ABORT_TIMEOUT_MS = 5000;

/** 升级政策:宽限 → abort(尽力)→ 窗口 → terminate(SIGTERM→SIGKILL,见 spawner)。
 * 三处共用一副骨架,差异全在参数:
 *   stop    = 软指令两段硬兑底(30s 宽限 → abort → 15s 窗 → terminate),onlyIfState 守卫
 *   kill    = 撤换:abort 落定才 terminate(awaitAbort,让 abort 先截停 turn)
 *   killAll = shutdown 连带:abort 即发即忘,terminate 同步不等 */
interface EscalationPolicy {
	/** abort 前的宽限 ms;0 = 立即 abort */
	graceMs: number;
	/** fire-and-forget 模式下 abort → terminate 的窗口 ms;0 = 同步 terminate */
	abortWindowMs: number;
	/** true = abort 落定后才 terminate(kill 的撤换语义) */
	awaitAbort: boolean;
	/** 每步生效守卫:记录仍处该状态才升级(stop=stopping;kill/killAll 同步完成无窗口期,无需守卫) */
	onlyIfState?: WorkerState;
}

const STOP_ESCALATION: EscalationPolicy = { graceMs: STOP_GRACE_MS, abortWindowMs: STOP_ABORT_WINDOW_MS, awaitAbort: false, onlyIfState: "stopping" };
const KILL_ESCALATION: EscalationPolicy = { graceMs: 0, abortWindowMs: 0, awaitAbort: true };
const KILLALL_ESCALATION: EscalationPolicy = { graceMs: 0, abortWindowMs: 0, awaitAbort: false };

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

/* 时限常量单一事实源在 contract.ts:STOP_GRACE_MS/STOP_ABORT_WINDOW_MS/STOP_DEADLINE_MS
 * (面板倒计时同源,不漂移);软指令宽限期依赖子 LLM 自愿服从(live 实测 20-60s 不等)。 */

/** stop 的线上传输:一条 canonical steer 收尾指令;意图记录在状态机(stopping)。 */
export const STOP_MESSAGE = "STOP: no new work; finish current and report the current result per the four elements.";

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
	/** transcript buffer:与记录同寿(run/resume 重置,collect 清),不进 WorkerRecord(status 面不背大数组) */
	private readonly transcripts = new Map<string, TranscriptBuffer>();
	/** followUp 排队(mode=followUp,running 中):settled 报告送达后 flush 成新轮;stop/kill/collect/dropHandle 清 */
	private readonly pendingFollowUps = new Map<string, string[]>();

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
			transport: (id, text, mode) => this.message(id, text, mode),
			displayNameOf: (id) => this.sm.records.get(id)?.name ?? displayNameOf(id),
		});
	}

	/** run:校验合约 → 生成 id → spawn → starting → 握手 → prompt 接受后 running。立即返回,结果走回调。 */
	run(input: RunInput, cwd: string, opts?: { parentSessionFile?: string }): { id: string; pid?: number } {
		const errors = validateRunInput(input);
		if (errors.length > 0) {
			throw new WorkerError(`contract validation failed: ${errors.join("; ")}`);
		}

		const id = makeWorkerId(input);
		const rec = this.sm.run({ id, name: input.name.trim(), taskSummary: summarizeTask(input.prompt) });
		const sessionDir = workerSessionDir(cwd); // 审计目录(内置约定)
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
			this.sm.onExit(id, { code: null, signal: null, stderrTail: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
			throw new WorkerError(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		rec.pid = proc.pid;
		rec.cwd = cwd; // O3 冷恢复 spawn 用
		rec.model = input.model?.trim() || undefined;
		rec.thinking = input.thinking?.trim() || undefined;
		if (tools) rec.tools = tools;

		const rpc = new RpcClient(proc);
		const handle: Handle = { proc, rpc, watcher: { dispose: () => {} }, sessionDir };
		// 先注册句柄再接事件流:watcher 任何事件(dialog 等)到达时 handles 必有。
		this.handles.set(id, handle);
		// transcript buffer 与进程同生(get_messages 回填前的早期事件不落空)
		this.transcripts.set(id, { entries: [], hydrated: false, hydrating: false, queue: [] });
		handle.watcher = attachWatcher(
			{ events: rpc, stderr: proc.stderr! /* stdio: ["pipe",...] 保证非 null */ },
			(ev) => this.onWorkerEvent(id, ev),
		);
		this.deps.onChange?.();

		// run 合约任务文本即初始 prompt(身份/通信语义在 preamble + 工具 description,不注入)
		const prompt = buildInitialPrompt({ ...input, id });
		void this.handshake(handle, id, prompt, opts?.parentSessionFile).catch((e: unknown) => this.failHandshake(id, proc, e));

		return { id, pid: proc.pid };
	}

	/** 握手失败统一出路:starting→failed + 投递 + 句柄回收 + 进程终止(watcher 状态守卫防双投)。 */
	private failHandshake(id: string, proc: import("node:child_process").ChildProcess, e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		const live = this.sm.records.get(id);
		if (!live || live.state !== "starting") return; // 已由 watcher 转移(进程先死/error 路径)
		this.sm.onExit(id, { code: null, signal: null, stderrTail: `start failed: ${message}` });
		this.deps.deliver(
			formatCallback({ type: "failed", id, exitCode: null, exitSignal: null, stderrTail: `start failed: ${message}`, sessionFile: live.sessionFile }),
		);
		this.dropHandle(id);
		terminate(proc);
	}

	/** 启动认领:父重启后从磁盘重建遗留 worker 记录(进程随父死,jsonl 在;
	 * send 冷恢复 / collect 清账是记录的合法出路)。幂等:已存在 id 跳过;
	 * collect 过的文件由扫描排除(COLLECTED_MARKER)。返回新认领数。 */
	async claimLeftovers(cwd: string): Promise<number> {
		const { sessions } = await scanLeftoverSessions(cwd);
		let n = 0;
		for (const s of sessions) {
			if (this.sm.records.has(s.id)) continue;
			this.sm.claimLeftover(s);
			n++;
		}
		if (n > 0) this.deps.onChange?.();
		return n;
	}

	/** O3 冷恢复:exited 记录 --session 同文件续接(历史完整),text 即新轮指令。
	 * 无 new_session——文件自带 O4 parentSession 链;cwd 取 run 时记录。 */
	private async resume(id: string, text: string): Promise<void> {
		const rec = this.sm.records.get(id);
		if (!rec || rec.state !== "exited") return; // 调用方(message)已按 FSM 保证
		if (!rec.sessionFile) {
			throw new WorkerError(`send failed: ${id} has no session file, cannot cold-resume; collect to clear and redispatch per contract`);
		}
		const cwd = rec.cwd ?? cwdFromWorkerSessionFile(rec.sessionFile);
		if (!cwd) {
			throw new WorkerError(`send failed: ${id} session path lacks worker-sessions anchor, cannot resolve cwd; collect to clear and redispatch`);
		}
		this.sm.onResumed(id); // exited→starting(spawn 失败走 failed)
		let proc: import("node:child_process").ChildProcess;
		try {
			proc = spawnChild({ cwd, id, name: rec.name, model: rec.model, thinking: rec.thinking, tools: rec.tools, session: rec.sessionFile });
		} catch (e) {
			this.sm.onExit(id, { code: null, signal: null, stderrTail: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
			throw new WorkerError(`cold-resume spawn failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		rec.pid = proc.pid;
		rec.cwd = cwd;
		const rpc = new RpcClient(proc);
		const handle: Handle = { proc, rpc, watcher: { dispose: () => {} }, sessionDir: workerSessionDir(cwd) };
		this.handles.set(id, handle);
		// 冷恢复 = 新进程生命:buffer 重置,回填会拉全量历史(--session 续接的完整上下文)
		this.transcripts.set(id, { entries: [], hydrated: false, hydrating: false, queue: [] });
		handle.watcher = attachWatcher(
			{ events: rpc, stderr: proc.stderr! },
			(ev) => this.onWorkerEvent(id, ev),
		);
		this.deps.onChange?.();
		void this.handshake(handle, id, text, undefined).catch((e: unknown) => this.failHandshake(id, proc, e));
	}

	/** 握手序列:get_state → (有父 session 则)new_session(parentSession) → 重取 get_state → prompt。
	 * O4 授权链:new_session 的 parentSession 原生写入子 jsonl header,恢复时归属是数据不是启发式。
	 * new_session 后 sessionFile 变更,必须重取 get_state 覆写审计指针;cancelled(理论不可达:
	 * 子进程仅加载自身扩展,无 session_before_switch 钩子)回退无链启动,legacy 恢复路径接管。 */
	private async handshake(handle: Handle, id: string, prompt: string, parentSessionFile?: string): Promise<void> {
		const state = await handle.rpc.send({ type: "get_state" }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
		// 握手顺带取实际生效模型/档位 + 原生 sessionFile(审计指针)
		const live = this.sm.records.get(id);
		if (live) applyHandshakeState(live, state as { model?: { provider?: string; id?: string } | null; thinkingLevel?: string; sessionFile?: string });
		if (parentSessionFile) {
			const ns = (await handle.rpc.send({ type: "new_session", parentSession: parentSessionFile }, { timeoutMs: HANDSHAKE_TIMEOUT_MS })) as { cancelled?: boolean } | undefined;
			if (!ns?.cancelled) {
				const state2 = await handle.rpc.send({ type: "get_state" }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
				const live2 = this.sm.records.get(id);
				if (live2) applyHandshakeState(live2, state2 as { model?: { provider?: string; id?: string } | null; thinkingLevel?: string; sessionFile?: string });
			}
		}
		await handle.rpc.send({ type: "prompt", message: prompt });
		// 仅 starting→running 一次转移;若期间已被 kill(→killing)则忽略
		this.sm.onStarted(id);
	}

	/** 句柄回收:先解除 watcher 订阅(流监听不泄漏),再删句柄;followUp 队列随代次作废(防跨代泄入)。 */
	private dropHandle(id: string): void {
		const h = this.handles.get(id);
		if (h) {
			h.watcher.dispose();
			this.handles.delete(id);
		}
		this.pendingFollowUps.delete(id);
	}

	/** followUp 队列排空:settled 报告已送达之后(先给父报告,再开新轮)。
	 * 合并为一条 prompt(一次一轮;多条需求同轮可见,优先级由 worker 自己判);
	 * 已被 stop/kill/collect 清的队列为空;flush 失败(子已死等)以安静诊断卡显形。 */
	private flushPendingFollowUps(id: string): void {
		const queue = this.pendingFollowUps.get(id);
		if (!queue || queue.length === 0) return;
		this.pendingFollowUps.delete(id);
		const rec = this.sm.records.get(id);
		if (!rec || rec.state !== "idle") return; // 已被 collect/kill:队列作废,不复活
		void this.followUp(id, queue.join("\n\n")).catch((e: unknown) => {
			this.deps.deliver(
				{
					customType: CALLBACK_TYPE,
					content: `queued follow-up delivery failed: ${e instanceof Error ? e.message : String(e)}`,
					details: { type: "action-done", id },
				},
				{ quiet: true },
			);
		});
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
		this.pendingFollowUps.delete(id); // 停止语义 = 不追加新轮
		const stopRec = this.sm.records.get(id);
		if (stopRec) stopRec.stopStartedAt = Date.now(); // 面板倒计时起点(成功进入 stopping)
		try {
			await this.sendCmd(id, { type: "steer", message: STOP_MESSAGE }, "stop");
		} catch (e) {
			// 停止指令没落地 ⇒ 子仍在跑本轮:回退 running 才是真相。此处 return 前
			// 兑底计时器尚未 armed,stopping 不会无兑底悬挂;调用方按错误重试或 kill。
			this.sm.rollback(id, "stopping", "running");
			const rb = this.sm.records.get(id);
			if (rb) rb.stopStartedAt = undefined; // 倒计时不残留(未真正进入 stopping)
			this.deps.onChange?.();
			throw e;
		}
		this.deps.onChange?.();
		// 两段硬兑底由升级引擎承载(代次令牌内聚,换代即失效)
		void this.escalate(id, STOP_ESCALATION);
	}

	/** message:父→子统一通道(同一功能,按接收方状态选投递语义)。
	 * running → steer(当前 turn 工具执行完毕后生效)或 mode=followUp(排队,settled 后新轮);
	 * idle → prompt(触发新轮);exited → 冷恢复(--session 同文件续接)。 */
	async message(id: string, text: string, mode: SendMode = "steer"): Promise<"steer" | "prompt" | "queued"> {
		const rec = this.sm.records.get(id);
		if (!rec) {
			throw new WorkerError(`send failed: ${id} not found; alive: ${this.sm.liveIds().join(", ") || "(none)"}`);
		}
		if (rec.state === "running") {
			if (mode === "followUp") {
				// 排队不打断当前轮:settled 报告送达后 flush(flushPendingFollowUps)
				const q = this.pendingFollowUps.get(id) ?? [];
				q.push(text);
				this.pendingFollowUps.set(id, q);
				return "queued";
			}
			await this.steer(id, text);
			return "steer";
		}
		if (rec.state === "idle") {
			await this.followUp(id, text);
			return "prompt";
		}
		if (rec.state === "exited") {
			// O3 冷恢复:--session 同文件续接,消息即新轮指令(进程已死,无需 switch_session)
			await this.resume(id, text);
			return "prompt";
		}
		throw new WorkerError(
			`send failed: ${id} is ${rec.state}; deliverable states: running (steer at turn boundary, or mode=followUp queued) / idle (triggers a new turn) / exited (cold-resume)`,
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
			throw new WorkerError(`${action} failed: ${id} in legal state but missing process handle (invariant broken); kill then rerun`);
		}
		try {
			await handle.rpc.send(cmd);
		} catch (e) {
			throw new WorkerError(`${action} send failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** transcript 视图数据源(pane 唯一读入口):live = 事件流 buffer + 懒回填;
	 * dead = 文件一次性解析缓存;无记录/无产物 → undefined(视图缺失提示)。 */
	transcriptView(id: string): SessionEntry[] | undefined {
		const rec = this.sm.records.get(id);
		if (!rec) return undefined;
		let buf = this.transcripts.get(id);
		if (!buf) {
			buf = { entries: [], hydrated: false, hydrating: false, queue: [] };
			this.transcripts.set(id, buf);
		}
		const handle = this.handles.get(id);
		if (handle) {
			void this.ensureTranscript(id, handle);
			return buf.entries;
		}
		// dead:进程不在,文件是静态真相——解析一次缓存,不重读
		if (!buf.hydrated && rec.sessionFile) {
			try {
				buf.entries = parseSessionEntries(readFileSync(rec.sessionFile, "utf8"));
			} catch {
				// 文件不可读:保持空,视图给缺失提示
			}
			buf.hydrated = true;
		}
		return buf.entries;
	}

	/** live 回填:get_messages 原生返回当前分支(pi 自己的树回溯,视图不再自实现)。
	 * 飞行期事件入 queue;快照与 queue 头部可能重叠(message_end 先到、快照又含之),
	 * 按内容对回填尾 50 条去重——极端情况下吃掉边界处的合法同文重复,视图层可接受。 */
	private async ensureTranscript(id: string, handle: Handle): Promise<void> {
		const buf = this.transcripts.get(id);
		if (!buf || buf.hydrated || buf.hydrating) return;
		buf.hydrating = true;
		try {
			const res = (await handle.rpc.send({ type: "get_messages" })) as {
				messages?: Array<Record<string, unknown>>;
			};
			const backfill: SessionEntry[] = (res.messages ?? [])
				.filter((m) => m && (m.role === "user" || m.role === "assistant"))
				.map((message) => ({ type: "message", message }));
			const seen = new Set(backfill.slice(-50).map((e) => JSON.stringify(e.message)));
			// 合并窗口 = 飞行期 queue + 回填前已到 entries;两者都可能与快照尾部重叠
			const pending = [...buf.queue, ...buf.entries];
			const tail = pending.filter((e) => {
				const k = JSON.stringify(e.message);
				if (seen.has(k)) {
					seen.delete(k);
					return false;
				}
				return true;
			});
			buf.entries = [...backfill, ...tail];
			if (buf.entries.length > TRANSCRIPT_CAP) buf.entries.splice(0, buf.entries.length - TRANSCRIPT_CAP);
			buf.queue = [];
			buf.hydrated = true;
			this.deps.onChange?.();
		} catch {
			// 回填失败(rpc 断/进程死):entries 原位未动,queue 待下次合并,不丢
			buf.hydrating = false;
		}
	}
	/** 收起标记落 session 尾部:恢复去重(不复活),审计保留(不删文件)。
	 * 决策 API 落标(collect / 显式 kill)——决策时持久化,与事件时序解耦;
	 * killAll(session_shutdown)不落:shutdown 不是对 deliverable 的决策,重启认领保留。
	 * 标记失败仅影响去重——下次重启重新浮现,可再 collect,不阻塞收尾。 */
	private writeCollectedMarker(id: string, verdict?: CollectVerdict): void {
		const rec = this.sm.records.get(id);
		if (!rec?.sessionFile || !existsSync(rec.sessionFile)) return;
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

	/** abort 尽力而为(管道断/进程死 → 状态机已由 watcher 转移,无需动作;terminate 兜底)。 */
	private async bestEffortAbort(handle: Handle, timeoutMs = ABORT_TIMEOUT_MS): Promise<void> {
		try {
			await handle.rpc.send({ type: "abort" }, { timeoutMs });
		} catch {
			// abort 失败:进程已死/管道断;terminate 对已退出进程无操作,兑底链不缺环
		}
	}

	/** collect:父验收后收尾,终止进程并释放。verdict = 终审结论(工具参数面,
	 * 落记录供 status 审计);非法状态抛错(fail fast),不落 verdict。 */
	collect(id: string, verdict?: CollectVerdict): void {
		this.sm.collect(id);
		this.pendingFollowUps.delete(id); // 验收收尾:排队作废
		this.transcripts.delete(id);
		const rec = this.sm.records.get(id);
		if (rec && verdict) rec.verdict = verdict;
		const handle = this.handles.get(id);
		if (handle) terminate(handle.proc);
		this.writeCollectedMarker(id, verdict);
		this.deps.onChange?.();
	}

	/** 升级链引擎:政策参数化 + 代次令牌内聚(fire 时句柄已换代即失效,同 id 重跑不串扰)。
	 * 返回的 promise 仅服务 awaitAbort 模式(kill 等 terminate 落地);其余模式同步 resolve。 */
	private escalate(id: string, policy: EscalationPolicy): Promise<void> {
		const generation = this.handles.get(id);
		const alive = (): Handle | undefined => {
			const h = this.handles.get(id);
			if (!h || h !== generation) return undefined;
			if (policy.onlyIfState && this.sm.records.get(id)?.state !== policy.onlyIfState) return undefined;
			return h;
		};
		const terminateStep = (): void => {
			const h = alive();
			if (h) terminate(h.proc);
		};
		const abortStep = (): Promise<void> => {
			const h = alive();
			if (!h) return Promise.resolve();
			if (policy.awaitAbort) return this.bestEffortAbort(h).then(terminateStep);
			void this.bestEffortAbort(h);
			if (policy.abortWindowMs > 0) setTimeout(terminateStep, policy.abortWindowMs).unref();
			else terminateStep();
			return Promise.resolve();
		};
		if (policy.graceMs > 0) {
			setTimeout(() => void abortStep(), policy.graceMs).unref();
			return Promise.resolve();
		}
		return abortStep();
	}

	/** kill:撤换。abort(停止当前 turn)+ 终止进程;进程退出后状态 → done。
	 * marker 在决策时落盘(显式 kill = 终态决策,重启不复活);killAll(session_shutdown)
	 * 直调 sm.kill 不经本方法,不落标——重启认领(G1 恢复)保留。 */
	async kill(id: string): Promise<void> {
		this.sm.kill(id);
		this.pendingFollowUps.delete(id); // 撤换:排队作废
		const handle = this.handles.get(id);
		if (!handle) {
			throw new WorkerError(`kill failed: ${id} in legal state but missing process handle (invariant broken); rerun`);
		}
		this.writeCollectedMarker(id); // 决策时持久化(先于进程终止,与事件时序解耦)
		await this.escalate(id, KILL_ESCALATION);
		this.deps.onChange?.();
	}

	/**
	 * worker 事件的唯一反应者:watcher 翻译的全部领域事件在此落实政策——
	 * 状态机迁移、显示态更新、呈报获取与投递、消息路由、dialog 回应。
	 */
	onWorkerEvent(id: string, ev: WorkerEvent): void {
		switch (ev.type) {
			case "entry": {
				// transcript 饲料:视图无 onChange(pane 1s tick 自取;每消息刷 footer 太吵)
				const buf = this.transcripts.get(id);
				if (!buf) return;
				if (buf.hydrating) buf.queue.push(ev.entry);
				else {
					buf.entries.push(ev.entry);
					if (buf.entries.length > TRANSCRIPT_CAP) buf.entries.splice(0, buf.entries.length - TRANSCRIPT_CAP);
				}
				return;
			}
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
					// (marker 由决策 API kill()/collect() 落,事件反应器零政策)
					this.dropHandle(id);
				}
				return;
			}
			case "turnEnd": {
				const rec = this.sm.records.get(id);
				if (!rec) return;
				rec.turns++;
				rec.currentActivity = undefined;
				this.deps.onChange?.();
				// 每 turn 一次用量快照(append-only 账本;事件驱动,无轮询)
				void this.snapshotStats(id);
				return;
			}
			case "toolStart": {
				const rec = this.sm.records.get(id);
				if (!rec) return;
				rec.currentActivity = `tool: ${ev.toolName} ${ev.args}`;
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
							stderrTail: "dialog reply failed: process handle missing (invariant broken); dialog ignored",
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
		// 句柄缺失(exit 先到已回收):仍投递占位回调——父不能因进程已退而失去 settled 信号;
		// 呈报取不到以显式占位呈现,不静默 return(否则状态 idle 但父无任何回调)。
		let report = "";
		let reportError: string | undefined;
		let stopReason: string | undefined;
		let stats: Record<string, unknown> | undefined;
		if (!handle) {
			reportError = "process handle already reclaimed (exit before settled); report unavailable; audit in session jsonl";
		} else {
			try {
				// O2 原生路径:get_messages 一次取末条 assistant 的 {stopReason, text}——
				// 替代 get_last_assistant_text(abort/工具收尾轮会回退残留或空,陷阱见
				// pi-worker-harness-adjudication P4)。text 仅取 content 的 text 块,
				// 排除 thinking/toolCall。
				const res = (await handle.rpc.send({ type: "get_messages" })) as {
					messages?: Array<{ role?: string; content?: unknown; stopReason?: string }>;
				};
				const messages = res.messages ?? [];
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i];
					if (!m || m.role !== "assistant") continue;
					stopReason = m.stopReason;
					const content = m.content;
					if (typeof content === "string") {
						report = content;
					} else if (Array.isArray(content)) {
						report = content
							.filter((b): b is { type: "text"; text?: string } => Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text")
							.map((b) => b.text ?? "")
							.join("\n");
					}
					break;
				}
			} catch (e) {
				reportError = e instanceof Error ? e.message : String(e);
			}
			// 用量快照:turn_end 在途则等待其结果(本轮快照);已完成则取尾;
			// 两者皆无(异常)才补拉。每 turn 至多一次拉取,append 不重复。
			const pending = this.statsFetches.get(id);
			if (pending) {
				stats = await pending;
			} else {
				stats = latestStats(rec);
				if (!stats) stats = await this.snapshotStats(id);
			}
		}
		// 竞态:取呈报期间被 kill/collect → 不送达 stale 回调
		if (this.sm.records.get(id)?.state !== "idle") return;
		rec.report = report;
		rec.stopReason = stopReason;

		// deliver(pi.sendMessage)失败不得静默吞掉 settled 信号:留痕到记录,
		// 状态已是 idle,父至少能经 status 看到 report 与失败原因。
		try {
			this.deps.deliver(
				formatCallback({ type: "settled", id, name: rec.name, report, reportError, stopReason, stats, turns: rec.turns, sessionFile: rec.sessionFile }),
			);
		} catch (e) {
			rec.reportError = (rec.reportError ? rec.reportError + "; " : "") + `deliver failed: ${e instanceof Error ? e.message : String(e)}`;
			this.deps.onChange?.();
		}
		// followUp 队列:settled 报告送达后才排空(先给父报告,再开新轮);被 stop/kill/collect 清的队列作废
		this.flushPendingFollowUps(id);
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
		for (const [id] of this.handles) {
			try {
				this.sm.kill(id);
			} catch {
				// 已终态,忽略
			}
			void this.escalate(id, KILLALL_ESCALATION);
		}
	}
}
