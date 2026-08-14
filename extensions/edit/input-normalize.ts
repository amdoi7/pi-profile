/**
 * Model-input tolerance for the edit tool, aligned with pi's built-in edit.
 *
 * Only the two shapes whose intent is unambiguous are normalized:
 * - edits given as a JSON string (built-in parity);
 * - flat legacy shape { path, oldText, newText } merged into the edits
 *   (built-in parity), with a flat replaceAll kept on the merged edit.
 *
 * Anything else is left untouched so validation rejects it loudly. No
 * numbered-pair or expectedOccurrences compatibility (not backward compatible).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeEditInput(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}
	const request = { ...input };

	if (typeof request.edits === "string") {
		try {
			const parsed = JSON.parse(request.edits);
			if (Array.isArray(parsed)) {
				request.edits = parsed;
			}
		} catch {
			// fall through to the validation error for a non-array edits
		}
	}

	if (typeof request.oldText === "string" && typeof request.newText === "string") {
		const edits = Array.isArray(request.edits) ? [...request.edits] : [];
		const edit: Record<string, unknown> = { oldText: request.oldText, newText: request.newText };
		if (typeof request.replaceAll === "boolean") {
			edit.replaceAll = request.replaceAll;
		}
		edits.push(edit);
		delete request.oldText;
		delete request.newText;
		delete request.replaceAll;
		request.edits = edits;
	}
	return request;
}
