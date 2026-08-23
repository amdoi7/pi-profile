import { beforeAll, describe, expect, it } from "vitest";

import { createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";

import registerExtension from "../index.ts";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;
const STRIP_ANSI = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function makePi() {
	const registered = [];
	return {
		registerTool(tool) {
			registered.push(tool);
		},
		registered,
	};
}

function makeTheme() {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		inverse: (text) => text,
	};
}

function makeContext(command, overrides = {}) {
	return {
		args: { command },
		toolCallId: "tc-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

describe("bash-fish-render", () => {
	beforeAll(() => {
		// 内置 renderCall 的 formatBashCall 使用全局 theme,测试环境需先初始化。
		initTheme();
	});
	it("re-registers bash with renderCall override, delegating execute/renderResult", () => {
		const pi = makePi();
		registerExtension(pi);
		expect(pi.registered).toHaveLength(1);
		const tool = pi.registered[0];
		expect(tool.name).toBe("bash");
		const base = createBashToolDefinition(process.cwd());
		expect(typeof tool.renderCall).toBe("function");
		expect(tool.renderCall).not.toBe(base.renderCall);
		expect(tool.execute).toBeDefined();
		expect(tool.renderResult).toBeDefined();
	});

	it("renderCall colors a valid command with fish-style ANSI", () => {
		const pi = makePi();
		registerExtension(pi);
		const tool = pi.registered[0];
		const component = tool.renderCall(
			{ command: "ls /tmp && echo done" },
			makeTheme(),
			makeContext("ls /tmp && echo done"),
		);
		const output = component.render(200).join("\n");
		expect(STRIP_ANSI(output)).toContain("ls /tmp");
		expect(output).toMatch(ANSI_PATTERN);
	});

	it("renderCall leaves empty command plain", () => {
		const pi = makePi();
		registerExtension(pi);
		const tool = pi.registered[0];
		const component = tool.renderCall({}, makeTheme(), makeContext(""));
		const output = component.render(200).join("\n");
		expect(output).toContain("$");
		expect(output).toContain("...");
	});

	it("renderCall keeps heredoc markers intact", () => {
		const pi = makePi();
		registerExtension(pi);
		const tool = pi.registered[0];
		const command = `cat <<'PATCH'\nhello\nPATCH`;
		const component = tool.renderCall({ command }, makeTheme(), makeContext(command));
		const output = component.render(200).join("\n");
		expect(output).toContain("PATCH");
	});

	it("renderResult renders structured patchFiles as dual-gutter file diffs", async () => {
		const pi = makePi();
		registerExtension(pi);
		const tool = pi.registered[0];
		const { generateFinalDiff } = await import("../../_shared/final-diff.ts");
		const diff = generateFinalDiff("hello\nworld\n", "hello\npi\n");
		const result = {
			content: [{ type: "text", text: "Success. Updated the following files:\nM hello.txt" }],
			details: {
				patchFiles: [{
					kind: "Update",
					path: "hello.txt",
					cwd: "/tmp",
					changeStats: diff.stats,
					display: diff.display,
					truncated: diff.truncated,
				}],
			},
		};
		const component = tool.renderResult(
			result,
			{ isPartial: false, expanded: false },
			makeTheme(),
			makeContext("apply_patch '...'", { executionStarted: true }),
		);
		const output = component.render(120).join("\n")
			.replace(/\x1b\]8;;.*?(?:\x1b\\|\x07)/g, "")
			.replace(/\x1b\[[0-9;]*m/g, "");
		// 文件头：工具归因 + kind + 路径 + stats（与 edit 同源的 fileResultItem）。
		expect(output).toMatch(/apply_patch Update file .*hello\.txt · \+1 -1/);
		// 双列行号 gutter（与 edit 同源的 DiffPreviewComponent）：remove 行另一侧留空，add 行反之。
		expect(output).toMatch(/-2 {3}│ world/);
		expect(output).toMatch(/\+ {2}2 │ pi/);
	});

	it("renderResult without patchFiles delegates to the built-in shape", () => {
		const pi = makePi();
		registerExtension(pi);
		const tool = pi.registered[0];
		const component = tool.renderResult(
			{ content: [{ type: "text", text: "plain output" }], details: {} },
			{ isPartial: false, expanded: false },
			makeTheme(),
			makeContext("ls", { executionStarted: true }),
		);
		const output = STRIP_ANSI(component.render(120).join("\n"));
		expect(output).toContain("plain output");
		expect(output).not.toContain("│");
	});
});
