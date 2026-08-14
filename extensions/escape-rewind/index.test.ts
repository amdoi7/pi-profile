import {
	installEscapeWrapper,
	installSubmitWrapper,
	isRetractablePromptSubmission,
	navigateToSubmittedMessageForRewrite,
} from "./index.ts";
import { describe, expect, test } from "vitest";

describe("escape-rewind", () => {
	function assertAppearsInOrder(events: string[], expected: string[]) {
		let lastIndex = -1;
		for (const event of expected) {
			const nextIndex = events.indexOf(event, lastIndex + 1);
			expect(nextIndex).toBeGreaterThan(lastIndex);
			lastIndex = nextIndex;
		}
	}

	test("tracks only ordinary idle prompts", () => {
		expect(isRetractablePromptSubmission("fix this bug", false, false)).toBe(true);
		expect(isRetractablePromptSubmission("   ", false, false)).toBe(false);
		expect(isRetractablePromptSubmission("/tree", false, false)).toBe(false);
		expect(isRetractablePromptSubmission("!ls", false, false)).toBe(false);
		expect(isRetractablePromptSubmission("hello", true, false)).toBe(false);
		expect(isRetractablePromptSubmission("hello", false, true)).toBe(false);
	});

	test("navigateToSubmittedMessageForRewrite jumps with no summary and restores editor", async () => {
		const events: string[] = [];
		await navigateToSubmittedMessageForRewrite(
			{
				session: {
					async navigateTree(targetId: string, options?: { summarize?: boolean }) {
						events.push(`navigate:${targetId}:${String(options?.summarize)}`);
						return { cancelled: false, editorText: "rewrite me" };
					},
				},
				chatContainer: { clear: () => events.push("clear-chat") },
				renderInitialMessages: () => events.push("render-messages"),
				editor: { setText: (text: string) => events.push(`editor:${text}`) },
				showStatus: () => events.push("status"),
				flushCompactionQueue: () => events.push("flush"),
				ui: { requestRender: () => events.push("render-ui") },
			} as any,
			"user-entry",
		);
		assertAppearsInOrder(events, [
			"navigate:user-entry:false",
			"clear-chat",
			"render-messages",
			"editor:rewrite me",
			"status",
			"flush",
			"render-ui",
		]);
	});

	test("first esc aborts and second esc rewrites from current leaf", async () => {
		const events: string[] = [];
		const mode = {
			defaultEditor: {
				onEscape() {
					events.push("native-escape");
				},
				async onSubmit(text: string) {
					events.push(`submit:${text}`);
				},
			},
			editor: { setText: (text: string) => events.push(`editor:${text}`) },
			session: {
				isStreaming: false,
				isCompacting: false,
				async abort() {
					events.push("abort");
				},
				async navigateTree(targetId: string, options?: { summarize?: boolean }) {
					events.push(`navigate:${targetId}:${String(options?.summarize)}`);
					return { cancelled: false, editorText: "rewrite me" };
				},
			},
			sessionManager: {
				getLeafId() {
					return "user-entry";
				},
			},
			chatContainer: { clear: () => events.push("clear-chat") },
			renderInitialMessages: () => events.push("render-messages"),
			showStatus: () => events.push("status"),
			flushCompactionQueue: () => events.push("flush"),
			ui: { requestRender: () => events.push("render-ui") },
		} as any;

		installSubmitWrapper(mode);
		installEscapeWrapper(mode);
		await mode.defaultEditor.onSubmit("retry this prompt");
		mode.defaultEditor.onEscape();
		mode.defaultEditor.onEscape();
		await Promise.resolve();
		await Promise.resolve();

		assertAppearsInOrder(events, [
			"submit:retry this prompt",
			"abort",
			"navigate:user-entry:false",
			"clear-chat",
			"render-messages",
			"editor:rewrite me",
			"status",
			"flush",
		]);
		expect(events.filter((event) => event === "render-ui").length).toBeGreaterThanOrEqual(2);
	});

	test("falls through after assistant starts", () => {
		const events: string[] = [];
		const mode = {
			defaultEditor: {
				onEscape() {
					events.push("native-escape");
				},
			},
			session: {
				isStreaming: false,
				isCompacting: false,
				abort() {
					events.push("abort");
				},
				navigateTree() {
					throw new Error("should not navigate");
				},
			},
			sessionManager: { getLeafId: () => "user-entry" },
			chatContainer: { clear() {} },
			renderInitialMessages() {},
			showStatus() {},
			flushCompactionQueue() {},
			ui: { requestRender() {} },
			[Symbol.for("amdoi7.pi.escapeRewind.state")]: {
				pendingRewrite: true,
				assistantStarted: true,
				armedEntryId: null,
				armedUntilMs: 0,
				deferUntilIdle: false,
			},
		} as any;

		installEscapeWrapper(mode);
		mode.defaultEditor.onEscape();
		expect(events).toEqual(["native-escape"]);
	});
});
