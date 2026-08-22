/**
 * ThinkingSplitter — splits an assistant text stream into thinking and
 * visible-text segments for the apicursor.com gateway.
 *
 * Verified raw protocol (curl /v1/chat/completions, stream, claude-opus-5,
 * with reasoning_effort / reasoning.effort / thinking.type — all three shapes
 * behave identically):
 *
 *   delta.content: "<think>I need to provide Euclid's proof…</think>\n\n## There are…"
 *
 * The chain of thought is inlined in `content` as an XML `<think>` block; no
 * reasoning_content / reasoning / reasoning_text field is ever sent, which is
 * why pi's stock OpenAI adapter renders the chain of thought as answer text.
 *
 * Markers are XML tags ONLY. Word-level markers (a bare "thinking" / "response"
 * token, as an earlier revision used) cannot work: "response" and "thinking"
 * are ordinary words inside the chain of thought and inside answers, so a
 * word-level closer truncates the chain of thought at its first mention of
 * "response" and leaks the rest into the visible answer, while a word-level
 * opener swallows answer prose that merely contains "thinking".
 *
 * Recovery: a run opened by an unmatched `<think>` stays open until
 * end-of-stream, keeping the chain of thought out of the visible answer.
 */

/** Full opening tag: `<think>`, `<thinking>`, `<think style="codex">`. */
const OPEN_TAG = /<think(?:ing)?(?:\s[^>]*)?>/i;
/** Full closing tag: `</think>`, `</thinking>`, `</think >`. */
const CLOSE_TAG = /<\/think(?:ing)?\s*>/i;
/** Longest tail withheld while a tag may still be completing. Attribute forms
 *  are open-ended, so the hold is capped and released as plain text. */
const MAX_PARTIAL = 64;

export type SegmentKind = "text" | "thinking";

export interface Segment {
	kind: SegmentKind;
	text: string;
}

type Mode = "text" | "thinking";

/** Could `tail` still grow into an opening tag? */
function isPartialOpen(tail: string): boolean {
	const lower = tail.toLowerCase();
	return "<thinking".startsWith(lower) || /^<think(?:ing)?\s[^>]*$/i.test(tail);
}

/** Could `tail` still grow into a closing tag? */
function isPartialClose(tail: string): boolean {
	const lower = tail.toLowerCase();
	return "</thinking".startsWith(lower) || /^<\/think(?:ing)?\s*$/i.test(tail);
}

export class ThinkingSplitter {
	private buf = "";
	private mode: Mode = "text";
	/** Suppress whitespace that only separates a thinking block from the answer. */
	private stripLeadingWhitespace = true;
	private out: Segment[] = [];

	feed(delta: string): Segment[] {
		this.buf += delta;
		this.out = [];
		for (;;) {
			const tag = (this.mode === "text" ? OPEN_TAG : CLOSE_TAG).exec(this.buf);
			if (tag) {
				this.emit(this.buf.slice(0, tag.index));
				this.buf = this.buf.slice(tag.index + tag[0].length);
				if (this.mode === "text") {
					this.mode = "thinking";
				} else {
					this.mode = "text";
					this.stripLeadingWhitespace = true;
				}
				continue;
			}
			// No complete tag: emit everything except a tail that may still become one.
			const hold = this.holdLength();
			if (hold < this.buf.length) {
				this.emit(this.buf.slice(0, this.buf.length - hold));
				this.buf = this.buf.slice(this.buf.length - hold);
			}
			return this.out;
		}
	}

	/** Flush the buffer; an unresolved thinking run closes here. */
	end(): Segment[] {
		this.out = [];
		this.emit(this.buf);
		this.buf = "";
		return this.out;
	}

	/** Length of the trailing partial-tag candidate that must not be emitted yet. */
	private holdLength(): number {
		const start = this.buf.lastIndexOf("<");
		if (start < 0) return 0;
		const tail = this.buf.slice(start);
		if (tail.length > MAX_PARTIAL) return 0;
		const partial = this.mode === "text" ? isPartialOpen(tail) : isPartialClose(tail);
		return partial ? tail.length : 0;
	}

	private emit(text: string): void {
		let out = text;
		if (this.mode === "text" && this.stripLeadingWhitespace) {
			out = out.replace(/^\s+/, "");
			if (out.length > 0) this.stripLeadingWhitespace = false;
		}
		if (out.length > 0) this.out.push({ kind: this.mode, text: out });
	}
}
