/**
 * pi-sub-watch — tick the interactive session when a background pi-sub run
 * completes.
 *
 * Polls the pi-sub runs directory (PI_SUB_RUN_DIR or the default under
 * TMPDIR) once per second. When a run transitions to "complete", injects a
 * user message into the active session so the agent is woken up immediately
 * and can collect the result — no polling by the agent itself.
 *
 * Only active in TUI mode: print-mode workers (pi -p, i.e. pi-sub runs
 * themselves) load extensions too but must not tick anyone.
 *
 * Each run names its owner Pi session. Completion delivery is claimed
 * atomically in the run directory, so other sessions and reloaded watcher
 * instances cannot announce the same run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { scanRunsDir } from "./pi-sub-watch-core.ts";

const POLL_INTERVAL_MS = 1_000;

function getRunRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return process.env.PI_SUB_RUN_DIR ?? join(process.env.TMPDIR ?? "/tmp", `pi-subagent-${uid}`);
}

function getRunsDir(): string {
  return join(getRunRoot(), "runs");
}

function getPiSubPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
  return join(agentDir, "skills", "pi-subagent", "pi-sub.sh");
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopPolling = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const startPolling = (ctx: ExtensionContext) => {
    if (timer !== undefined) return;
    const ownerSessionId = ctx.sessionManager.getSessionId();

    timer = setInterval(() => {
      try {
        scanRunsDir(getRunsDir(), ownerSessionId, (run) => {
          const message =
            `[pi-sub] ${run.runId} completed (exit ${run.exitCode}). ` +
            `Collect: "${getPiSubPath()}" --result ${run.runId}`;

          pi.sendUserMessage(message, { deliverAs: "followUp" });
          ctx.ui.notify(`pi-sub done: ${run.runId}`, "info");
        });
      } catch (error) {
        stopPolling();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-sub watch stopped: ${message}`, "error");
      }
    }, POLL_INTERVAL_MS);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      startPolling(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
  });
}
