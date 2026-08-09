import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

type BtwTheme = ExtensionContext["ui"]["theme"];

/**
 * Height budget of the overlay, in percent of terminal rows. The TUI clips overlay
 * lines beyond its own `maxHeight`, so render() must size the dialog against the same
 * number — keep this in sync with the `maxHeight` passed in the overlay options.
 */
export const BTW_OVERLAY_MAX_HEIGHT_PERCENT = 78;

/** Non-transcript dialog lines: 2 borders + title + hint + 2 separators + status + input + footer. */
const CHROME_LINES = 9;
const MIN_TRANSCRIPT_LINES = 3;
const MAX_TRANSCRIPT_LINES = 21;

/**
 * The BTW side-chat overlay: dialog chrome, scrolling transcript window, and
 * the input line. Rendering-only — all state (thread, status, draft) lives in
 * the owning extension and is injected via the callbacks.
 */
export class BtwOverlay extends Container implements Focusable {
	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: BtwTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (width: number, theme: BtwTheme) => string[];
	private readonly getStatus: () => string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private _focused = false;
	/** 距 transcript 底部的滚动行数；0 = 显示最新（底部对齐）。 */
	private scrollOffset = 0;
	/** 上次渲染的 transcript 行数（新内容追加时保持阅读位置）。 */
	private lastTranscriptLength = 0;
	/** 上次渲染的 transcript 视口高度（滚动键的翻页步长）。 */
	private lastTranscriptHeight = 0;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: BtwTheme,
		keybindings: KeybindingsManager,
		getTranscript: (width: number, theme: BtwTheme) => string[],
		getStatus: () => string,
		onSubmit: (value: string) => void,
		onDismiss: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.getTranscript = getTranscript;
		this.getStatus = getStatus;
		this.onSubmitCallback = onSubmit;
		this.onDismissCallback = onDismiss;

		this.input = new Input();
		this.input.onSubmit = (value) => {
			this.onSubmitCallback(value);
		};
		this.input.onEscape = () => {
			this.onDismissCallback();
		};
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDismissCallback();
			return;
		}
		if (this.handleScrollInput(data)) return;
		this.input.handleInput(data);
	}

	/**
	 * ↑/↓ scroll the transcript by a line, ctrl+PgUp/ctrl+PgDn by a page; when there is
	 * nothing to scroll the key falls through to the input.
	 *
	 * Bare PageUp/PageDown never reach us: in fullscreen mode the alt-screen viewport
	 * registers a TUI input listener that consumes `tui.altScreen.pageUp`/`pageDown`
	 * before input is dispatched to the focused component (and it scrolls the main
	 * transcript behind the overlay instead). `tui.editor.pageUp`/`pageDown` also bind
	 * ctrl+PageUp/ctrl+PageDown, which the viewport leaves alone — those are the page
	 * keys that work here. Mouse wheel is likewise owned by the viewport: overlays are
	 * composited outside the layout frame, so a ScrollView inside one is not reachable
	 * by wheel routing.
	 */
	private handleScrollInput(data: string): boolean {
		const up = this.keybindings.matches(data, "tui.editor.cursorUp");
		const down = this.keybindings.matches(data, "tui.editor.cursorDown");
		const pageUp = this.keybindings.matches(data, "tui.editor.pageUp");
		const pageDown = this.keybindings.matches(data, "tui.editor.pageDown");
		if (!up && !down && !pageUp && !pageDown) return false;
		const maxScroll = Math.max(0, this.lastTranscriptLength - this.lastTranscriptHeight);
		if (maxScroll === 0) return false;
		if (up) {
			this.scrollOffset = Math.min(this.scrollOffset + 1, maxScroll);
		} else if (down) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (pageUp) {
			this.scrollOffset = Math.min(this.scrollOffset + this.lastTranscriptHeight, maxScroll);
		} else {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.lastTranscriptHeight);
		}
		this.tui.requestRender();
		return true;
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	override render(width: number): string[] {
		// `width` is already the overlay width the TUI resolved from the overlay options;
		// rendering narrower than that would leave the dialog off-centre inside its box.
		const innerWidth = Math.max(40, width - 2);
		const terminalRows = process.stdout.rows ?? 30;
		// Stay inside the TUI's own height budget: anything taller is clipped from the
		// bottom, which is where the input line lives.
		const heightBudget = Math.min(
			Math.floor((terminalRows * BTW_OVERLAY_MAX_HEIGHT_PERCENT) / 100),
			terminalRows - 1,
		);
		const transcriptHeight = Math.max(
			MIN_TRANSCRIPT_LINES,
			Math.min(MAX_TRANSCRIPT_LINES, heightBudget - CHROME_LINES),
		);

		const transcript = this.getTranscript(innerWidth, this.theme);
		// 新内容追加时保持阅读位置：offset 随底部下移（offset=0 时跟随最新）。
		if (this.scrollOffset > 0 && transcript.length > this.lastTranscriptLength) {
			this.scrollOffset += transcript.length - this.lastTranscriptLength;
		}
		this.lastTranscriptLength = transcript.length;
		this.lastTranscriptHeight = transcriptHeight;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, transcript.length - transcriptHeight));
		const windowEnd = transcript.length - this.scrollOffset;
		const windowStart = Math.max(0, windowEnd - transcriptHeight);
		const visibleTranscript = transcript.slice(windowStart, windowEnd);
		const transcriptPadding = Math.max(0, transcriptHeight - visibleTranscript.length);

		const status = this.getStatus();
		const statusLine = this.scrollOffset > 0
			? `${this.theme.fg("dim", `↑ ${this.scrollOffset} `)}${this.theme.fg("warning", status)}`
			: this.theme.fg("warning", status);

		const previousFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? "";
		this.input.focused = previousFocused;

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
			this.frameLine(this.theme.fg("dim", "Separate side conversation. Esc closes."), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
		];

		for (const line of visibleTranscript) {
			lines.push(this.frameLine(line, innerWidth));
		}
		for (let i = 0; i < transcriptPadding; i++) {
			lines.push(this.frameLine("", innerWidth));
		}

		lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
		lines.push(this.frameLine(statusLine, innerWidth));
		lines.push(
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
		);
		lines.push(this.frameLine(this.theme.fg("dim", "Enter submit · ↑↓ scroll · Esc close"), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));

		return lines;
	}
}
