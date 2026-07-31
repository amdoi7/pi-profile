import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type CustomEntry<T> = {
	type?: string;
	customType?: string;
	data?: T;
};

export function readLatestCustomEntry<T>(
	ctx: Pick<ExtensionContext, "sessionManager">,
	customType: string,
	options?: { branchOnly?: boolean },
): T | undefined {
	const entries = options?.branchOnly ? ctx.sessionManager.getBranch() : ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as CustomEntry<T>;
		if (entry.type === "custom" && entry.customType === customType) {
			return entry.data;
		}
	}
	return undefined;
}
