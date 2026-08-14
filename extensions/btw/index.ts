import {
	buildSessionContext,
	convertToLlm,
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ModelRegistry,
	type ResourceLoader,
	type SessionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import {
	Markdown,
	truncateToWidth,
	type OverlayHandle,
} from "@earendil-works/pi-tui";

import { on, registerCommand } from "../_shared/mode-gate.ts";
import { BTW_OVERLAY_MAX_HEIGHT_PERCENT, BtwOverlay, nextEscapeAction } from "./overlay.ts";
import { seedSideSessionMessages } from "./session-seeding.ts";
import {
	BTW_ENTRY_TYPE,
	BTW_RESET_TYPE,
	TurnRunner,
	collectThreadEntries,
	extractText,
	type BtwDetails,
	type SessionThinkingLevel,
	type ToolCallInfo,
	type TurnRunnerDeps,
} from "./turn-runner.ts";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

type SideSessionRuntime = {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
};

/**
 * Overlay lifecycle with a single closed transition.
 *
 * - close() is idempotent and is the only place `closed` becomes true.
 * - attachHandle() handles the closed-before-mount case by hiding the handle immediately.
 * - captureDraft/finish are wired once when the overlay mounts.
 */
class OverlayRuntime {
	handle: OverlayHandle | null = null;
	refresh: (() => void) | null = null;
	setDraft: ((value: string) => void) | null = null;
	private finish: (() => void) | null = null;
	private captureDraft: (() => void) | null = null;
	private _closed = false;

	get isClosed(): boolean {
		return this._closed;
	}

	setFinish(fn: () => void): void {
		this.finish = fn;
	}

	setCaptureDraft(fn: () => void): void {
		this.captureDraft = fn;
	}

	attachHandle(handle: OverlayHandle): void {
		this.handle = handle;
		handle.focus();
		if (this._closed) {
			handle.hide();
		}
	}

	close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this.captureDraft?.();
		this.handle?.hide();
		this.finish?.();
	}
}

// Couples to the exact "Current date and time/Current working directory" footer format appended
// by pi to dynamic system prompts. Upstream has no getStaticSystemPrompt() yet — feature request
// open so this regex can be deleted once the static prompt is available.
function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createBtwResourceLoader(ctx: ExtensionContext, appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT]): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => appendSystemPrompt,
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const message = session.state.messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return null;
}

function buildSeedMessages(ctx: ExtensionContext, model: Model<Api>, thread: BtwDetails[]): Message[] {
	const seed: Message[] = [];
	const entries = ctx.sessionManager.getEntries();

	let contextMessages: SessionContext["messages"];
	try {
		contextMessages = buildSessionContext(entries, ctx.sessionManager.getLeafId()).messages;
	} catch (error) {
		// Empty (fresh) sessions never throw here — buildSessionContext returns an empty context.
		// A throw means the main conversation context is genuinely broken; seeding an empty side
		// session would silently answer out of context, so fail at this boundary instead.
		throw new Error(
			`BTW: main conversation context unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Main-context messages are AgentMessages (may include bashExecution/custom); convert
	// to LLM-compatible messages exactly like the main agent does before an LLM call.
	seed.push(...convertToLlm(contextMessages));

	for (const item of thread) {
		seed.push(
			{
				role: "user",
				content: [{ type: "text", text: item.question }],
				timestamp: item.timestamp,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: item.answer }],
				provider: item.provider,
				model: item.model,
				api: model.api,
				// Backward compat: older persisted entries may lack usage data.
				usage: item.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: item.timestamp,
			},
		);
	}

	return seed;
}

function formatThread(thread: BtwDetails[]): string {
	return thread
		.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
		.join("\n\n---\n\n");
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

// Sync credential check: ModelRegistry is pi's synchronous extension facade.
function hasModelCredentials(modelRegistry: ModelRegistry, model: Model<Api>): boolean {
	return modelRegistry.hasConfiguredAuth(model);
}

/** Teardown shared by side-session disposal and summary sessions. */
async function abortAndDisposeSession(session: AgentSession): Promise<void> {
	try {
		await session.abort();
	} catch {
		// abort() may fail if session already finished — safe to ignore during teardown.
	}
	session.dispose();
}

export default function (pi: ExtensionAPI) {
	let thread: BtwDetails[] = [];
	let overlayStatus = "Ready";
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	const overlayEscapeState = { lastEscapeAt: 0 };
	const turnRunner = new TurnRunner();

	const mdTheme = getMarkdownTheme();

	function getModelKey(ctx: ExtensionContext): string {
		const model = ctx.model;
		return model ? `${model.provider}/${model.id}` : "none";
	}

	function renderMarkdownLines(text: string, width: number): string[] {
		if (!text) return [];
		const md = new Markdown(text, 0, 0, mdTheme);
		return md.render(width);
	}

	function pushUserLine(
		lines: string[],
		question: string,
		theme: ExtensionContext["ui"]["theme"],
		width: number,
	): void {
		const userText = question.trim().split("\n")[0];
		lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
	}

	function formatToolArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		switch (toolName) {
			case "bash":
				return typeof a.command === "string" ? truncateToWidth(a.command.split("\n")[0], 50, "…") : "";
			case "read":
			case "write":
			case "edit":
				return typeof a.path === "string" ? a.path : "";
			default: {
				const first = Object.values(a)[0];
				return typeof first === "string" ? truncateToWidth(first.split("\n")[0], 40, "…") : "";
			}
		}
	}

	function renderToolCallLines(toolCalls: ToolCallInfo[], theme: ExtensionContext["ui"]["theme"], width: number): string[] {
		const lines: string[] = [];
		for (const tc of toolCalls) {
			const icon = tc.status === "running" ? "⚙" : tc.status === "error" ? "✗" : "✓";
			const color = tc.status === "error" ? "error" : tc.status === "done" ? "success" : "dim";
			const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", tc.toolName);
			const args = formatToolArgs(tc.toolName, tc.args);
			const argsText = args ? theme.fg("dim", ` ${args}`) : "";
			lines.push(truncateToWidth(`  ${label}${argsText}`, width, ""));
		}
		return lines;
	}

	function getTranscriptLines(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		try {
			return getTranscriptLinesInner(width, theme);
		} catch (error) {
			return [theme.fg("error", `Render error: ${error instanceof Error ? error.message : String(error)}`)];
		}
	}

	function getTranscriptLinesInner(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		const pending = turnRunner.current;
		if (thread.length === 0 && !pending) {
			return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
		}

		const lines: string[] = [];
		// 全量 thread：overlay 内可滚动查看完整上下文（BtwOverlay 维护滚动窗口）。
		for (const item of thread) {
			pushUserLine(lines, item.question, theme, width);
			lines.push("");

			const mdLines = renderMarkdownLines(item.answer, width);
			lines.push(...mdLines);
			lines.push("");
		}

		if (pending) {
			pushUserLine(lines, pending.question, theme, width);

			if (pending.toolCalls.length > 0) {
				lines.push(...renderToolCallLines(pending.toolCalls, theme, width));
			}

			if (pending.state === "stopped") {
				lines.push(theme.fg("dim", "■ Stopped."));
			} else if (pending.error) {
				lines.push(theme.fg("error", `❌ ${pending.error}`));
			} else if (pending.answer) {
				lines.push("");
				const mdLines = renderMarkdownLines(pending.answer, width);
				lines.push(...mdLines);
			} else if (pending.toolCalls.length === 0) {
				lines.push(theme.fg("dim", "…"));
			}
		}

		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	}

	function syncOverlay(): void {
		overlayRuntime?.refresh?.();
	}

	function scheduleOverlayRefresh(): void {
		if (overlayRefreshTimer) {
			return;
		}

		overlayRefreshTimer = setTimeout(() => {
			overlayRefreshTimer = null;
			syncOverlay();
		}, 16);
	}

	function setOverlayStatus(status: string, throttled = false): void {
		overlayStatus = status;
		if (throttled) {
			scheduleOverlayRefresh();
		} else {
			syncOverlay();
		}
	}

	function dismissOverlay(): void {
		overlayRuntime?.close();
		overlayRuntime = null;
		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	function setOverlayDraft(value: string): void {
		overlayDraft = value;
		overlayRuntime?.setDraft?.(value);
	}

	async function disposeSideSession(): Promise<void> {
		const current = activeSideSession;
		activeSideSession = null;
		if (!current) {
			return;
		}

		current.unsubscribe();
		await abortAndDisposeSession(current.session);

		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	/** 清空线程与 overlay 状态（不动 side session 与持久化）。 */
	function clearThreadState(): void {
		thread = [];
		turnRunner.reset();
		setOverlayDraft("");
		setOverlayStatus("Ready");
	}

	async function resetThread(persist = true): Promise<void> {
		clearThreadState();
		await disposeSideSession();
		if (persist) {
			pi.appendEntry(BTW_RESET_TYPE, { timestamp: Date.now() });
		}
		syncOverlay();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		await disposeSideSession();
		clearThreadState();
		thread = collectThreadEntries(ctx.sessionManager.getBranch());
		syncOverlay();
	}

	async function createSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
			tools: ["read", "bash", "edit", "write"],
			resourceLoader: createBtwResourceLoader(ctx),
		});

		const seedMessages = buildSeedMessages(ctx, ctx.model, thread);
		seedSideSessionMessages(session, seedMessages);

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const status = turnRunner.applyEvent(event);
			if (status) {
				setOverlayStatus(status, true);
			}
		});

		return {
			session,
			modelKey: getModelKey(ctx),
			unsubscribe,
		};
	}

	async function ensureSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const expectedModelKey = getModelKey(ctx);
		if (activeSideSession && activeSideSession.modelKey === expectedModelKey) {
			return activeSideSession;
		}

		await disposeSideSession();
		activeSideSession = await createSideSession(ctx);
		return activeSideSession;
	}

	async function ensureOverlay(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			return;
		}

		if (overlayRuntime?.handle) {
			overlayRuntime.handle.setHidden(false);
			overlayRuntime.handle.focus();
			overlayRuntime.refresh?.();
			return;
		}

		const runtime = new OverlayRuntime();
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.setFinish(() => done());
					overlayEscapeState.lastEscapeAt = 0; // 挂载重置:重开后首个 ESC 不继承上次窗口

					const overlay = new BtwOverlay(
						tui,
						theme,
						keybindings,
						(width, t) => getTranscriptLines(width, t),
						() => overlayStatus,
						(value) => {
							void submitFromOverlay(ctx, value);
						},
						() => {
							const action = nextEscapeAction(overlayEscapeState, Date.now(), turnRunner.busy);
							if (action === "stop") {
								stopInFlightTurn();
							} else if (action === "close") {
								void closeOverlayFlow(ctx);
							}
							// none:idle 单 ESC 无操作,关闭只有双 ESC
						},
					);

					overlay.focused = true;
					overlay.setDraft(overlayDraft);
					runtime.setDraft = (value) => overlay.setDraft(value);
					runtime.refresh = () => {
						overlay.focused = runtime.handle?.isFocused() ?? false;
						tui.requestRender();
					};
					runtime.setCaptureDraft(() => {
						overlayDraft = overlay.getDraft();
					});

					if (runtime.isClosed) {
						done();
					}

					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 72,
						maxHeight: `${BTW_OVERLAY_MAX_HEIGHT_PERCENT}%`,
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => runtime.attachHandle(handle),
				},
			)
			.catch((error) => {
				if (overlayRuntime === runtime) {
					overlayRuntime = null;
				}
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			});
	}

	async function summarizeThread(ctx: ExtensionContext, items: BtwDetails[]): Promise<string> {
		const model = ctx.model;
		if (!model) {
			throw new Error("No active model selected.");
		}

		const hasCredentials = hasModelCredentials(ctx.modelRegistry, model);
		if (!hasCredentials) {
			throw new Error(`No credentials available for ${model.provider}/${model.id}.`);
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model,
			thinkingLevel: "off",
			tools: [],
			resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT]),
		});

		try {
			await session.prompt(formatThread(items), { source: "extension" });
			const response = getLastAssistantMessage(session);
			if (!response) {
				throw new Error("Summary finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("Summary request was aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Summary request failed.");
			}

			return extractText(response.content) || "(No summary generated)";
		} finally {
			await abortAndDisposeSession(session);
		}
	}

	async function injectSummaryIntoMain(ctx: ExtensionCommandContext): Promise<void> {
		if (thread.length === 0) {
			notify(ctx, "No BTW thread to summarize.", "warning");
			return;
		}

		setOverlayStatus("Summarizing BTW thread for injection...");
		try {
			const summary = await summarizeThread(ctx, thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}

			await resetThread();
			notify(ctx, "Injected BTW summary into main chat.", "info");
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	/** 单 ESC 停止在途 side turn:abort side session,in-flight prompt 以 stopReason=aborted
	 * 收尾,turn 落入 failed 态(overlay 保持打开,输入立即可用);关闭不杀活,杀活只此路径。 */
	function stopInFlightTurn(): void {
		const current = activeSideSession;
		if (!turnRunner.requestStop() || !current) return;
		void current.session.abort();
	}

	async function closeOverlayFlow(ctx: ExtensionCommandContext): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI) {
			return;
		}

		if (thread.length === 0) {
			return;
		}

		const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
		if (choice === "Inject summary into main chat") {
			await injectSummaryIntoMain(ctx);
		}
	}

	function buildTurnDeps(ctx: ExtensionCommandContext): TurnRunnerDeps {
		return {
			getModel: () => ctx.model ?? null,
			hasCredentials: (model) => hasModelCredentials(ctx.modelRegistry, model),
			ensureSideSession: async () => {
				const side = await ensureSideSession(ctx);
				if (!side) {
					return null;
				}
				return {
					prompt: (question) => side.session.prompt(question, { source: "extension" }),
					getLastAssistantMessage: () => getLastAssistantMessage(side.session),
				};
			},
			getThinkingLevel: () => pi.getThinkingLevel() as SessionThinkingLevel,
			setStatus: (status) => setOverlayStatus(status),
			notify: (message, level) => notify(ctx, message, level),
			// The submitted text has been taken over by the pending turn (it renders in the
			// transcript from here on), so empty the input immediately — waiting for the turn
			// to finish would leave the question sitting in the box for the whole response.
			onAccepted: () => setOverlayDraft(""),
			onTurnComplete: (details) => {
				// Persist first: the session file is the source of truth, thread is derived.
				pi.appendEntry(BTW_ENTRY_TYPE, details);
				thread.push(details);
			},
		};
	}

	function runBtwPrompt(ctx: ExtensionCommandContext, question: string): Promise<boolean> {
		return turnRunner.run(question, buildTurnDeps(ctx));
	}

	async function submitFromOverlay(ctx: ExtensionCommandContext, rawValue: string): Promise<void> {
		const question = rawValue.trim();
		if (!question) {
			setOverlayStatus("Enter a question first.");
			return;
		}

		// The draft is cleared by the runner's onAccepted hook; a rejected submit
		// (another turn in flight) keeps the user's input for editing.
		await runBtwPrompt(ctx, question);
	}

	registerCommand(pi, "btw", {
		description: "Open a side chat. Use `/btw <text>` to ask immediately.",
		modes: ["tui"],
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				if (thread.length > 0 && ctx.hasUI) {
					const choice = await ctx.ui.select("BTW side chat:", [
						"Continue previous conversation",
						"Start fresh",
					]);
					if (choice === "Continue previous conversation") {
						await disposeSideSession();
						setOverlayStatus("Continuing BTW thread.");
						await ensureOverlay(ctx);
					} else if (choice === "Start fresh") {
						await resetThread(true);
						setOverlayStatus("Ready");
						await ensureOverlay(ctx);
					}
				} else {
					await resetThread(true);
					setOverlayStatus("Ready");
					await ensureOverlay(ctx);
				}
				return;
			}

			await ensureOverlay(ctx);
			await runBtwPrompt(ctx, question);
		},
	});

	on(pi, "session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	}, ["tui"]);

	on(pi, "session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	}, ["tui"]);

	pi.on("session_shutdown", async () => {
		await disposeSideSession();
		dismissOverlay();
	});
}
