import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActiveRun, CompletedRun } from "./pi-sub-core.ts";
import {
  buildCompletionMessage,
  formatActiveWidgetLines,
  formatHistoryDetail,
  formatHistoryLine,
  PiSubHistoryOverlay,
  renderCompletionMessage,
  type FinishedRun,
} from "./ui.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

const colorTheme = {
  fg: (name: string, text: string) => `[${name}]${text}`,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function render(run: FinishedRun, expanded = false, t = theme): string {
  const message = buildCompletionMessage(run, "/Users/test/Pi Agent/bin/pi-sub");
  return renderCompletionMessage(message, { expanded, outputPad: 0 }, t as never)
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("pi-sub UI", () => {
  test("formats one widget line per active run with bounded width", () => {
    const runs: ActiveRun[] = [
      {
        runId: "review.abc123",
        state: "running",
        alias: "review",
        taskMode: "read-only",
        provider: "ciii",
        model: "test-model",
        thinking: "high",
        stateAgeSeconds: 42,
        activity: "$ rg auth.go",
      },
      { runId: "impl.def456", state: "queued", alias: "impl" },
    ];
    const lines = formatActiveWidgetLines(runs, 200, theme);
    expect(lines).toEqual([
      "● review · read-only · ciii/test-model · think:high · running 42s · $ rg auth.go",
      "○ impl · queued",
    ]);
    const truncated = formatActiveWidgetLines(runs, 24, theme);
    expect(visibleWidth(truncated[0]!)).toBeLessThanOrEqual(24);
  });

  test("colors widget state tokens by attention level", () => {
    const lines = formatActiveWidgetLines(
      [
        { runId: "a.1", state: "running" },
        { runId: "b.1", state: "queued" },
        { runId: "c.1", state: "lost" },
      ],
      200,
      colorTheme,
    );
    expect(lines[0]).toContain("[accent]● #1");
    expect(lines[0]).toContain("[accent]running");
    expect(lines[1]).toContain("[muted]○ #1");
    expect(lines[1]).toContain("[muted]queued");
    expect(lines[2]).toContain("[error]✗ #1");
    expect(lines[2]).toContain("[error]lost");
  });

  test("builds a shell-safe collection instruction for the parent agent", () => {
    const message = buildCompletionMessage({
      runId: "review.abc123",
      outcome: "complete",
      exitCode: "0",
      alias: "review",
      stdout: "finding one\nfinding two\n",
      stderr: "",
    }, "/tmp/Pi Agent/pi-sub");

    expect(message.customType).toBe("pi-sub-complete");
    expect(message.content).toContain("pi-sub run review.abc123 completed with exit 0");
    expect(message.content).toContain("stdout:\nfinding one\nfinding two");
    expect(message.content).not.toContain("Collect it now");
    expect(message.details.collectCommand).toBe("'/tmp/Pi Agent/pi-sub' --result review.abc123");
    expect(message.details.transcriptCommand).toBe("'/tmp/Pi Agent/pi-sub' --transcript review.abc123");
  });

  test("builds a cancelled completion distinct from failure", () => {
    const message = buildCompletionMessage({
      runId: "review.cx",
      outcome: "cancelled",
      exitCode: "130",
      alias: "review",
      stdout: "partial\n",
      stderr: "",
    }, "/tmp/pi-sub");

    expect(message.details.outcome).toBe("cancelled");
    expect(message.details.exitCode).toBe("130");
    expect(message.content).toContain("was cancelled (exit 130)");
    expect(message.content).toContain("No result was produced");
    expect(message.content).not.toContain("failed");
    expect(message.content).not.toContain("The result is already collected");
  });

  test("builds a lost completion from worker stderr with a null exit code", () => {
    const message = buildCompletionMessage({
      runId: "review.lost",
      outcome: "lost",
      exitCode: null,
      alias: "review",
      stdout: "",
      stderr: "",
      workerStderr: "worker died\n",
    }, "/tmp/pi-sub");

    expect(message.details.outcome).toBe("lost");
    expect(message.details.exitCode).toBeNull();
    expect(message.content).toContain("was lost: the worker exited before publishing completion");
    expect(message.content).toContain("worker died");
    expect(message.content).toContain("--transcript");
    expect(message.content).not.toContain("The result is already collected");
  });

  test("renders a compact successful completion and expands orchestration metadata", () => {
    const run: FinishedRun = {
      runId: "impl.abc123",
      outcome: "complete",
      exitCode: "0",
      alias: "impl",
      taskMode: "mutation",
      tools: "read,bash,edit,write",
      provider: "ciii",
      model: "test-model",
      thinking: "high",
      projectCwd: "/workspace/project",
      writeScopes: ["src/auth", "tests/auth"],
      stdout: "implemented auth flow\nall tests passed\n",
      stderr: "provider warning\n",
    };

    const collapsed = render(run);
    expect(collapsed).toContain("pi-sub complete impl");
    expect(collapsed).toContain("run impl.abc123 · exit 0");
    expect(collapsed).toContain("implemented auth flow");
    expect(collapsed).not.toContain("collect ");
    expect(collapsed).not.toContain("write scopes");

    const expanded = render(run, true);
    expect(expanded).toContain("stdout\nimplemented auth flow\nall tests passed");
    expect(expanded).toContain("stderr\nprovider warning");
    expect(expanded).toContain("collect '/Users/test/Pi Agent/bin/pi-sub' --result impl.abc123");
    expect(expanded).toContain("transcript '/Users/test/Pi Agent/bin/pi-sub' --transcript impl.abc123");
    expect(expanded).toContain("mode mutation · tools read,bash,edit,write · model ciii/test-model · thinking high");
    expect(expanded).toContain("write scopes src/auth, tests/auth");
    expect(expanded).toContain("cwd /workspace/project");
  });

  test("renders nonzero completion as failed", () => {
    expect(render({ runId: "review.failed", outcome: "failed", exitCode: "7", alias: "review", stdout: "", stderr: "provider failed\n" }))
      .toContain("pi-sub failed review");
  });

  test("renders cancelled as a distinct warning outcome", () => {
    const run: FinishedRun = {
      runId: "review.cx",
      outcome: "cancelled",
      exitCode: "130",
      alias: "review",
      stdout: "partial\n",
      stderr: "",
    };
    const collapsed = render(run);
    expect(collapsed).toContain("pi-sub cancelled review");
    expect(collapsed).toContain("run review.cx · exit 130");
    expect(collapsed).not.toContain("failed");
    const colored = render(run, false, colorTheme);
    expect(colored).toContain("[warning]cancelled");
    expect(colored).not.toContain("[error]");
  });

  test("renders lost with worker stderr and without a collect path", () => {
    const run: FinishedRun = {
      runId: "review.lost",
      outcome: "lost",
      exitCode: null,
      alias: "review",
      stdout: "",
      stderr: "",
      workerStderr: "worker died\n",
    };
    const collapsed = render(run);
    expect(collapsed).toContain("pi-sub lost review");
    expect(collapsed).toContain("run review.lost · worker lost");
    expect(collapsed).toContain("worker died");
    expect(collapsed).not.toContain("exit null");
    const expanded = render(run, true);
    expect(expanded).toContain("transcript '/Users/test/Pi Agent/bin/pi-sub' --transcript review.lost");
    expect(expanded).not.toContain("collect ");
    expect(expanded).toContain("worker died");
  });

  test("bounds injected output with Pi's standard truncation contract", () => {
    const stdout = Array.from({ length: 2_001 }, (_, index) => `line ${index + 1}`).join("\n");
    const message = buildCompletionMessage({ runId: "review.large", outcome: "complete", exitCode: "0", stdout, stderr: "" }, "/tmp/pi-sub");

    expect(message.details.outputTruncated).toBeTrue();
    expect(message.details.totalLines).toBe(2_002);
    expect(message.content).toContain("[Result truncated: 2000/2002 lines");
    expect(message.content).toContain("'/tmp/pi-sub' --result review.large");
  });

  test("escapes terminal control bytes in rendered child output", () => {
    const rendered = render({ runId: "review.ansi", outcome: "complete", exitCode: "0", stdout: "\u001b[31munsafe\n", stderr: "" });

    expect(rendered).toContain("\\x1b[31munsafe");
    expect(rendered).not.toContain("\u001b");
  });

  test("formats history lines with state, exit, model, and age", () => {
    const now = Date.now();
    const run = {
      runId: "review.abc123",
      state: "complete" as const,
      exitCode: "0",
      startedAtMs: now - 3_600_000,
      alias: "review",
      taskMode: "read-only" as const,
      provider: "ciii",
      model: "test-model",
      thinking: "high",
      stdout: "",
      stderr: "",
    };
    const line = formatHistoryLine(run, true, 120, theme);
    expect(line).toContain("✓ review");
    expect(line).toContain("complete exit 0");
    expect(line).toContain("ciii/test-model");
    expect(line).toContain("1h");
    expect(line.startsWith("▶")).toBeTrue();

    const running = formatHistoryLine({ ...run, state: "running", exitCode: null }, false, 120, theme);
    expect(running).toContain("● review");
    expect(running).not.toContain("exit");
  });

  test("renders history detail with metadata and output", () => {
    const now = Date.now();
    const run = {
      runId: "impl.def456",
      state: "complete" as const,
      exitCode: "0",
      startedAtMs: now - 60_000,
      alias: "impl",
      taskMode: "mutation" as const,
      tools: "read,bash,edit,write",
      provider: "ciii",
      model: "test-model",
      thinking: "high",
      projectCwd: "/workspace/project",
      writeScopes: ["src/auth"],
    };
    const output = { stdout: "implemented auth\nall tests passed\n", stderr: "" };
    const lines = formatHistoryDetail(run, output, 120, theme).join("\n");
    expect(lines).toContain("pi-sub complete impl");
    expect(lines).toContain("run impl.def456 · exit 0");
    expect(lines).toContain("mode mutation · tools read,bash,edit,write · model ciii/test-model · thinking high");
    expect(lines).toContain("cwd /workspace/project");
    expect(lines).toContain("implemented auth");
    expect(lines).toContain("all tests passed");
  });

  test("navigates the history overlay between list and detail", () => {
    const now = Date.now();
    const runs = [
      { runId: "a.1", state: "complete" as const, exitCode: "0", startedAtMs: now, alias: "a" },
      { runId: "b.2", state: "running" as const, exitCode: null, startedAtMs: now - 1000, alias: "b" },
    ];
    let renders = 0;
    let closed = false;
    let loaded: string[] = [];
    const overlay = new PiSubHistoryOverlay(
      runs,
      (run) => {
        loaded.push(run.runId);
        return { stdout: `out of ${run.runId}\n`, stderr: "" };
      },
      theme as never,
      {
        onClose: () => {
          closed = true;
        },
        onRequestRender: () => {
          renders += 1;
        },
      },
    );

    const list = overlay.render(120).join("\n");
    expect(list).toContain("✓ a");
    expect(list).toContain("● b");
    expect(list).toContain("enter view · esc close");
    expect(loaded).toEqual([]);

    overlay.handleInput("\u001b[B"); // down
    expect(renders).toBe(1);
    overlay.handleInput("\r"); // enter -> detail
    expect(loaded).toEqual(["b.2"]);
    const detail = overlay.render(120).join("\n");
    expect(detail).toContain("pi-sub running b");
    expect(detail).toContain("out of b.2");
    expect(detail).toContain("esc back");

    overlay.handleInput("\u001b"); // esc -> list
    const back = overlay.render(120).join("\n");
    expect(back).toContain("enter view · esc close");
    expect(closed).toBeFalse();

    overlay.handleInput("\u001b"); // esc -> close
    expect(closed).toBeTrue();
  });

  test("refreshes the history overlay while preserving selection", () => {
    const now = Date.now();
    const initial = [
      { runId: "a.1", state: "complete" as const, exitCode: "0", startedAtMs: now, alias: "a" },
      { runId: "b.2", state: "running" as const, exitCode: null, startedAtMs: now - 1000, alias: "b" },
    ];
    let renders = 0;
    const overlay = new PiSubHistoryOverlay(
      initial,
      () => ({ stdout: "", stderr: "" }),
      theme as never,
      {
        onClose: () => {},
        onRequestRender: () => {
          renders += 1;
        },
      },
    );

    overlay.handleInput("\u001b[B"); // select b
    overlay.handleInput("\r"); // open detail of b
    expect(overlay.getSelectedRun()?.runId).toBe("b.2");

    // A new run appears at the top; b completes.
    overlay.setRuns([
      { runId: "c.3", state: "running" as const, exitCode: null, startedAtMs: now + 1000, alias: "c" },
      { runId: "a.1", state: "complete" as const, exitCode: "0", startedAtMs: now, alias: "a" },
      { runId: "b.2", state: "complete" as const, exitCode: "0", startedAtMs: now - 1000, alias: "b" },
    ]);
    // Selection follows b.2 by runId.
    expect(overlay.getSelectedRun()?.runId).toBe("b.2");

    // b disappears entirely; selection falls back by position.
    overlay.setRuns([
      { runId: "c.3", state: "running" as const, exitCode: null, startedAtMs: now + 1000, alias: "c" },
      { runId: "a.1", state: "complete" as const, exitCode: "0", startedAtMs: now, alias: "a" },
    ]);
    expect(overlay.getSelectedRun()?.runId).toBe("a.1");
    // setRuns itself does not render; the host calls requestRender.
    expect(renders).toBe(2);
  });
});
