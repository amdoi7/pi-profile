---
name: pi-subagent
description: >-
  Pi subagent. Use only when the user explicitly asks to delegate a background
  task, run independent work in parallel, or check and collect a pi-sub run.
compatibility: macOS with Bash, lockf, shasum, mkfifo, tmux, jq, and the Pi CLI.
---

# Pi Subagent

pi-sub 在 detached tmux session 里运行独立的 print-mode Pi 会话。run 目录是
唯一生命周期事实源；后台 run 不阻塞 parent，completion 自动投递回 owner
session。用绝对路径的 runner：

```bash
PI_SUB="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/pi-sub"
```

## Orchestrate

1. **Build a self-contained task packet.** State the goal, scope, non-goals,
   concrete inputs, expected evidence, failure reporting, and write ownership.
   An alias may retain context, but hidden alias state is never part of the
   task contract. Done when: the packet is understandable without prior run
   output.
2. **Choose exactly one capability set.** Supplied text only: `--no-tools`.
   Repository inspection: `--tools read,grep,find,ls`. Mutation:
   `--tools read,bash,edit,write,grep,find,ls` plus one `--write-scope <path>`
   per exclusively assigned path; scopes are audit metadata, not a sandbox.
   Done when: the selection is justified, mutation declares every exclusive
   path, and concurrent mutation runs cannot overlap (use separate worktrees
   otherwise).
3. **Select an alias.** An alias is a durable lane scoped to the current
   owner session and project: reuse it only for a follow-up with the same
   responsibility; use a new alias for an independent task. Done when: the
   alias maps one-to-one to the responsibility.
4. **Start and retain the runId.**

   ```bash
   "$PI_SUB" reviewer --tools read,grep,find,ls \
     "Review the repository. Report correctness risks with file references and verification evidence."

   git diff | "$PI_SUB" diff-review --no-tools \
     "Review the supplied diff. Report only actionable correctness risks."

   "$PI_SUB" implementer \
     --tools read,bash,edit,write,grep,find,ls \
     --write-scope src/auth --write-scope tests/auth \
     "Implement the assigned auth change and report changed files and test output."
   ```

   Done when: the start JSON contains a `runId`.
5. **Continue only with disjoint parent work.** The parent owns the task
   graph, handoffs, conflict prevention, and integration; children never
   coordinate with each other. Done when: the parent's writes cannot collide
   with any running child's write scopes.
6. **Account for every result.** Completion messages carry bounded stdout and
   stderr; delivery collects but does not validate. On success, verify the
   evidence against the workspace; on failure, attribute the cause; on
   cancelled or lost, decide whether to rerun. Use `--result` for full output
   when the message reports truncation. Done when: every runId has a
   disposition and no completion is left unhandled.

## Inspect & Control

后台 run 不阻塞 parent；查询与控制全部走 CLI：

| Command | Use |
|---|---|
| `--list` | All owner runs as JSON; restore context and find lost runs |
| `--status <runId>` | One run's state |
| `--cancel <runId>` | Stop a queued/running run (terminal exit 130 = cancelled); rejects complete and lost runs |
| `--result <runId>` | Full stdout, stderr, and exit code |
| `--wait <runId>` | Block until completion; use only when the parent must synchronize |
| `--transcript <runId>` | The alias session's append-only Pi JSONL; repeatable and non-consuming |

`--list` entries carry `runId`, `alias`, `state` (`queued`, `running`,
`complete`, or `lost`), `exitCode` (number or `null`), `model` (string or
`null`), and `stateAgeSeconds`. With `PI_SESSION_ID` set it lists exactly that
session's runs; without it, only unowned runs. Pipe into `jq` for filtering.

## Runtime Contract

- Workers run in detached tmux sessions `pi-sub-<suffix>` (window = alias,
  pane label = `pi-sub:<runId>`), independent of any parent tmux session; the
  session is destroyed when the worker exits. tmux is required. `--cancel`
  stops a run: it exits 130 and is reported as `cancelled`, not `failed`. A
  worker that dies without publishing completion is `lost` in `--status`,
  `--list`, and the owner UI.
- Children always run with `--no-extensions --no-skills` and receive only the
  task packet, repository context, selected tools, and their durable session.
  They run in JSON event mode (`--mode json`): the event stream is kept as the
  run's `events` artifact, and stdout, stderr, and the exit code are projected
  from the last assistant message, so the collected result contract is
  unchanged. Nested pi-sub starts are rejected; the runner owns print mode,
  naming, and session selection. `jq` is required for the projection.
- Runs started by a Pi Bash tool inherit `PI_SESSION_ID`; only that session's
  UI receives completion. Runs from a normal shell are unowned and need manual
  collection. If `PI_SUB_RUN_DIR` is overridden, set it in the parent Pi
  environment so the UI scans the same artifacts.
- Same-owner, same-alias runs serialize; different aliases run concurrently.
  Parent sessions in the same project do not share child sessions.
- Model selection: explicit child flags win; otherwise Pi runs inherit the
  parent's provider, model, and reasoning level; `PI_SUB_DEFAULT_MODEL` is
  the standalone-shell fallback; Pi settings apply last. An explicit provider
  or model is never combined with the parent's other value; an explicit
  `--thinking` or model `:thinking` suffix wins over inherited reasoning.
- Piped stdin is captured before launch. Result reads are repeatable.
  Artifacts live under `${TMPDIR:-/tmp}/pi-subagent-$UID` unless
  `PI_SUB_RUN_DIR` is set. The `events` JSONL stream (tool calls, messages) is
  kept per run and drives the active-run widget's live activity line. Aliases
  accept `[A-Za-z0-9._-]`. `--` is rejected.
