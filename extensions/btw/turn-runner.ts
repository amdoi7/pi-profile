import type { Api, AssistantMessage, Model, TextContent, ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export const BTW_ENTRY_TYPE = "btw-thread-entry";
export const BTW_RESET_TYPE = "btw-thread-reset";

export type SessionThinkingLevel = "off" | AiThinkingLevel;

/** One completed side exchange, persisted as a custom session entry. */
export type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage["usage"];
};

export type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	/** Raw args from the session event; formatted at render time. */
	args: unknown;
	status: "running" | "done" | "error";
};

/**
 * The in-flight side turn. Single ownership value for the side session:
 * `state === "running"` owns it; `state === "failed"` is display-only and accepts a new turn.
 */
export type PendingTurn = {
	question: string;
	answer: string;
	toolCalls: ToolCallInfo[];
	state: "running" | "failed" | "stopped";
	error?: string;
	/** 用户主动停止(ESC)标记:abort 收尾走 stopped 路径,不报 error。 */
	userStop?: boolean;
};

export type SideSessionLike = {
	prompt(question: string): Promise<unknown>;
	getLastAssistantMessage(): AssistantMessage | null;
};

export type TurnRunnerDeps = {
	getModel(): Model<Api> | null;
	hasCredentials(model: Model<Api>): boolean;
	ensureSideSession(): Promise<SideSessionLike | null>;
	getThinkingLevel(): SessionThinkingLevel;
	setStatus(status: string): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** Called synchronously once the turn is claimed, before any await. */
	onAccepted?(): void;
	onTurnComplete(details: BtwDetails): void;
};

export function extractText(parts: AssistantMessage["content"]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Events carrying an assistant message snapshot (streamed text updates). */
type AssistantMessageEvent = Extract<
	AgentSessionEvent,
	{ type: "message_start" | "message_update" | "message_end" }
>;

function extractEventAssistantText(event: AgentSessionEvent): string {
	if (
		event.type !== "message_start" &&
		event.type !== "message_update" &&
		event.type !== "message_end"
	) {
		return "";
	}
	const message = (event as AssistantMessageEvent).message;
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}

	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Apply a side-session event to the running turn.
 * Returns the status label to display, or null when the event needs no status change.
 */
export function applyTurnEvent(turn: PendingTurn, event: AgentSessionEvent): string | null {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end": {
			const streamed = extractEventAssistantText(event);
			if (streamed) {
				turn.answer = streamed;
				turn.error = undefined;
			}
			return event.type === "message_end" ? "Finalizing side response..." : "Streaming side response...";
		}
		case "tool_execution_start":
			turn.toolCalls.push({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				status: "running",
			});
			return `Running tool: ${event.toolName}...`;
		case "tool_execution_end": {
			const tc = turn.toolCalls.find((t) => t.toolCallId === event.toolCallId);
			if (tc) {
				tc.status = event.isError ? "error" : "done";
			}
			return "Streaming side response...";
		}
		case "turn_end":
			return "Finalizing side response...";
		default:
			return null;
	}
}

export type BranchEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

/** Scan the session branch for the side thread: entries after the last reset marker. */
export function collectThreadEntries(branch: BranchEntryLike[]): BtwDetails[] {
	let lastResetIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i].type === "custom" && branch[i].customType === BTW_RESET_TYPE) {
			lastResetIndex = i;
		}
	}

	const thread: BtwDetails[] = [];
	for (const entry of branch.slice(lastResetIndex + 1)) {
		if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) {
			continue;
		}
		const details = entry.data as BtwDetails | undefined;
		if (!details?.question || !details.answer) {
			continue;
		}
		thread.push(details);
	}
	return thread;
}

export class TurnRunner {
	private turn: PendingTurn | null = null;

	/** Bumped on reset so an in-flight run knows its ownership was revoked mid-flight. */
	private epoch = 0;

	get busy(): boolean {
		return this.turn !== null && this.turn.state === "running";
	}

	get current(): PendingTurn | null {
		return this.turn;
	}

	reset(): void {
		this.turn = null;
		this.epoch += 1;
	}

	/**
	 * 用户主动停止(ESC):标记在途 turn,后续 abort 收尾(resolve-aborted 与 reject
	 * 两种形态)落 stopped 而非 failed。实际 abort 由调用方对 side session 执行。
	 * 返回 false = 无在途 turn,调用方不必 abort。
	 */
	requestStop(): boolean {
		if (!this.busy || !this.turn) return false;
		this.turn.userStop = true;
		return true;
	}

	applyEvent(event: AgentSessionEvent): string | null {
		const turn = this.turn;
		if (!turn || turn.state !== "running") {
			return null;
		}
		return applyTurnEvent(turn, event);
	}

	/**
	 * Run one side turn. Returns true when the submission was accepted
	 * (claimed, including failures), false when it was rejected because
	 * another turn is still in flight.
	 *
	 * `deps.onAccepted` fires synchronously on acceptance: the caller must not wait for
	 * the returned promise to react to it — that only settles when the whole turn is done.
	 */
	async run(question: string, deps: TurnRunnerDeps): Promise<boolean> {
		// Claim synchronously at entry: any later submit is rejected while this turn is in flight.
		if (this.busy) {
			deps.notify("BTW is still processing the previous message — Esc to stop.", "warning");
			return false;
		}
		this.turn = { question, answer: "", toolCalls: [], state: "running" };
		const epoch = this.epoch;
		deps.onAccepted?.();
		deps.setStatus("Streaming side response...");
		await this.execute(question, deps, epoch);
		return true;
	}

	private async execute(question: string, deps: TurnRunnerDeps, epoch: number): Promise<void> {
		try {
			const model = deps.getModel();
			if (!model) {
				this.fail(deps, "No active model selected.", epoch);
				return;
			}

			if (!deps.hasCredentials(model)) {
				this.fail(deps, `No credentials available for ${model.provider}/${model.id}.`, epoch);
				return;
			}

			const side = await deps.ensureSideSession();
			if (!side) {
				this.fail(deps, "Unable to create BTW side session.", epoch);
				return;
			}

			await side.prompt(question);
			const response = side.getLastAssistantMessage();
			if (!response) {
				throw new Error("BTW request finished without a response.");
			}
			if (response.stopReason === "aborted") {
				if (this.turn?.userStop) {
					this.stopped(deps, epoch);
					return;
				}
				throw new Error("BTW request aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "BTW request failed.");
			}

			const answer = extractText(response.content) || "(No text response)";
			const turn = this.turn;
			if (this.epoch !== epoch || !turn) {
				// Ownership revoked mid-run (reset/restore): discard the result.
				return;
			}
			turn.answer = answer;
			deps.onTurnComplete({
				question,
				answer,
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				thinkingLevel: deps.getThinkingLevel(),
				usage: response.usage,
			});
			this.turn = null;
			deps.setStatus("Ready for the next side question.");
		} catch (error) {
			if (this.turn?.userStop) {
				this.stopped(deps, epoch);
				return;
			}
			this.fail(deps, error instanceof Error ? error.message : String(error), epoch);
		}
	}

	/** 用户停止的收尾:stopped 是用户意图的终态,不是错误——不置 error,不报 error 级通知。 */
	private stopped(deps: TurnRunnerDeps, epoch: number): void {
		if (this.epoch !== epoch) {
			return;
		}
		const turn = this.turn;
		if (!turn) {
			return;
		}
		turn.state = "stopped";
		deps.setStatus("Stopped.");
		deps.notify("BTW turn stopped.", "info");
	}

	private fail(deps: TurnRunnerDeps, message: string, epoch: number): void {
		if (this.epoch !== epoch) {
			// Reset happened while the run was suspended; nothing to display.
			return;
		}
		const turn = this.turn;
		if (!turn) {
			// fail() is only reachable after a successful claim.
			return;
		}
		turn.error = message;
		turn.state = "failed";
		deps.setStatus(message);
		deps.notify(message, "error");
	}
}
