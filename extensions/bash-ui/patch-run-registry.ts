import { disposeDiffService, requestDiffBatch, type DiffInput, type DiffOutput } from "../_shared/diff-service.ts";
import { buildApplyPatchPlan, type ApplyPatchPlan } from "./patch-command.ts";
import { parseApplyPatchResultSequence, type ParsedApplyPatchResultSequence } from "./patch-result.ts";
import { captureAfterSnapshots, type SnapshotSet } from "./patch-snapshot.ts";
import { buildResultViewModel, type ApplyPatchResultViewModel, type DiffBatchSubmitter } from "./view-model.ts";

/**
 * 一次 ApplyPatchRun 的完整生命周期。toolCallId 是 identity；
 * ApplyPatchRunRegistry 是唯一 owner：创建、状态转换、缓存、完成与 cleanup。
 *
 *   absent -> captured -> finalizing -> ready -> removed
 *
 * - captured：plan 就绪（tool_call 在并行 sibling execution 前捕获 before 快照；
 *   非 TUI / 验证失败的轻量 run 无 before，走 intent diff）。
 * - finalizing：terminal block 首次完整时冻结 after 快照，diff 已提交长期 worker，task 在途。
 * - ready：view model 可消费；快照内容已释放（只保留纯 view model）。
 *   view model 无法识别（输出不可解析/不匹配）时直接 removed，不进入 ready。
 *
 * live run 状态在 tool_result 后删除；恢复所需数据全部进入 persisted details payload，
 * session restore / HTML export 不依赖内存 cache。
 */
export type ApplyPatchRun =
	| { phase: "captured"; plan: ApplyPatchPlan; before?: SnapshotSet }
	| { phase: "finalizing"; plan: ApplyPatchPlan; task: Promise<ApplyPatchViewModel | undefined> }
	| { phase: "ready"; plan: ApplyPatchPlan; viewModel: ApplyPatchViewModel };

type CapturedRun = Extract<ApplyPatchRun, { phase: "captured" }>;

export type BashUiUpdate = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

function updateText(update: BashUiUpdate): string {
	return update.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

export class ApplyPatchRunRegistry {
	private readonly runs = new Map<string, ApplyPatchRun>();
	/** 最近一次观察到的流式 update：ready 时用于向仍激活的 execute 重发 enriched update。 */
	private readonly lastUpdates = new Map<string, BashUiUpdate>();
	/** 观察 revision：worker 旧结果不得晚于新 raw update 或最终 result 到达（generation guard）。 */
	private readonly revisions = new Map<string, number>();
	/** wrapped execute 注册的转发口：worker ready 且 bash 仍在执行时主动重发一次。 */
	private readonly sinks = new Map<string, (update: BashUiUpdate) => void>();
	private batchCounter = 0;
	private readonly diffSubmitter: DiffBatchSubmitter = async (inputs: readonly DiffInput[]) => {
		try {
			const response = await requestDiffBatch(inputs, `apply-patch-${this.batchCounter++}`);
			return response.files;
		} catch {
			// worker 崩溃 / session dispose 已在 diff-service 记录单条结构化 diagnostic；
			// 这里静默降级 intent diff（已定义 degradation），避免并发 run × 文件数的日志风暴。
			return undefined;
		}
	};

	/** captured 阶段的 plan.command（execute 验证用）；无 run 或已离开 captured 返回 undefined。 */
	capturedPlanCommand(toolCallId: string): string | undefined {
		const run = this.runs.get(toolCallId);
		return run?.phase === "captured" ? run.plan.command : undefined;
	}

	/** tool_call：在并行 sibling execution 前捕获确定的 before state。可覆盖（execute 验证失败时重建轻量 run）。 */
	capture(toolCallId: string, plan: ApplyPatchPlan, before?: SnapshotSet): void {
		this.runs.set(toolCallId, { phase: "captured", plan, before });
	}

	/** wrapped execute 注册转发口；execute 结束后注销。 */
	attachSink(toolCallId: string, sink: (update: BashUiUpdate) => void): void {
		this.sinks.set(toolCallId, sink);
	}

	detachSink(toolCallId: string): void {
		this.sinks.delete(toolCallId);
	}

	/**
	 * 流式观察点（wrapped onUpdate）：原样返回可转发对象，不修改 input/output/error/order。
	 * terminal block 首次完整 → 原子转入 finalizing（冻结 after + worker diff）；
	 * ready 后把 view model 注入 update.details 供流式渲染消费。
	 */
	observe(toolCallId: string, update: BashUiUpdate): BashUiUpdate {
		const run = this.runs.get(toolCallId);
		if (!run) return update;
		const revision = (this.revisions.get(toolCallId) ?? 0) + 1;
		this.revisions.set(toolCallId, revision);
		this.lastUpdates.set(toolCallId, update);
		if (run.phase === "captured") {
			this.freezeIfTerminalComplete(run, updateText(update), revision);
		}
		const current = this.runs.get(toolCallId);
		if (current?.phase === "ready") {
			return { ...update, details: { ...update.details, bashUi: { applyPatch: current.viewModel } } };
		}
		return update;
	}

	/**
	 * tool_result：最后识别（若尚未冻结）→ await 最终化 → 清理 run。
	 * - ready → 直接消费 view model；
	 * - finalizing → await task（diff 在 worker 线程，主线程只等待）；
	 * - captured（输出不可解析/截断/失败）→ 无 view model。
	 */
	async finalize(toolCallId: string, text: string): Promise<ApplyPatchViewModel | undefined> {
		const run = this.runs.get(toolCallId);
		console.error("DBG finalize run:", run ? run.phase : "absent");
		if (!run) return undefined;
		if (run.phase === "captured") {
			const parsed = parseApplyPatchResultSequence(text);
			console.error("DBG finalize parsed:", parsed ? `${parsed.results.length}/${run.plan.invocations.length}` : "unparseable");
			this.freezeIfTerminalComplete(run, text, this.revisions.get(toolCallId) ?? 0);
		}
		const current = this.runs.get(toolCallId);
		this.remove(toolCallId);
		if (current?.phase === "ready") return current.viewModel;
		if (current?.phase === "finalizing") {
			try {
				return await current.task;
			} catch (error) {
				console.error(
					`bash-ui finalization failed toolCallId=${toolCallId} ` +
					`error=${error instanceof Error ? error.message : String(error)} ` +
					`action="delegating to built-in bash renderer"`,
				);
				return undefined;
			}
		}
		return undefined;
	}

	remove(toolCallId: string): void {
		this.runs.delete(toolCallId);
		this.lastUpdates.delete(toolCallId);
		this.revisions.delete(toolCallId);
		this.sinks.delete(toolCallId);
	}

	/** session_shutdown：清理所有 live run 并终止长期 worker（下次请求 lazy 重建）。 */
	clear(): void {
		this.runs.clear();
		this.lastUpdates.clear();
		this.revisions.clear();
		this.sinks.clear();
		disposeDiffService();
	}

	/** captured → finalizing 的原子转换：同一 tick 内检查 + 替换，无 await 间隙，天然幂等。 */
	private freezeIfTerminalComplete(run: CapturedRun, text: string, freezeRevision: number): void {
		const parsed = parseApplyPatchResultSequence(text);
		console.error("DBG freeze parsed:", parsed ? "ok" : "unparseable", "results:", parsed?.results.length, "invocations:", run.plan.invocations.length);
		if (!parsed || parsed.results.length !== run.plan.invocations.length) return;
		const task = this.buildTask(run, parsed);
		console.error("DBG freeze task scheduled");
		this.runs.set(run.toolCallId, { phase: "finalizing", plan: run.plan, task });
		void task.then(
			(viewModel) => {
				const current = this.runs.get(run.toolCallId);
				if (current?.phase !== "finalizing") return; // 已被 tool_result 清理
				if (viewModel) {
					this.runs.set(run.toolCallId, { phase: "ready", plan: run.plan, viewModel });
					// bash 仍执行（execute 未返回）且自冻结以来无新观察时，主动重发一次
					// 基于最新 accumulated output 的 enriched update（generation guard：
					// 有新观察时新 update 已走 observe 的 ready 注入路径，旧 text 不得覆盖）。
					const sink = this.sinks.get(run.toolCallId);
					const last = this.lastUpdates.get(run.toolCallId);
					if (sink && last && (this.revisions.get(run.toolCallId) ?? 0) === freezeRevision) {
						sink({ ...last, details: { ...last.details, bashUi: { applyPatch: viewModel } } });
					}
				} else {
					// 输出与 plan 不匹配（语义无法确认）：不再注入，等 tool_result 清理。
					this.runs.delete(run.toolCallId);
				}
			},
			(error) => {
				console.error(
					`bash-ui diff task failed toolCallId=${run.toolCallId} ` +
					`error=${error instanceof Error ? error.message : String(error)} ` +
					`action="delegating to built-in bash renderer"`,
				);
				this.runs.delete(run.toolCallId);
			},
		);
	}

	/** 冻结 after 快照（trailing command 改写文件前的最早观察点）+ 提交不可变 DiffInput batch 到 worker。 */
	private async buildTask(run: CapturedRun, parsed: ParsedApplyPatchResultSequence): Promise<ApplyPatchViewModel | undefined> {
		console.error("DBG buildTask start, before:", run.before ? "yes" : "no");
		const after = run.before ? await captureAfterSnapshots(run.plan, run.before) : undefined;
		console.error("DBG buildTask after captured:", after ? "yes" : "no");
		const vm = await buildResultViewModel(run.plan, parsed, run.before, after, this.diffSubmitter);
		console.error("DBG buildTask vm:", vm ? vm.kind : "undefined");
		return vm;
	}
}

export { buildApplyPatchPlan };
