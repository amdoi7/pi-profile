import {
	generateDiffString,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

export type ChangeStats = {
	additions: number;
	deletions: number;
	changedLines: number;
};

export type FinalDiff = {
	text: string;
	firstChangedLine?: number;
	truncated: boolean;
	stats: ChangeStats;
};

function summarizeDiff(diff: string): ChangeStats {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) additions += 1;
		if (line.startsWith("-")) deletions += 1;
	}
	return { additions, deletions, changedLines: additions + deletions };
}

export function generateFinalDiff(
	oldContent: string,
	newContent: string,
	contextLines?: number,
): FinalDiff {
	const generated = generateDiffString(oldContent, newContent, contextLines);
	const truncated = truncateHead(generated.diff);
	return {
		text: truncated.content,
		firstChangedLine: generated.firstChangedLine,
		truncated: truncated.truncated,
		stats: summarizeDiff(generated.diff),
	};
}
