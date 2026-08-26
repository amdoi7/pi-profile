import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { DiffPreviewComponent, type DiffPreview } from "./diff-view.ts";

type FileMutationItemBase = {
	title: string;
};

export type FileMutationRenderItem =
	| FileMutationItemBase & { outcome: "pending" }
	| FileMutationItemBase & {
		outcome: "applied";
		previews: DiffPreview[];
	}
	| FileMutationItemBase & {
		outcome: "failed";
		message: string;
	};

type ToolRenderContext = {
	lastComponent?: unknown;
	state: Record<string, unknown>;
};

type FileMutationRenderState = {
	pendingCallComponent?: Container;
};

function reusableContainer(context: ToolRenderContext): Container {
	const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();
	return container;
}

function renderState(context: ToolRenderContext): FileMutationRenderState {
	return context.state as FileMutationRenderState;
}

export function beginPendingFileMutationRender(context: ToolRenderContext): Container {
	const container = reusableContainer(context);
	renderState(context).pendingCallComponent = container;
	return container;
}

export function clearPendingFileMutationRender(context: ToolRenderContext): void {
	const state = renderState(context);
	state.pendingCallComponent?.clear();
	state.pendingCallComponent = undefined;
}

export function beginFileMutationResultRender(context: ToolRenderContext): Container {
	clearPendingFileMutationRender(context);
	return reusableContainer(context);
}

/**
 * 标题/消息用 Text 的 paddingX 而不是字符串前缀来上 rail：paddingX 逐行施加，
 * 前缀只能给第一行。批次视图的归属全靠缩进，而 hint / 长路径在常见宽度下就会折行，
 * 续行顶格等于层级契约在最长的那些行上失效。diff 行不走这里：它们自己排版。
 */
function fileMutationComponent(item: FileMutationRenderItem, theme: Theme, rail = ""): Container {
	const block = new Container();
	block.addChild(new Text(item.title, rail.length, 0));
	if (item.outcome === "failed") {
		block.addChild(new Text(theme.fg("error", item.message), rail.length, 0));
		return block;
	}
	if (item.outcome === "pending") return block;
	for (const preview of item.previews) {
		block.addChild(new DiffPreviewComponent(preview, theme, rail));
	}
	return block;
}

export function appendFileMutationBatch(
	container: Container,
	items: readonly FileMutationRenderItem[],
	theme: Theme,
	rail = "",
): void {
	for (const item of items) container.addChild(fileMutationComponent(item, theme, rail));
}
