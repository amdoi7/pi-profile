import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

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

function fileMutationComponent(item: FileMutationRenderItem, theme: Theme): Container {
	const block = new Container();
	block.addChild(new Text(item.title, 0, 0));
	if (item.outcome === "failed") {
		block.addChild(new Spacer(1));
		block.addChild(new Text(theme.fg("error", item.message), 0, 0));
		return block;
	}
	if (item.outcome === "pending") return block;
	for (const preview of item.previews) {
		block.addChild(new DiffPreviewComponent(preview, theme));
	}
	return block;
}

export function appendFileMutationBatch(
	container: Container,
	items: readonly FileMutationRenderItem[],
	theme: Theme,
): void {
	for (const item of items) container.addChild(fileMutationComponent(item, theme));
}
