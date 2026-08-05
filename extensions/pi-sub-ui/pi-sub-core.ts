import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_BYTE_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export type RunMetadata = {
  alias?: string;
  taskMode?: "read-only" | "mutation";
  tools?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  projectCwd?: string;
  writeScopes?: string[];
};

export type CompletedRun = RunMetadata & {
  runId: string;
  exitCode: string;
  stdout: string;
  stderr: string;
};

export type ActiveRun = RunMetadata & {
  runId: string;
  state: "queued" | "running" | "lost";
  stateAgeSeconds?: number;
  activity?: string;
};

export type ListedRun = {
  runId: string;
  alias: string | null;
  state: "queued" | "running" | "complete" | "lost";
  exitCode: number | null;
  model: string | null;
  stateAgeSeconds: number;
};

export type HistoryRun = RunMetadata & {
  runId: string;
  state: "queued" | "running" | "complete" | "lost";
  exitCode: string | null;
  startedAtMs: number;
};

export type RunOutput = {
  stdout: string;
  stderr: string;
  activity?: string;
};

export function readRunOutput(runsDir: string, runId: string): RunOutput {
  return {
    stdout: readOptionalOutput(join(runsDir, runId), "stdout"),
    stderr: readOptionalOutput(join(runsDir, runId), "stderr"),
  };
}

function readOptionalOutput(runDir: string, name: "stdout" | "stderr"): string {
  try {
    return readFileSync(join(runDir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function scanRunHistory(runsDir: string, ownerSessionId?: string): HistoryRun[] {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const history: HistoryRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const runDir = join(runsDir, entry.name);
    if (ownerSessionId !== undefined && readTrimmed(join(runDir, "owner-session-id")) !== ownerSessionId) continue;

    const status = readTrimmed(join(runDir, "status"));
    if (status === undefined) continue;
    const [state, exitCode] = status.split("\t");
    if (state !== "queued" && state !== "running" && state !== "complete" && state !== "lost") continue;
    if (state === "complete" && !/^[0-9]+$/.test(exitCode ?? "")) continue;

    let startedAtMs: number;
    try {
      startedAtMs = statSync(runDir).mtimeMs;
    } catch {
      continue;
    }
    history.push({
      runId: entry.name,
      state,
      exitCode: state === "complete" ? exitCode ?? null : null,
      startedAtMs,
      ...readMetadata(runDir),
    });
  }
  return history.sort((left, right) => right.startedAtMs - left.startedAtMs);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readArtifact(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8");
    return value.endsWith("\n") ? value.slice(0, -1) : value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readTrimmed(path: string): string | undefined {
  return readArtifact(path)?.trim();
}

function readOutput(runDir: string, name: "stdout" | "stderr"): string {
  const path = join(runDir, name);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `pi_sub_result_unavailable artifact="${name}" path="${path}" action="inspect runner artifacts and rerun the task"`,
      );
    }
    throw error;
  }
}

function isDisplaySafe(value: string): boolean {
  return value.length > 0 && !CONTROL_BYTE_PATTERN.test(value);
}

function readMetadata(runDir: string): RunMetadata {
  const metadata: RunMetadata = {};
  const alias = readArtifact(join(runDir, "alias"));
  const taskMode = readArtifact(join(runDir, "task-mode"));
  const tools = readArtifact(join(runDir, "tools"));
  const provider = readArtifact(join(runDir, "provider"));
  const model = readArtifact(join(runDir, "model"));
  const thinking = readArtifact(join(runDir, "thinking"));
  const projectCwd = readArtifact(join(runDir, "project-cwd"));
  const writeScopes = readArtifact(join(runDir, "write-scopes"));

  if (alias && RUN_ID_PATTERN.test(alias)) metadata.alias = alias;
  if (taskMode === "read-only" || taskMode === "mutation") metadata.taskMode = taskMode;
  if (tools && isDisplaySafe(tools)) metadata.tools = tools;
  if (provider && isDisplaySafe(provider)) metadata.provider = provider;
  if (model && isDisplaySafe(model)) metadata.model = model;
  if (thinking && isDisplaySafe(thinking)) metadata.thinking = thinking;
  if (projectCwd && isDisplaySafe(projectCwd)) metadata.projectCwd = projectCwd;
  if (writeScopes === "") {
    metadata.writeScopes = [];
  } else if (writeScopes !== undefined) {
    const scopes = writeScopes.split("\n");
    if (scopes.every(isDisplaySafe)) metadata.writeScopes = scopes;
  }
  return metadata;
}

export function claimRunNotification(runDir: string): string | undefined {
  const claimPath = join(runDir, "notification-claimed");
  try {
    closeSync(openSync(claimPath, "wx", 0o600));
    return claimPath;
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

export function releaseRunNotification(claimPath: string, deliveryError: unknown): never {
  try {
    unlinkSync(claimPath);
  } catch (cleanupError) {
    throw new AggregateError([deliveryError, cleanupError], "pi-sub notification delivery and claim cleanup failed");
  }
  throw deliveryError;
}

export function readWorkerStderr(runDir: string): string {
  try {
    return readFileSync(join(runDir, "worker.stderr"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function scanRunsDir(
  runsDir: string,
  ownerSessionId: string,
  onCompleted: (run: CompletedRun) => void,
): ActiveRun[] {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const activeRuns: ActiveRun[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;

    const runDir = join(runsDir, entry.name);
    if (readTrimmed(join(runDir, "owner-session-id")) !== ownerSessionId) continue;

    const status = readTrimmed(join(runDir, "status"));
    if (status === undefined) continue;
    const [state, exitCode] = status.split("\t");
    if (state === "queued" || state === "running") {
      activeRuns.push({ runId: entry.name, state, ...readMetadata(runDir) });
      continue;
    }
    if (state !== "complete" || !/^[0-9]+$/.test(exitCode ?? "") || Number(exitCode) > 255) continue;

    const claimPath = claimRunNotification(runDir);
    if (claimPath === undefined) continue;
    try {
      const completedRun = {
        runId: entry.name,
        exitCode,
        ...readMetadata(runDir),
        stdout: readOutput(runDir, "stdout"),
        stderr: readOutput(runDir, "stderr"),
      };
      onCompleted(completedRun);
    } catch (error) {
      releaseRunNotification(claimPath, error);
    }
  }
  return activeRuns;
}

export function parseListOutput(json: string): ListedRun[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `pi_sub_list_invalid_json reason="${error instanceof Error ? error.message : String(error)}" action="inspect the pi-sub --list output"`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('pi_sub_list_invalid_shape reason="expected a JSON array" action="inspect the pi-sub --list output"');
  }
  const runs: ListedRun[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      throw new Error('pi_sub_list_invalid_entry reason="run entry is not an object" action="inspect the pi-sub --list output"');
    }
    if (typeof item.runId !== "string" || !RUN_ID_PATTERN.test(item.runId)) {
      throw new Error(`pi_sub_list_invalid_entry field="runId" value=${JSON.stringify(item.runId)} action="inspect the pi-sub --list output"`);
    }
    if (item.alias !== null && typeof item.alias !== "string") {
      throw new Error(`pi_sub_list_invalid_entry field="alias" action="inspect the pi-sub --list output"`);
    }
    if (item.state !== "queued" && item.state !== "running" && item.state !== "complete" && item.state !== "lost") {
      throw new Error(`pi_sub_list_invalid_entry field="state" value=${JSON.stringify(item.state)} action="inspect the pi-sub --list output"`);
    }
    if (item.exitCode !== null && (typeof item.exitCode !== "number" || !Number.isInteger(item.exitCode))) {
      throw new Error(`pi_sub_list_invalid_entry field="exitCode" value=${JSON.stringify(item.exitCode)} action="inspect the pi-sub --list output"`);
    }
    if (item.state === "complete") {
      if (item.exitCode === null) {
        throw new Error('pi_sub_list_invalid_entry field="exitCode" reason="complete runs require a numeric exit code" action="inspect the pi-sub --list output"');
      }
    } else if (item.exitCode !== null) {
      throw new Error(`pi_sub_list_invalid_entry field="exitCode" value=${JSON.stringify(item.exitCode)} reason="${item.state} runs require a null exit code" action="inspect the pi-sub --list output"`);
    }
    if (item.model !== null && typeof item.model !== "string") {
      throw new Error(`pi_sub_list_invalid_entry field="model" action="inspect the pi-sub --list output"`);
    }
    if (typeof item.stateAgeSeconds !== "number" || !Number.isInteger(item.stateAgeSeconds) || item.stateAgeSeconds < 0) {
      throw new Error(`pi_sub_list_invalid_entry field="stateAgeSeconds" value=${JSON.stringify(item.stateAgeSeconds)} action="inspect the pi-sub --list output"`);
    }
    runs.push({
      runId: item.runId,
      alias: item.alias,
      state: item.state,
      exitCode: item.exitCode,
      model: item.model,
      stateAgeSeconds: item.stateAgeSeconds,
    });
  }
  return runs;
}

const ACTIVITY_TAIL_BYTES = 65_536;
const ACTIVITY_MAX_CHARS = 40;

const EVENT_SCAN_CHUNK_BYTES = 256 * 1024;
const EVENT_MAX_MESSAGES = 200;

export type EventMessage = {
  role: "assistant" | "user";
  timestamp: number;
  thinking?: string;
  toolCalls: Array<{ name: string; command?: string }>;
  text?: string;
};

export type EventHistoryPage = {
  messages: EventMessage[];
  nextOffset: number | null;
  reachedHead: boolean;
};

function extractTextFromContent(content: unknown, type: string): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!isRecord(part) || part.type !== type) continue;
    const value = part[type];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function extractToolCalls(content: unknown): Array<{ name: string; command?: string }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ name: string; command?: string }> = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "toolCall") continue;
    if (typeof part.name !== "string" || part.name === "") continue;
    const call: { name: string; command?: string } = { name: part.name };
    if (part.name === "bash" && isRecord(part.arguments) && typeof part.arguments.command === "string") {
      const command = part.arguments.command.split("\n")[0] ?? "";
      if (command.length > 0) call.command = command;
    }
    calls.push(call);
  }
  return calls;
}

/**
 * Parse a message_end event line into a displayable EventMessage.
 */
export function parseEventMessage(line: string): EventMessage | undefined {
  if (!line.includes('"message_end"')) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event.type !== "message_end") return undefined;
  const message = event.message;
  if (!isRecord(message)) return undefined;
  const role = message.role === "user" ? "user" : "assistant";
  const timestamp = typeof event.timestamp === "number" ? event.timestamp : 0;
  return {
    role,
    timestamp,
    thinking: role === "assistant" ? extractTextFromContent(message.content, "thinking") : undefined,
    toolCalls: role === "assistant" ? extractToolCalls(message.content) : [],
    text: extractTextFromContent(message.content, "text"),
  };
}

/**
 * Scan the events file from the tail (or a given offset) backwards, parsing
 * message_end events into displayable messages. Returns them in chronological
 * order plus the byte offset where the next (older) page starts.
 */
export function scanEventHistory(eventsPath: string, opts?: { fromOffset?: number }): EventHistoryPage {
  let handle: number;
  try {
    handle = openSync(eventsPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: [], nextOffset: null, reachedHead: true };
    }
    throw error;
  }
  try {
    const size = fstatSync(handle).size;
    if (size === 0) return { messages: [], nextOffset: null, reachedHead: true };
    const end = opts?.fromOffset !== undefined ? Math.min(opts.fromOffset, size) : size;
    const messages: EventMessage[] = [];
    let cursor = end;
    let reachedHead = false;

    while (messages.length < EVENT_MAX_MESSAGES && cursor > 0) {
      const chunkStart = Math.max(0, cursor - EVENT_SCAN_CHUNK_BYTES);
      const chunkSize = cursor - chunkStart;
      const buffer = Buffer.alloc(chunkSize);
      readSync(handle, buffer, 0, chunkSize, chunkStart);
      const chunk = buffer.toString("utf8");
      const lines = chunk.split("\n");
      // First line may be split; drop it unless we are at the file head.
      const firstIncomplete = chunkStart > 0 ? 1 : 0;
      for (let i = lines.length - 1; i >= firstIncomplete; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        if (messages.length >= EVENT_MAX_MESSAGES) break;
        const message = parseEventMessage(line);
        if (message) messages.push(message);
      }
      if (messages.length >= EVENT_MAX_MESSAGES) {
        cursor = chunkStart;
        break;
      }
      if (chunkStart === 0) {
        reachedHead = true;
        cursor = 0;
        break;
      }
      cursor = chunkStart;
    }
    messages.reverse();
    return { messages, nextOffset: reachedHead || cursor <= 0 ? null : cursor, reachedHead };
  } finally {
    closeSync(handle);
  }
}

export function extractRecentActivity(eventsPath: string): string | undefined {
  let handle: number;
  try {
    handle = openSync(eventsPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const size = fstatSync(handle).size;
    if (size === 0) return undefined;
    const start = Math.max(0, size - ACTIVITY_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    // Scan the newest events first; the latest tool start is the current activity.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"tool_execution_start"')) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event) || event.type !== "tool_execution_start") continue;
      if (typeof event.toolName !== "string" || event.toolName === "") continue;
      let activity: string;
      if (event.toolName === "bash" && isRecord(event.args) && typeof event.args.command === "string" && event.args.command !== "") {
        activity = `$ ${event.args.command}`;
      } else {
        activity = `Tool ${event.toolName}`;
      }
      if (!isDisplaySafe(activity)) return undefined;
      return activity.length <= ACTIVITY_MAX_CHARS
        ? activity
        : `${activity.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;
    }
    return undefined;
  } finally {
    closeSync(handle);
  }
}

export function reconcileActiveRuns(artifactRuns: ActiveRun[], listed: ListedRun[]): ActiveRun[] {
  const byId = new Map(listed.map((run) => [run.runId, run]));
  const merged: ActiveRun[] = [];
  for (const run of artifactRuns) {
    const listedRun = byId.get(run.runId);
    if (listedRun === undefined) {
      merged.push(run);
      continue;
    }
    if (listedRun.state === "complete") continue;
    merged.push({ ...run, state: listedRun.state, stateAgeSeconds: listedRun.stateAgeSeconds });
  }
  return merged;
}
