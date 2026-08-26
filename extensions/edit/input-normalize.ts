/**
 * Model-input tolerance for the batch edit tool.
 *
 * Only shapes whose intent is unambiguous are normalized into { intent, files }:
 * - `files` / `edits` given as a JSON string (provider serialization slip);
 * - the single-file shape `{ path, edits }` (pi's built-in edit shape, which
 *   models reach for by habit) lifted into `files: [{ path, edits }]`;
 * - the flat shape `{ path, oldText, newText }` lifted the same way.
 *
 * `intent` is never invented: a batch without a stated intent is rejected by
 * validation, because the intent is the transaction's name, not decoration.
 * Anything else is left untouched so validation rejects it loudly.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonArray(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : value;
	} catch {
		// fall through to the validation error for a non-array value
		return value;
	}
}

/**
 * 单文件形状（内置 edit / 旧契约）→ files[0]；flat oldText/newText 同理。
 *
 * 抬升只看形状不看值是否合法：edits 是一段坏文本时也要抬，否则它会留在顶层
 * 被当成未知键，报出「path must be removed」——把模型指向删掉唯一正确的字段。
 */
function liftSingleFileShape(request: Record<string, unknown>): void {
	if (typeof request.path !== "string") return;

	const hasFlatReplacement = typeof request.oldText === "string" && typeof request.newText === "string";
	if (typeof request.edits === "string") {
		if (request.files !== undefined) return;
		request.files = [{ path: request.path, edits: request.edits }];
		delete request.path;
		delete request.edits;
		return;
	}

	const edits = Array.isArray(request.edits) ? request.edits : [];
	if (hasFlatReplacement) {
		edits.push({
			oldText: request.oldText,
			newText: request.newText,
			...(typeof request.replaceAll === "boolean" ? { replaceAll: request.replaceAll } : {}),
		});
	}
	if (edits.length === 0) return;

	const file: Record<string, unknown> = { path: request.path, edits };
	if (typeof request.hint === "string") file.hint = request.hint;
	request.files = [file, ...(Array.isArray(request.files) ? request.files : [])];
	delete request.path;
	delete request.edits;
	delete request.oldText;
	delete request.newText;
	delete request.replaceAll;
	delete request.hint;
}

export function normalizeEditInput(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}
	const request = { ...input };

	request.files = parseJsonArray(request.files);
	request.edits = parseJsonArray(request.edits);
	if (request.files === undefined) delete request.files;
	if (request.edits === undefined) delete request.edits;

	liftSingleFileShape(request);

	if (Array.isArray(request.files)) {
		request.files = request.files.map((entry) =>
			isRecord(entry) && entry.edits !== undefined
				? { ...entry, edits: parseJsonArray(entry.edits) }
				: entry
		);
	}
	return request;
}
