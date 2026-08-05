import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";

import { isRecord, type ActiveRun, type HistoryRun, type RunMetadata, type RunOutput } from "./pi-sub-core.ts";

export const COMPLETION_MESSAGE_TYPE = "pi-sub-complete";

export const RUN_OUTCOMES = ["complete", "cancelled", "failed", "lost"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export type FinishedRun = RunMetadata & {
  runId: string;
  outcome: RunOutcome;
  exitCode: string | null;
  stdout: string;
  stderr: string;
  workerStderr?: string;
};

export type CompletionDetails = Omit<FinishedRun, "stdout" | "stderr" | "workerStderr"> & {
  collectCommand: string;
  transcriptCommand: string;
  output: string;
  outputTruncated: boolean;
  totalBytes: number;
  totalLines: number;
};

export type CompletionMessage = {
  customType: typeof COMPLETION_MESSAGE_TYPE;
  content: string;
  display: true;
  details: CompletionDetails;
};

type MessageRenderOptions = {
  expanded: boolean;
  outputPad: number;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatRunOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout.length > 0) sections.push(`stdout:\n${stdout.replace(/\r?\n$/, "")}`);
  if (stderr.length > 0) sections.push(`stderr:\n${stderr.replace(/\r?\n$/, "")}`);
  return sections.length > 0 ? sections.join("\n\n") : "(no output)";
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => {
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

function renderOutput(output: string, theme: Theme): string {
  return sanitizeTerminalText(output)
    .split("\n")
    .map((line) => {
      if (line === "stdout:" || line === "stderr:") return theme.fg("toolTitle", line.slice(0, -1));
      return theme.fg("toolOutput", line);
    })
    .join("\n");
}

function firstOutputLine(output: string): string {
  return output.split("\n").find((line) => line !== "stdout:" && line !== "stderr:" && line.length > 0) ?? "(no output)";
}

function parseCompletionDetails(value: unknown): CompletionDetails | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.runId)) return undefined;
  if (typeof value.outcome !== "string" || !RUN_OUTCOMES.includes(value.outcome as RunOutcome)) return undefined;
  if (value.outcome === "lost") {
    if (value.exitCode !== null) return undefined;
  } else if (typeof value.exitCode !== "string" || !/^[0-9]+$/.test(value.exitCode)) {
    return undefined;
  }
  if (value.workerStderr !== undefined && typeof value.workerStderr !== "string") return undefined;
  if (typeof value.collectCommand !== "string") return undefined;
  if (typeof value.transcriptCommand !== "string") return undefined;
  if (typeof value.output !== "string" || typeof value.outputTruncated !== "boolean") return undefined;
  if (typeof value.totalBytes !== "number" || !Number.isSafeInteger(value.totalBytes)) return undefined;
  if (typeof value.totalLines !== "number" || !Number.isSafeInteger(value.totalLines)) return undefined;
  if (value.alias !== undefined && typeof value.alias !== "string") return undefined;
  if (value.taskMode !== undefined && value.taskMode !== "read-only" && value.taskMode !== "mutation") return undefined;
  if (value.tools !== undefined && typeof value.tools !== "string") return undefined;
  if (value.provider !== undefined && typeof value.provider !== "string") return undefined;
  if (value.model !== undefined && typeof value.model !== "string") return undefined;
  if (value.thinking !== undefined && typeof value.thinking !== "string") return undefined;
  if (value.projectCwd !== undefined && typeof value.projectCwd !== "string") return undefined;
  if (value.writeScopes !== undefined && (!Array.isArray(value.writeScopes) || !value.writeScopes.every((scope) => typeof scope === "string"))) {
    return undefined;
  }
  return value as CompletionDetails;
}

const WIDGET_GLYPHS: Record<ActiveRun["state"], string> = { running: "●", queued: "○", lost: "✗" };
const WIDGET_COLORS: Record<ActiveRun["state"], string> = { running: "accent", queued: "muted", lost: "error" };

export function formatActiveWidgetLines(runs: ActiveRun[], width: number, theme: Theme): string[] {
  return runs.map((run) => {
    const glyph = theme.fg(WIDGET_COLORS[run.state], WIDGET_GLYPHS[run.state]);
    const label = run.alias ?? `#${run.runId.split(".").pop()}`;
    const mode = run.taskMode;
    const model = run.model ? (run.provider ? `${run.provider}/${run.model}` : run.model) : undefined;
    const thinking = run.thinking ? `think:${run.thinking}` : undefined;
    const stateWord = theme.fg(WIDGET_COLORS[run.state], run.state);
    const age = run.stateAgeSeconds !== undefined ? `${run.stateAgeSeconds}s` : undefined;
    const parts = [
      mode,
      model,
      thinking,
      age !== undefined ? `${stateWord} ${age}` : stateWord,
      run.activity,
    ].filter((part): part is string => part !== undefined);
    return truncateToWidth(`${glyph} ${label} · ${parts.join(" · ")}`, width);
  });
}

export function buildCompletionMessage(run: FinishedRun, runnerPath: string): CompletionMessage {
  const collectCommand = `${shellQuote(runnerPath)} --result ${run.runId}`;
  const transcriptCommand = `${shellQuote(runnerPath)} --transcript ${run.runId}`;
  const rawOutput = run.outcome === "lost" ? run.workerStderr ?? "" : formatRunOutput(run.stdout, run.stderr);
  const result = truncateHead(rawOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const truncationNotice = result.truncated
    ? `\n\n[Result truncated: ${result.outputLines}/${result.totalLines} lines, ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Use ${collectCommand} only if the omitted output is required.]`
    : "";
  const headline =
    run.outcome === "complete"
      ? `pi-sub run ${run.runId} completed with exit ${run.exitCode}.`
      : run.outcome === "cancelled"
        ? `pi-sub run ${run.runId} was cancelled (exit ${run.exitCode}).`
        : run.outcome === "failed"
          ? `pi-sub run ${run.runId} failed with exit ${run.exitCode}.`
          : `pi-sub run ${run.runId} was lost: the worker exited before publishing completion.`;
  const action =
    run.outcome === "complete"
      ? "Validate the result before making dependent decisions."
      : run.outcome === "cancelled"
        ? "No result was produced; account for the cancelled work before proceeding."
        : run.outcome === "failed"
          ? "Account for the failure before making dependent decisions."
          : "Inspect worker.stderr in the run directory; the durable child transcript remains available via --transcript.";
  const collected = run.outcome === "complete" || run.outcome === "failed"
    ? " The result is already collected."
    : "";
  const { stdout: _stdout, stderr: _stderr, workerStderr: _workerStderr, ...metadata } = run;
  return {
    customType: COMPLETION_MESSAGE_TYPE,
    content: `${headline}${collected}\n\n${result.content}${truncationNotice}\n\n${action}`,
    display: true,
    details: {
      ...metadata,
      collectCommand,
      transcriptCommand,
      output: result.content,
      outputTruncated: result.truncated,
      totalBytes: result.totalBytes,
      totalLines: result.totalLines,
    },
  };
}

const OUTCOME_STYLES: Record<RunOutcome, { color: string; label: string }> = {
  complete: { color: "success", label: "complete" },
  cancelled: { color: "warning", label: "cancelled" },
  failed: { color: "error", label: "failed" },
  lost: { color: "error", label: "lost" },
};

export type HistoryView = {
  kind: "list" | "detail";
  selectedIndex: number;
};

export function formatRunState(state: HistoryRun["state"]): { glyph: string; color: string } {
  if (state === "running") return { glyph: "●", color: "accent" };
  if (state === "queued") return { glyph: "○", color: "muted" };
  if (state === "lost") return { glyph: "✗", color: "error" };
  return { glyph: "✓", color: "success" };
}

export function formatHistoryLine(run: HistoryRun, selected: boolean, width: number, theme: Theme): string {
  const { glyph, color } = formatRunState(run.state);
  const stateWord = theme.fg(color, run.state);
  const age = formatAge(run.startedAtMs);
  const exit = run.exitCode !== null ? ` exit ${run.exitCode}` : "";
  const model = run.model ? (run.provider ? `${run.provider}/${run.model}` : run.model) : undefined;
  const label = run.alias ?? `#${run.runId.split(".").pop()}`;
  const parts = [
    `${stateWord}${exit}`,
    model,
    age,
  ].filter((part): part is string => part !== undefined);
  const prefix = selected ? theme.fg("accent", "▶ ") : "  ";
  return truncateToWidth(`${prefix}${glyph} ${label} · ${parts.join(" · ")}`, width);
}

export function formatAge(startedAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export function formatHistoryDetail(run: HistoryRun, output: RunOutput, width: number, theme: Theme): string[] {
  const { glyph, color } = formatRunState(run.state);
  const label = run.alias ?? run.runId;
  const exit = run.exitCode !== null ? `exit ${run.exitCode}` : "no exit code";
  const model = run.model ? (run.provider ? `${run.provider}/${run.model}` : run.model) : undefined;
  const capability = [
    run.taskMode ? `mode ${run.taskMode}` : undefined,
    run.tools ? `tools ${run.tools}` : undefined,
    model ? `model ${model}` : undefined,
    run.thinking ? `thinking ${run.thinking}` : undefined,
  ].filter((item): item is string => item !== undefined);
  const lines = [
    `${theme.fg("toolTitle", theme.bold("pi-sub"))} ${theme.fg(color, run.state)} ${theme.bold(label)}`,
    `${theme.fg("muted", `run ${run.runId} · ${exit}`)}`,
  ];
  if (capability.length > 0) lines.push(theme.fg("muted", capability.join(" · ")));
  if (run.projectCwd) lines.push(theme.fg("muted", `cwd ${run.projectCwd}`));
  if (output.activity) {
    lines.push(theme.fg("accent", `▶ ${output.activity}`));
  }
  const renderedOutput = formatRunOutput(output.stdout, output.stderr);
  if (renderedOutput !== "(no output)") {
    lines.push("");
    lines.push(...renderOutput(renderedOutput, theme).split("\n"));
  } else if (run.state === "running" || run.state === "queued") {
    lines.push(theme.fg("muted", `(still ${run.state}; output appears when the run completes)`));
  }
  return lines.map((line) => truncateToWidth(line, width));
}

export function renderCompletionMessage(
  message: { content: string; details?: unknown },
  options: MessageRenderOptions,
  theme: Theme,
): Box {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const details = parseCompletionDetails(message.details);
  if (!details) {
    box.addChild(new Text(message.content, 0, 0));
    return box;
  }

  const style = OUTCOME_STYLES[details.outcome];
  const label = details.alias ?? details.runId;
  const lines = [
    `${theme.fg("toolTitle", theme.bold("pi-sub"))} ${theme.fg(style.color, style.label)} ${theme.bold(label)}`,
    details.outcome === "lost"
      ? `${theme.fg("muted", `run ${details.runId} · worker lost`)}`
      : `${theme.fg("muted", `run ${details.runId} · exit ${details.exitCode}`)}`,
  ];

  if (options.expanded) {
    lines.push(renderOutput(details.output, theme));
    if (details.outputTruncated) {
      lines.push(theme.fg("warning", `result truncated · ${details.totalLines} lines · ${formatSize(details.totalBytes)}`));
    }
    if (details.outcome !== "lost") {
      lines.push(`${theme.fg("accent", "collect")} ${details.collectCommand}`);
    }
    lines.push(`${theme.fg("accent", "transcript")} ${details.transcriptCommand}`);
    const model = details.model
      ? `${details.provider ? `${details.provider}/` : ""}${details.model}`
      : undefined;
    const capability = [
      details.taskMode ? `mode ${details.taskMode}` : undefined,
      details.tools ? `tools ${details.tools}` : undefined,
      model ? `model ${model}` : undefined,
      details.thinking ? `thinking ${details.thinking}` : undefined,
    ].filter((item): item is string => item !== undefined);
    if (capability.length > 0) lines.push(theme.fg("muted", capability.join(" · ")));
    if (details.writeScopes && details.writeScopes.length > 0) {
      lines.push(theme.fg("muted", `write scopes ${details.writeScopes.join(", ")}`));
    }
    if (details.projectCwd) lines.push(theme.fg("muted", `cwd ${details.projectCwd}`));
  } else {
    lines.push(`${theme.fg("muted", "result")} ${theme.fg("toolOutput", sanitizeTerminalText(firstOutputLine(details.output)))}`);
  }

  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export type HistoryOverlayCallbacks = {
  onClose: () => void;
  onRequestRender: () => void;
};

export class PiSubHistoryOverlay {
  private view: "list" | "detail" = "list";
  private selectedIndex = 0;
  private detailScroll = 0;
  private loadedOutput = new Map<string, RunOutput>();

  constructor(
    private runs: HistoryRun[],
    private readonly loadOutput: (run: HistoryRun) => RunOutput,
    private readonly theme: Theme,
    private readonly callbacks: HistoryOverlayCallbacks,
  ) {}

  getSelectedRun(): HistoryRun | undefined {
    return this.runs[this.selectedIndex];
  }

  /**
   * Replace the run list with a fresh snapshot while preserving the
   * currently selected run (by runId) and its loaded detail output.
   * Running runs are reloaded so their live activity stays current.
   */
  setRuns(runs: HistoryRun[]): void {
    const selectedId = this.runs[this.selectedIndex]?.runId;
    this.runs = runs;
    if (selectedId !== undefined) {
      const index = runs.findIndex((run) => run.runId === selectedId);
      this.selectedIndex = index >= 0 ? index : Math.max(0, this.selectedIndex - 1);
    } else {
      this.selectedIndex = 0;
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, runs.length - 1));
    if (this.view === "detail" && this.runs.length === 0) {
      this.view = "list";
    }
    const selected = this.runs[this.selectedIndex];
    if (selected && (selected.state === "running" || selected.state === "queued")) {
      this.loadedOutput.set(selected.runId, this.loadOutput(selected));
    }
  }

  getRuns(): HistoryRun[] {
    return this.runs;
  }

  handleInput(data: string): void {
    if (this.view === "list") {
      if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
        this.selectedIndex -= 1;
        this.callbacks.onRequestRender();
      } else if (matchesKey(data, Key.down) && this.selectedIndex < this.runs.length - 1) {
        this.selectedIndex += 1;
        this.callbacks.onRequestRender();
      } else if (matchesKey(data, Key.enter) && this.runs.length > 0) {
        this.view = "detail";
        this.detailScroll = 0;
        const run = this.getSelectedRun();
        if (run && !this.loadedOutput.has(run.runId)) {
          this.loadedOutput.set(run.runId, this.loadOutput(run));
        }
        this.callbacks.onRequestRender();
      } else if (matchesKey(data, Key.escape)) {
        this.callbacks.onClose();
      }
      return;
    }

    if (matchesKey(data, Key.up) && this.detailScroll > 0) {
      this.detailScroll -= 1;
      this.callbacks.onRequestRender();
    } else if (matchesKey(data, Key.down)) {
      this.detailScroll += 1;
      this.callbacks.onRequestRender();
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.view = "list";
      this.detailScroll = 0;
      this.callbacks.onRequestRender();
    }
  }

  render(width: number): string[] {
    const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
    const innerWidth = Math.max(40, dialogWidth - 2);
    const terminalRows = process.stdout.rows ?? 30;
    const dialogHeight = Math.max(14, Math.min(26, Math.floor(terminalRows * 0.75)));
    const chromeHeight = 5;
    const contentHeight = Math.max(8, dialogHeight - chromeHeight);

    const lines = [this.borderLine(innerWidth, "top")];
    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(" pi-sub history ")), innerWidth));
    lines.push(this.theme.fg("borderMuted", `├${this.theme.fg("borderMuted", "─").repeat(innerWidth)}┤`));

    const contentLines: string[] = [];
    if (this.runs.length === 0) {
      contentLines.push(this.theme.fg("muted", "No pi-sub runs found yet."));
    } else if (this.view === "list") {
      const visibleCount = Math.min(this.runs.length, contentHeight - 1);
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.runs.length - visibleCount));
      for (let i = start; i < start + visibleCount; i++) {
        const run = this.runs[i];
        if (!run) continue;
        contentLines.push(formatHistoryLine(run, i === this.selectedIndex, innerWidth, this.theme));
      }
      if (this.runs.length > visibleCount) {
        contentLines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.runs.length})`));
      }
    } else {
      const run = this.getSelectedRun();
      if (run) {
        const output = this.loadedOutput.get(run.runId) ?? { stdout: "", stderr: "" };
        const detail = formatHistoryDetail(run, output, innerWidth, this.theme);
        const visibleCount = contentHeight - 1;
        const maxScroll = Math.max(0, detail.length - visibleCount);
        const scroll = Math.min(this.detailScroll, maxScroll);
        for (let i = scroll; i < Math.min(scroll + visibleCount, detail.length); i++) {
          contentLines.push(detail[i]!);
        }
        if (maxScroll > 0) {
          contentLines.push(this.theme.fg("dim", `  (${Math.min(scroll + visibleCount, detail.length)}/${detail.length})`));
        }
      }
    }

    // 固定内容区高度:不足补空行,保证每次渲染行数恒定,避免 TUI 差分渲染残留。
    for (const line of contentLines.slice(0, contentHeight)) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = contentLines.length; i < contentHeight; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.theme.fg("borderMuted", `├${this.theme.fg("borderMuted", "─").repeat(innerWidth)}┤`));
    lines.push(this.frameLine(
      this.theme.fg("dim", this.view === "list" ? "↑↓ navigate · enter view · esc close" : "↑↓ scroll · esc back"),
      innerWidth,
    ));
    lines.push(this.borderLine(innerWidth, "bottom"));
    return lines;
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("borderMuted", "│")}${truncated}${this.theme.fg("borderMuted", " ").repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("borderMuted", `${left}${this.theme.fg("borderMuted", "─").repeat(innerWidth)}${right}`);
  }
}
