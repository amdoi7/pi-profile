import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hyperlink } from "@earendil-works/pi-tui";

export type FileLinkTheme = {
	fg(color: "accent", text: string): string;
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeToolPath(filePath: string): string {
	const withoutAtPrefix = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	const normalized = withoutAtPrefix.replace(UNICODE_SPACES, " ");
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}

export function resolveToolFilePath(filePath: string, cwd: string): string {
	const normalized = normalizeToolPath(filePath);
	return path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
}

export function renderFilePathLink(
	visiblePath: string,
	absolutePath: string,
	theme: FileLinkTheme,
): string {
	return theme.fg("accent", hyperlink(visiblePath, pathToFileURL(absolutePath).href));
}

export function renderCwdFilePathLink(
	visiblePath: string,
	targetPath: string,
	cwd: string,
	theme: FileLinkTheme,
): string {
	return renderFilePathLink(visiblePath, resolveToolFilePath(targetPath, cwd), theme);
}
