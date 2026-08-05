/**
 * pi-sub-ui keeps presentation and owner-session wakeups outside the runner.
 * The run directory remains the sole lifecycle authority; the CLI owns state
 * transitions (including lost detection), and this extension only projects
 * artifacts and wakes the owner session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
  claimRunNotification,
  extractRecentActivity,
  parseListOutput,
  readRunOutput,
  readWorkerStderr,
  reconcileActiveRuns,
  releaseRunNotification,
  scanRunsDir,
  scanRunHistory,
  type ListedRun,
} from "./pi-sub-core.ts";
import {
  buildCompletionMessage,
  COMPLETION_MESSAGE_TYPE,
  formatActiveWidgetLines,
  PiSubHistoryOverlay,
  renderCompletionMessage,
  type FinishedRun,
  type RunOutcome,
} from "./ui.ts";

const POLL_INTERVAL_MS = 1_000;
const LIST_TIMEOUT_MS = 5_000;
const LOST_DELIVERY_OBSERVATIONS = 2;
const WIDGET_ID = "pi-sub-active";

function getRunRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return process.env.PI_SUB_RUN_DIR ?? join(process.env.TMPDIR ?? "/tmp", `pi-subagent-${uid}`);
}

function getRunsDir(): string {
  return join(getRunRoot(), "runs");
}

function getPiSubPath(): string {
  if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, "bin", "pi-sub");
  if (process.env.HOME) return join(process.env.HOME, ".pi", "agent", "bin", "pi-sub");
  throw new Error("HOME or PI_CODING_AGENT_DIR is required to locate pi-sub");
}

function outcomeForExitCode(exitCode: string): RunOutcome {
  if (exitCode === "0") return "complete";
  if (exitCode === "130") return "cancelled";
  return "failed";
}

function notifyLevelForOutcome(outcome: RunOutcome): "info" | "warning" | "error" {
  if (outcome === "complete") return "info";
  if (outcome === "cancelled") return "warning";
  return "error";
}

function notifyMessageForOutcome(outcome: RunOutcome, runId: string, exitCode: string | null): string {
  if (outcome === "complete") return `pi-sub complete: ${runId}`;
  if (outcome === "cancelled") return `pi-sub cancelled: ${runId} (exit ${exitCode})`;
  if (outcome === "failed") return `pi-sub failed: ${runId} (exit ${exitCode})`;
  return `pi-sub lost: ${runId}`;
}

export default function piSubUiExtension(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let pollInFlight = false;
  const lostObservations = new Map<string, number>();

  pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, renderCompletionMessage);

  const stopPolling = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (activeContext?.hasUI) {
      activeContext.ui.setWidget(WIDGET_ID, undefined);
    }
    activeContext = undefined;
  };

  const listRuns = async (ownerSessionId: string): Promise<ListedRun[]> => {
    // pi.exec captures the child env synchronously at spawn, so the temporary
    // mutation cannot race another exec. The CLI derives owner scope from
    // PI_SESSION_ID and must see the current session, not the launch session.
    const previous = process.env.PI_SESSION_ID;
    process.env.PI_SESSION_ID = ownerSessionId;
    try {
      const result = await pi.exec(getPiSubPath(), ["--list"], { timeout: LIST_TIMEOUT_MS });
      if (result.code !== 0) {
        throw new Error(
          `pi_sub_list_failed code=${result.code} stderr="${result.stderr.trim()}" action="verify the pi-sub runner is installed and PI_SUB_RUN_DIR matches the runs being scanned"`,
        );
      }
      return parseListOutput(result.stdout);
    } finally {
      if (previous === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = previous;
    }
  };

  const startPolling = async (ctx: ExtensionContext) => {
    if (timer !== undefined) return;
    activeContext = ctx;
    const ownerSessionId = ctx.sessionManager.getSessionId();

    const deliverLost = (runDir: string, runId: string) => {
      const claimPath = claimRunNotification(runDir);
      if (claimPath === undefined) return;
      try {
        const run: FinishedRun = {
          runId,
          outcome: "lost",
          exitCode: null,
          stdout: "",
          stderr: "",
          workerStderr: readWorkerStderr(runDir),
        };
        pi.sendMessage(buildCompletionMessage(run, getPiSubPath()), {
          deliverAs: "followUp",
          triggerTurn: true,
        });
        ctx.ui.notify(notifyMessageForOutcome("lost", runId, null), "error");
      } catch (error) {
        releaseRunNotification(claimPath, error);
      }
    };

    const poll = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const runsDir = getRunsDir();
        const artifactActive = scanRunsDir(runsDir, ownerSessionId, (run) => {
          const outcome = outcomeForExitCode(run.exitCode);
          pi.sendMessage(buildCompletionMessage({ ...run, outcome }, getPiSubPath()), {
            deliverAs: "followUp",
            triggerTurn: true,
          });
          ctx.ui.notify(
            notifyMessageForOutcome(outcome, run.runId, run.exitCode),
            notifyLevelForOutcome(outcome),
          );
        });

        let displayRuns = artifactActive;
        if (artifactActive.length > 0) {
          const listed = await listRuns(ownerSessionId);
          const merged = reconcileActiveRuns(artifactActive, listed);
          for (const run of merged) {
            if (run.state === "running") {
              run.activity = extractRecentActivity(join(runsDir, run.runId, "events"));
            }
          }

          // A lost run is delivered only after two consecutive observations so
          // the cancel path (kill session -> worker trap publishes complete 130
          // within milliseconds) cannot be misreported as a permanent loss.
          const lostIds = new Set(merged.filter((run) => run.state === "lost").map((run) => run.runId));
          const deliveredLost = new Set<string>();
          for (const runId of lostIds) {
            const observations = lostObservations.get(runId) ?? 0;
            if (observations + 1 >= LOST_DELIVERY_OBSERVATIONS) {
              deliverLost(join(runsDir, runId), runId);
              deliveredLost.add(runId);
            } else {
              lostObservations.set(runId, observations + 1);
            }
          }
          for (const runId of [...lostObservations.keys()]) {
            if (!lostIds.has(runId) || deliveredLost.has(runId)) lostObservations.delete(runId);
          }
          displayRuns = merged.filter((run) => !deliveredLost.has(run.runId));
        }

        if (activeContext !== ctx) return;
        if (displayRuns.length === 0) {
          ctx.ui.setWidget(WIDGET_ID, undefined);
        } else {
          ctx.ui.setWidget(
            WIDGET_ID,
            (_tui, theme) => ({
              render: (width) => formatActiveWidgetLines(displayRuns, width, theme),
              invalidate: () => {},
            }),
            { placement: "belowEditor" },
          );
        }
      } catch (error) {
        stopPolling();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-sub UI stopped: ${message}`, "error");
      } finally {
        pollInFlight = false;
      }
    };

    timer = setInterval(poll, POLL_INTERVAL_MS);
    await poll();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") await startPolling(ctx);
  });

  pi.registerCommand("pisub", {
    description: "Browse pi-sub run history in a floating overlay",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const runsDir = getRunsDir();
      const ownerSessionId = ctx.sessionManager.getSessionId();
      const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
        const overlay = new PiSubHistoryOverlay(
          scanRunHistory(runsDir, ownerSessionId),
          (run) => {
            const output = readRunOutput(runsDir, run.runId);
            if (run.state === "running") {
              output.activity = extractRecentActivity(join(runsDir, run.runId, "events"));
            }
            return output;
          },
          theme,
          {
            onClose: () => done(null),
            onRequestRender: () => tui.requestRender(),
          },
        );
        const refreshTimer = setInterval(() => {
          overlay.setRuns(scanRunHistory(runsDir, ownerSessionId));
          tui.requestRender();
        }, 1_000);
        return {
          render: (width: number) => overlay.render(width),
          invalidate: () => {},
          handleInput: (data: string) => overlay.handleInput(data),
          dispose: () => clearInterval(refreshTimer),
        };
      }, {
        overlay: true,
        overlayOptions: {
          width: "80%",
          minWidth: 72,
          maxHeight: "78%",
          anchor: "top-center",
          margin: { top: 1, left: 2, right: 2 },
        },
      });
      if (result !== null) ctx.ui.notify(`pi-sub history closed (${scanRunHistory(runsDir, ownerSessionId).length} runs)`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
  });
}
