import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, type TruncationResult } from "@earendil-works/pi-coding-agent";

/**
 * accumulator.ts — 流式输出累积器（pi built-in OutputAccumulator 的复刻）。
 *
 * pi 的 OutputAccumulator 在 dist/core/tools/output-accumulator.js，未从包入口导出；
 * 执行者架构的 content 契约（截断尾部 + temp file + 备注元数据）必须与 built-in
 * 逐字节一致，因此按 pi 源码语义复刻（tail 滚动窗口 + 超限持久化 temp file）。
 * 截断参数与 built-in 相同：DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES（已从包入口导出）。
 */

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export type OutputSnapshot = {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
};

export class OutputAccumulator {
	private readonly maxLines = DEFAULT_MAX_LINES;
	private readonly maxBytes = DEFAULT_MAX_BYTES;
	private readonly maxRollingBytes = Math.max(DEFAULT_MAX_BYTES * 2, 1);
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();
	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;
	private tempFilePath?: string;
	private tempFileStream?: ReturnType<typeof createWriteStream>;

	constructor(tempFilePrefix = "pi-output") {
		this.tempFilePrefix = tempFilePrefix;
	}

	append(data: Buffer): void {
		if (this.finished) throw new Error("Cannot append to a finished output accumulator");
		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) this.ensureTempFile();
	}

	/** 快照：展示文本（截断尾部）+ 截断元数据 + temp file 引用（截断时持久化）。 */
	snapshot(persistIfTruncated = true): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), { maxLines: this.maxLines, maxBytes: this.maxBytes });
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		if (persistIfTruncated && truncated) this.ensureTempFile();
		return {
			content: tailTruncation.content,
			truncation: {
				...tailTruncation,
				truncated,
				truncatedBy,
				totalLines: this.totalLines,
				totalBytes: this.totalDecodedBytes,
				maxLines: this.maxLines,
				maxBytes: this.maxBytes,
			},
			fullOutputPath: this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) return;
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) return;
		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();
		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}
		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) return this.tailText;
		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes ||
			this.totalDecodedBytes > this.maxBytes ||
			this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) return;
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
		this.rawChunks = [];
	}
}
