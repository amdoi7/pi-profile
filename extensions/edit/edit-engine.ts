import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type FileEditOperation = {
	oldText: string;
	newText: string;
	expectedOccurrences?: number;
};

export type AppliedEditsResult = {
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

import type { ChangeStats } from "./preview.ts";
import { generateEditPreview } from "./preview.ts";
export { generateEditPreview };

export type MatchedEditSpan = {
	matchIndex: number;
	matchLength: number;
	newText: string;
};

export type ExecutedFileEditResult = {
	previewText: string;
	previewStartLine?: number;
	previewTruncated: boolean;
	changeStats: ChangeStats;
	summary: string;
};

// Hard file-size gate. Files larger than this are rejected before reading.
export const MAX_EDIT_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

export type RecoverableEditErrorKind = "NOT_FOUND" | "DUPLICATE_MATCH" | "OCCURRENCE_MISMATCH" | "NO_CHANGE";

export class EditToolError extends Error {
	readonly kind: RecoverableEditErrorKind;
	readonly displayPath?: string;
	readonly editIndex?: number;
	readonly occurrences?: number;

	constructor(
		message: string,
		kind: RecoverableEditErrorKind,
		details: {
			displayPath?: string;
			editIndex?: number;
			occurrences?: number;
		} = {},
	) {
		super(message);
		this.name = "EditToolError";
		this.kind = kind;
		this.displayPath = details.displayPath;
		this.editIndex = details.editIndex;
		this.occurrences = details.occurrences;
	}
}

export function isEditToolError(error: unknown): error is EditToolError {
	return error instanceof EditToolError;
}

export type EditEngineOperations = {
	access: (absolutePath: string) => Promise<void>;
	readFile: (absolutePath: string) => Promise<string>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	stat: (absolutePath: string) => Promise<{ size: number }>;
};

type MatchedEdit = MatchedEditSpan & {
	editIndex: number;
};

type ResolvedMatch = {
	matchIndex: number;
	actualOldText: string;
};

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";
export const defaultEditEngineOperations: EditEngineOperations = {
	access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
	readFile: (absolutePath) => readFile(absolutePath, "utf-8"),
	writeFile: (absolutePath, content) => writeFile(absolutePath, content, "utf-8"),
	stat: (absolutePath) => stat(absolutePath),
};

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) {
		return "\n";
	}
	if (crlfIdx === -1) {
		return "\n";
	}
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	// Fast path: most files have no \r at all.
	if (text.indexOf("\r") === -1) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForFuzzyMatch(text: string): string {
	// Fast path: most source files contain no curly quotes at all.
	if (
		text.indexOf(LEFT_SINGLE_CURLY_QUOTE) === -1 &&
		text.indexOf(RIGHT_SINGLE_CURLY_QUOTE) === -1 &&
		text.indexOf(LEFT_DOUBLE_CURLY_QUOTE) === -1 &&
		text.indexOf(RIGHT_DOUBLE_CURLY_QUOTE) === -1
	) {
		return text;
	}
	return text
		.replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
		.replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
		.replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
		.replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function findAllMatchIndices(content: string, needle: string): number[] {
	const indices: number[] = [];
	if (needle.length === 0) {
		return indices;
	}
	let fromIndex = 0;
	while (fromIndex <= content.length - needle.length) {
		const index = content.indexOf(needle, fromIndex);
		if (index === -1) {
			break;
		}
		indices.push(index);
		fromIndex = index + 1;
	}
	return indices;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): EditToolError {
	const ref = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
	return new EditToolError(
		`NOT_FOUND ${ref} in ${path}. oldText must match the file content exactly, including whitespace; line endings and curly quotes are normalized before matching.`,
		"NOT_FOUND",
		{
			displayPath: path,
			editIndex: totalEdits === 1 ? undefined : editIndex,
		},
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): EditToolError {
	const ref = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
	return new EditToolError(
		`DUPLICATE_MATCH ${ref} in ${path} (${occurrences} occurrences). oldText is not unique.`,
		"DUPLICATE_MATCH",
		{
			displayPath: path,
			editIndex: totalEdits === 1 ? undefined : editIndex,
			occurrences,
		},
	);
}

function getOccurrenceMismatchError(path: string, editIndex: number, totalEdits: number, expected: number, occurrences: number): EditToolError {
	const ref = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
	return new EditToolError(
		`OCCURRENCE_MISMATCH ${ref} in ${path} (expected ${expected} occurrence${expected === 1 ? "" : "s"}, found ${occurrences}).`,
		"OCCURRENCE_MISMATCH",
		{
			displayPath: path,
			editIndex: totalEdits === 1 ? undefined : editIndex,
			occurrences,
		},
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getInvalidExpectedOccurrencesError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`expectedOccurrences must be a positive integer in ${path}.`);
	}
	return new Error(`edits[${editIndex}].expectedOccurrences must be a positive integer in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): EditToolError {
	if (totalEdits === 1) {
		return new EditToolError(
			`No changes made to ${path}. The replacement produced identical content. This may mean the patch is already applied.`,
			"NO_CHANGE",
			{ displayPath: path },
		);
	}
	return new EditToolError(
		`No changes made to ${path}. The replacements produced identical content. This may mean the patch is already applied.`,
		"NO_CHANGE",
		{ displayPath: path },
	);
}

function resolveEditMatches(
	content: string,
	oldText: string,
	expectedOccurrences: number,
	expectedOccurrencesWasExplicit: boolean,
	path: string,
	editIndex: number,
	totalEdits: number,
	// Pre-normalized content passed in to avoid re-normalizing per edit.
	normalizedContentForFuzzy?: { content: string },
): ResolvedMatch[] {
	const exactMatches = findAllMatchIndices(content, oldText);
	if (exactMatches.length > 0) {
		if (!expectedOccurrencesWasExplicit && exactMatches.length > 1) {
			throw getDuplicateError(path, editIndex, totalEdits, exactMatches.length);
		}
		if (exactMatches.length !== expectedOccurrences) {
			throw getOccurrenceMismatchError(path, editIndex, totalEdits, expectedOccurrences, exactMatches.length);
		}
		return exactMatches.map((matchIndex) => ({
			matchIndex,
			actualOldText: oldText,
		}));
	}

	const fuzzyContent = normalizedContentForFuzzy?.content ?? normalizeForFuzzyMatch(content);
	const normalizedOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyMatches = findAllMatchIndices(fuzzyContent, normalizedOldText);
	if (fuzzyMatches.length === 0) {
		throw getNotFoundError(path, editIndex, totalEdits);
	}
	if (!expectedOccurrencesWasExplicit && fuzzyMatches.length > 1) {
		throw getDuplicateError(path, editIndex, totalEdits, fuzzyMatches.length);
	}
	if (fuzzyMatches.length !== expectedOccurrences) {
		throw getOccurrenceMismatchError(path, editIndex, totalEdits, expectedOccurrences, fuzzyMatches.length);
	}

	return fuzzyMatches.map((matchIndex) => ({
		matchIndex,
		actualOldText: content.substring(matchIndex, matchIndex + oldText.length),
	}));
}

const LETTER_RE = /\p{L}/u;

function isOpeningContext(chars: string[], index: number): boolean {
	if (index === 0) {
		return true;
	}
	const previous = chars[index - 1]!;
	return previous === " " || previous === "\t" || previous === "\n" || previous === "\r" || previous === "(" || previous === "[" || previous === "{" || previous === "\u2014" || previous === "\u2013";
}

function applyCurlyDoubleQuotes(text: string): string {
	const chars = [...text];
	let result = "";
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] === '"') {
			result += isOpeningContext(chars, index) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE;
		} else {
			result += chars[index]!;
		}
	}
	return result;
}

function applyCurlySingleQuotes(text: string): string {
	const chars = [...text];
	let result = "";
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] !== "'") {
			result += chars[index]!;
			continue;
		}
		const previous = index > 0 ? chars[index - 1] : undefined;
		const next = index < chars.length - 1 ? chars[index + 1] : undefined;
		const previousIsLetter = previous !== undefined && LETTER_RE.test(previous);
		const nextIsLetter = next !== undefined && LETTER_RE.test(next);
		if (previousIsLetter && nextIsLetter) {
			result += RIGHT_SINGLE_CURLY_QUOTE;
		} else {
			result += isOpeningContext(chars, index) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE;
		}
	}
	return result;
}

function preserveQuoteStyle(oldText: string, actualOldText: string, newText: string): string {
	if (oldText === actualOldText) {
		return newText;
	}
	const hasDoubleQuotes = actualOldText.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_DOUBLE_CURLY_QUOTE);
	const hasSingleQuotes = actualOldText.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_SINGLE_CURLY_QUOTE);
	if (!hasDoubleQuotes && !hasSingleQuotes) {
		return newText;
	}
	let result = newText;
	if (hasDoubleQuotes) {
		result = applyCurlyDoubleQuotes(result);
	}
	if (hasSingleQuotes) {
		result = applyCurlySingleQuotes(result);
	}
	return result;
}

export function applyEditsToNormalizedContent(normalizedContent: string, edits: FileEditOperation[], path: string): AppliedEditsResult {
	// Validate edit invariants upfront before any allocation.
	for (let index = 0; index < edits.length; index += 1) {
		const edit = edits[index]!;
		if (edit.oldText.length === 0) {
			throw getEmptyOldTextError(path, index, edits.length);
		}
		if (edit.expectedOccurrences !== undefined && (!Number.isInteger(edit.expectedOccurrences) || edit.expectedOccurrences < 1)) {
			throw getInvalidExpectedOccurrencesError(path, index, edits.length);
		}
	}

	// Lazily normalize content for fuzzy matching — computed at most once
	// regardless of how many edits fall through to the fuzzy path.
	let fuzzyContentCache: { content: string } | undefined;
	function getFuzzyContent(): { content: string } {
		if (fuzzyContentCache === undefined) {
			fuzzyContentCache = { content: normalizeForFuzzyMatch(normalizedContent) };
		}
		return fuzzyContentCache;
	}

	// Normalize edits and resolve matches in a single pass — avoids allocating
	// a separate normalizedEdits array.
	const matchedEdits: MatchedEdit[] = [];
	for (let index = 0; index < edits.length; index += 1) {
		const edit = edits[index]!;
		const oldText = normalizeToLF(edit.oldText);
		const newText = normalizeToLF(edit.newText);
		const expectedOccurrences = edit.expectedOccurrences ?? 1;
		const resolvedMatches = resolveEditMatches(
			normalizedContent,
			oldText,
			expectedOccurrences,
			edit.expectedOccurrences !== undefined,
			path,
			index,
			edits.length,
			getFuzzyContent(),
		);
		for (const resolvedMatch of resolvedMatches) {
			matchedEdits.push({
				editIndex: index,
				matchIndex: resolvedMatch.matchIndex,
				matchLength: resolvedMatch.actualOldText.length,
				newText: preserveQuoteStyle(oldText, resolvedMatch.actualOldText, newText),
			});
		}
	}

	// Sort only when there are multiple edits — single-edit is already sorted.
	if (matchedEdits.length > 1) {
		matchedEdits.sort((left, right) => left.matchIndex - right.matchIndex);
	}
	for (let index = 1; index < matchedEdits.length; index += 1) {
		const previous = matchedEdits[index - 1]!;
		const current = matchedEdits[index]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
		}
	}

	// Apply edits forward, collecting segments, then join once.
	// Avoids O(k²) intermediate string allocations from repeated concatenation.
	const segments: string[] = [];
	let cursor = 0;
	for (let index = 0; index < matchedEdits.length; index += 1) {
		const edit = matchedEdits[index]!;
		segments.push(normalizedContent.substring(cursor, edit.matchIndex));
		segments.push(edit.newText);
		cursor = edit.matchIndex + edit.matchLength;
	}
	segments.push(normalizedContent.substring(cursor));
	const newContent = segments.join("");
	if (newContent === normalizedContent) {
		throw getNoChangeError(path, edits.length);
	}
	// matchedEdits already has matchIndex/matchLength/newText — reuse as MatchedEditSpan[].
	return { newContent, matchedSpans: matchedEdits };
}

function formatAccessError(displayPath: string, error: unknown): Error {
	if (error instanceof Error) {
		const errorWithCode = error as Error & { code?: string };
		if (errorWithCode.code === "ENOENT") {
			return new Error(`File not found: ${displayPath}`);
		}
		return error;
	}
	return new Error(String(error));
}

export async function executeFileGroupEdits(
	absolutePath: string,
	displayPath: string,
	edits: FileEditOperation[],
	signal?: AbortSignal,
	operations: EditEngineOperations = defaultEditEngineOperations,
): Promise<ExecutedFileEditResult> {
	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);

		// Preflight: hard file-size gate before reading content into memory.
		try {
			const fileStat = await operations.stat(absolutePath);
			if (fileStat.size > MAX_EDIT_FILE_SIZE_BYTES) {
				throw new Error(
					`File too large to edit: ${displayPath} is ${fileStat.size} bytes (limit ${MAX_EDIT_FILE_SIZE_BYTES}). Use a narrower oldText or a streaming tool.`,
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("File too large")) throw error;
			// stat failure falls through to access check for a cleaner error
		}

		try {
			await operations.access(absolutePath);
		} catch (error) {
			throw formatAccessError(displayPath, error);
		}
		throwIfAborted(signal);

		const rawContent = await operations.readFile(absolutePath);
		throwIfAborted(signal);

		const { bom, text } = stripBom(rawContent);
		const originalEnding = detectLineEnding(text);
		const normalizedContent = normalizeToLF(text);

		// Resolve, validate, apply, and return spans in one call.
		// applyEditsToNormalizedContent is the single source of truth for match logic.
		const { newContent, matchedSpans } = applyEditsToNormalizedContent(normalizedContent, edits, displayPath);
		throwIfAborted(signal);

		await operations.writeFile(absolutePath, bom + restoreLineEndings(newContent, originalEnding));
		throwIfAborted(signal);

		const preview = generateEditPreview(normalizedContent, newContent);
		return {
			previewText: preview.previewText,
			previewStartLine: preview.previewStartLine,
			previewTruncated: preview.previewTruncated,
			changeStats: preview.changeStats,
			summary: `updated ${displayPath} (${matchedSpans.length} replacement${matchedSpans.length === 1 ? "" : "s"} from ${edits.length} edit${edits.length === 1 ? "" : "s"})`,
		};
	});
}
