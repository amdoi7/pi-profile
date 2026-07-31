import { generateFinalDiff, type ChangeStats } from "../_shared/final-diff.ts";

export type { ChangeStats };

export type EditPreview = {
	previewText: string;
	previewStartLine?: number;
	previewTruncated: boolean;
	changeStats: ChangeStats;
};

export function generateEditPreview(
	oldContent: string,
	newContent: string,
	contextLines?: number,
): EditPreview {
	const diff = generateFinalDiff(oldContent, newContent, contextLines);
	return {
		previewText: diff.text,
		previewStartLine: diff.firstChangedLine,
		previewTruncated: diff.truncated,
		changeStats: diff.stats,
	};
}
