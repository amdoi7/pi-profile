/**
 * Model-input tolerance for the edit tool.
 *
 * Real model calls drift toward legacy or malformed shapes. This module
 * normalizes only the shapes whose intent is unambiguous; anything else is
 * left untouched so the schema rejects it loudly. Each extraction is a pure
 * function that removes what it consumed, so callers never see half-moved
 * state.
 */

/**
 * Numbered legacy pair keys, e.g. oldText2/newText2 … oldText9/newText9.
 * The flat legacy shape { oldText, newText } is treated as index 1 so all
 * pairs share one extraction mechanism.
 */
const LEGACY_EDIT_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function isEditObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract one legacy edit pair (oldText/newText for index 1, oldTextN/newTextN
 * otherwise) from a record and delete the consumed keys. Returns undefined
 * when the pair is not fully present as strings — unpaired keys survive and
 * the schema rejects them loudly.
 */
function extractLegacyEdit(record: Record<string, unknown>, index: number): Record<string, unknown> | undefined {
	const oldKey = index === 1 ? "oldText" : `oldText${index}`;
	const newKey = index === 1 ? "newText" : `newText${index}`;
	if (typeof record[oldKey] !== "string" || typeof record[newKey] !== "string") {
		return undefined;
	}
	const edit: Record<string, unknown> = { oldText: record[oldKey], newText: record[newKey] };
	if (index === 1) {
		if (typeof record.replaceAll === "boolean") {
			edit.replaceAll = record.replaceAll;
		}
		delete record.replaceAll;
	}
	delete record[oldKey];
	delete record[newKey];
	return edit;
}

/**
 * Strip legacy fields from one edit entry. Numbered pairs nested inside the
 * entry are appended to `tail` (never silently dropped); expectedOccurrences
 * is dropped (its default semantics are the unique-match contract this tool
 * already enforces). All other unknown keys stay put so the schema rejects
 * them loudly.
 */
function cleanEditEntry(entry: unknown, tail: Record<string, unknown>[]): unknown {
	if (!isEditObject(entry)) {
		return entry;
	}
	const clean = { ...entry };
	for (const index of LEGACY_EDIT_INDEXES.slice(1)) {
		const edit = extractLegacyEdit(clean, index);
		if (edit) {
			tail.push(edit);
		}
	}
	delete clean.expectedOccurrences;
	return clean;
}

/**
 * Normalize ambiguous model input:
 *
 * - edits given as a JSON string (same tolerance as pi's built-in edit tool)
 * - flat legacy shape { path, oldText, newText } merged into the edits
 *   (pi's built-in edit tool merges these; keep parity)
 * - numbered pairs oldText2/newText2 … appended as further edits, both at
 *   top level and nested inside an edit object
 * - expectedOccurrences dropped from edit entries
 */
export function normalizeEditInput(input: unknown): unknown {
	if (!input || typeof input !== "object") {
		return input;
	}
	const request = { ...(input as Record<string, unknown>) };

	let edits: unknown[] | undefined;
	if (typeof request.edits === "string") {
		try {
			const parsed = JSON.parse(request.edits);
			if (Array.isArray(parsed)) {
				edits = parsed;
			}
		} catch {
			// fall through to the schema error for a non-array edits
		}
	} else if (Array.isArray(request.edits)) {
		edits = [...request.edits];
	}

	const legacy: Record<string, unknown>[] = [];
	for (const index of LEGACY_EDIT_INDEXES) {
		const edit = extractLegacyEdit(request, index);
		if (edit) {
			legacy.push(edit);
		}
	}

	const tail: Record<string, unknown>[] = [];
	const cleaned = (edits ?? []).map((entry) => cleanEditEntry(entry, tail));

	if (legacy.length > 0 || edits !== undefined) {
		request.edits = [...cleaned, ...legacy, ...tail];
	}
	return request;
}
