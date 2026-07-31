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
 * The notified set is persisted to disk so a /reload (which re-runs the
 * extension factory and resets in-memory state) never re-ticks runs that
 * were already announced. The poll timer is torn down on session shutdown
 * with reason "reload" so repeated reloads do not stack timers.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { collectCompletedRunIds, loadNotified, saveNotified, scanRunsDir } from "./pi-sub-watch-core.ts";

const POLL_INTERVAL_MS = 1_000;

function getRunRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return process.env.PI_SUB_RUN_DIR ?? join(process.env.TMPDIR ?? "/tmp", `pi-subagent-${uid}`);
}

function getRunsDir(): string {
  return join(getRunRoot(), "runs");
}

function getNotifiedFile(): string {
  return join(getRunRoot(), ".pi-sub-watch-notified.json");
}

function getPiSubPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
  return join(agentDir, "skills", "pi-subagent", "pi-sub.sh");
}

export default function (pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const startPolling = () => {
    if (timer !== undefined) return;

    const notifiedFile = getNotifiedFile();
    const notified = loadNotified(notifiedFile);

    // First start or upgrade from a pre-persistence version: the notified file
    // is missing, so silently mark every already-complete run as notified.
    // Otherwise a /reload would re-announce all historical runs.
    if (notified.size === 0) {
      for (const runId of collectCompletedRunIds(getRunsDir())) {
        notified.add(runId);
      }
      saveNotified(notifiedFile, notified);
    }

    timer = setInterval(() => {
      let changed = false;
      scanRunsDir(getRunsDir(), notified, (run) => {
        const ctx = currentCtx;
        if (!ctx) return;

        const message =
          `[pi-sub] ${run.runId} completed (exit ${run.exitCode}). ` +
          `Collect: "${getPiSubPath()}" --result ${run.runId}`;

        // Always deliver as followUp: pi ignores streamingBehavior when idle
        // (sends immediately) and queues it while streaming. This also closes
        // the race between an isIdle() check and the async send, which would
        // otherwise surface as "Agent is already processing a prompt".
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify(`pi-sub done: ${run.runId}`, "info");
        changed = true;
      });
      if (changed) {
        saveNotified(notifiedFile, notified);
      }
    }, POLL_INTERVAL_MS);
  };

  const stopPolling = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.mode === "tui") {
      startPolling();
    }
  });

  // Tear the timer down on reload so the re-run factory starts fresh with the
  // persisted notified set; without this, stacked timers double-tick runs.
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") {
      stopPolling();
    }
  });
}
