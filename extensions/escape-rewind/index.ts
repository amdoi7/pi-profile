import { InteractiveMode } from "@earendil-works/pi-coding-agent";

type RewriteCapableInteractiveMode = {
	defaultEditor: {
		onEscape?: (() => void) & { [key: symbol]: boolean | undefined };
		onSubmit?: ((text: string) => Promise<void> | void) & { [key: symbol]: boolean | undefined };
	};
	editor: {
		setText(text: string): void;
	};
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		abort(): Promise<void> | void;
		navigateTree(
			targetId: string,
			options?: { summarize?: boolean },
		): Promise<{ cancelled: boolean; aborted?: boolean; editorText?: string }>;
	};
	sessionManager: {
		getLeafId(): string | null;
	};
	chatContainer: { clear(): void };
	renderInitialMessages(): void;
	showStatus(message: string): void;
	flushCompactionQueue(options: { willRetry: boolean }): Promise<void> | void;
	ui: { requestRender(): void };
	[STATE_SYMBOL]?: EscapeRewriteState;
};

type EscapeRewriteState = {
	pendingRewrite: boolean;
	assistantStarted: boolean;
	armedEntryId: string | null;
	armedUntilMs: number;
	deferUntilIdle: boolean;
};

const PATCH_MARKER = Symbol.for("amdoi7.pi.escapeRewind.patchInstalled");
const ESCAPE_WRAPPER_MARKER = Symbol.for("amdoi7.pi.escapeRewind.escapeWrapped");
const SUBMIT_WRAPPER_MARKER = Symbol.for("amdoi7.pi.escapeRewind.submitWrapped");
const STATE_SYMBOL = Symbol.for("amdoi7.pi.escapeRewind.state");
const DOUBLE_ESCAPE_WINDOW_MS = 700;

export function isRetractablePromptSubmission(text: string, isStreaming: boolean, isCompacting: boolean): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	if (isStreaming || isCompacting) return false;
	if (trimmed.startsWith("/")) return false;
	if (trimmed.startsWith("!")) return false;
	return true;
}

function getState(mode: RewriteCapableInteractiveMode): EscapeRewriteState {
	if (!mode[STATE_SYMBOL]) {
		mode[STATE_SYMBOL] = {
			pendingRewrite: false,
			assistantStarted: false,
			armedEntryId: null,
			armedUntilMs: 0,
			deferUntilIdle: false,
		};
	}
	return mode[STATE_SYMBOL]!;
}

function clearPending(state: EscapeRewriteState): void {
	state.pendingRewrite = false;
	state.assistantStarted = false;
}

function clearArmed(state: EscapeRewriteState): void {
	state.armedEntryId = null;
	state.armedUntilMs = 0;
	state.deferUntilIdle = false;
}

function armRewrite(state: EscapeRewriteState, entryId: string): void {
	state.armedEntryId = entryId;
	state.armedUntilMs = Date.now() + DOUBLE_ESCAPE_WINDOW_MS;
	state.deferUntilIdle = false;
	clearPending(state);
}

function consumeArmedRewrite(state: EscapeRewriteState): string | null {
	if (!state.armedEntryId) return null;
	if (Date.now() > state.armedUntilMs) {
		clearArmed(state);
		return null;
	}
	const entryId = state.armedEntryId;
	clearArmed(state);
	return entryId;
}

export async function navigateToSubmittedMessageForRewrite(
	mode: RewriteCapableInteractiveMode,
	entryId: string,
): Promise<void> {
	const result = await mode.session.navigateTree(entryId, { summarize: false });
	if (result.cancelled || result.aborted) return;
	mode.chatContainer.clear();
	mode.renderInitialMessages();
	if (result.editorText) {
		mode.editor.setText(result.editorText);
	}
	mode.showStatus("Navigated to selected point");
	void mode.flushCompactionQueue({ willRetry: false });
	mode.ui.requestRender();
}

export function installEscapeWrapper(mode: RewriteCapableInteractiveMode): void {
	const originalEscape = mode.defaultEditor.onEscape;
	if (!originalEscape || originalEscape[ESCAPE_WRAPPER_MARKER]) return;

	const wrappedEscape = (() => {
		const state = getState(mode);
		const armedEntryId = consumeArmedRewrite(state);
		if (armedEntryId) {
			if (mode.session.isStreaming) {
				state.armedEntryId = armedEntryId;
				state.armedUntilMs = Date.now() + DOUBLE_ESCAPE_WINDOW_MS;
				state.deferUntilIdle = true;
				void mode.session.abort();
			} else {
				void navigateToSubmittedMessageForRewrite(mode, armedEntryId);
			}
			mode.ui.requestRender();
			return;
		}

		if (state.pendingRewrite && !state.assistantStarted) {
			const entryId = mode.sessionManager.getLeafId();
			if (entryId) {
				armRewrite(state, entryId);
				void mode.session.abort();
				mode.ui.requestRender();
				return;
			}
		}

		originalEscape();
	}) as typeof originalEscape;
	wrappedEscape[ESCAPE_WRAPPER_MARKER] = true;
	mode.defaultEditor.onEscape = wrappedEscape;
}

export function installSubmitWrapper(mode: RewriteCapableInteractiveMode): void {
	const originalSubmit = mode.defaultEditor.onSubmit;
	if (!originalSubmit || originalSubmit[SUBMIT_WRAPPER_MARKER]) return;

	const wrappedSubmit = (async (text: string) => {
		const state = getState(mode);
		clearPending(state);
		clearArmed(state);
		if (isRetractablePromptSubmission(text, mode.session.isStreaming, mode.session.isCompacting)) {
			state.pendingRewrite = true;
		}
		await originalSubmit(text);
	}) as typeof originalSubmit;
	wrappedSubmit[SUBMIT_WRAPPER_MARKER] = true;
	mode.defaultEditor.onSubmit = wrappedSubmit;
}

export function installEscapeRewindPatch(): void {
	const prototype = InteractiveMode.prototype as unknown as {
		[PATCH_MARKER]?: boolean;
		setupKeyHandlers?: () => void;
		setupEditorSubmitHandler?: () => void;
		handleEvent?: (event: { type?: string; message?: { role?: string } }) => Promise<void>;
	};

	if (prototype[PATCH_MARKER]) return;
	prototype[PATCH_MARKER] = true;

	const originalSetupKeyHandlers = prototype.setupKeyHandlers;
	if (originalSetupKeyHandlers) {
		prototype.setupKeyHandlers = function patchedSetupKeyHandlers(this: RewriteCapableInteractiveMode) {
			originalSetupKeyHandlers.call(this);
			installEscapeWrapper(this);
		};
	}

	const originalSetupEditorSubmitHandler = prototype.setupEditorSubmitHandler;
	if (originalSetupEditorSubmitHandler) {
		prototype.setupEditorSubmitHandler = function patchedSetupEditorSubmitHandler(this: RewriteCapableInteractiveMode) {
			originalSetupEditorSubmitHandler.call(this);
			installSubmitWrapper(this);
		};
	}

	const originalHandleEvent = prototype.handleEvent;
	if (originalHandleEvent) {
		prototype.handleEvent = async function patchedHandleEvent(
			this: RewriteCapableInteractiveMode,
			event: { type?: string; message?: { role?: string } },
		) {
			const state = getState(this);
			if ((event.type === "message_start" || event.type === "message_update") && event.message?.role === "assistant") {
				state.assistantStarted = true;
			}
			await originalHandleEvent.call(this, event);
			if (event.type === "agent_end") {
				clearPending(state);
				if (state.deferUntilIdle && state.armedEntryId && Date.now() <= state.armedUntilMs) {
					const entryId = state.armedEntryId;
					clearArmed(state);
					await navigateToSubmittedMessageForRewrite(this, entryId);
				}
			}
		};
	}
}

installEscapeRewindPatch();

export default function escapeRewindPlugin(): void {}
