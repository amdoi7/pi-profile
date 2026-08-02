---
name: pi-subagent
description: >-
  Pi subagent. Use only when the user explicitly asks to delegate a background
  task, run independent work in parallel, or check and collect a pi-sub run.
compatibility: macOS with Bash, lockf, shasum, mkfifo, nohup, and the Pi CLI.
---

# Pi Subagent

Run the wrapper from the target project directory:

```bash
PI_SUB="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/pi-subagent/pi-sub.sh"
```

## Orchestrate

1. Build a self-contained task packet with the goal, scope, non-goals, inputs,
   expected evidence, and write ownership. A durable lane may provide context,
   but hidden lane state is never an input contract.
2. Select the alias and tools. An alias is a durable project-local lane: reuse
   it only for a follow-up with the same responsibility; use a new alias for an
   independent task. Infer tools from intent:
   - Supplied text only: `--no-tools`.
   - Inspection or review: `--tools read,grep,find,ls`.
   - Mutation: `--tools read,bash,edit,write,grep,find,ls`, only after assigning
     an exclusive file set or worktree. `bash` grants mutation authority.
3. Start the run and retain its `runId`:

```bash
"$PI_SUB" reviewer --tools read,grep,find,ls "Review this repository"
# {"ok":true,"state":"started","runId":"reviewer.xxxxxx",...}

git diff | "$PI_SUB" diff-review --no-tools \
  "Review the supplied diff for correctness risks"
```

4. Continue only parent work disjoint from every running child. Subagents do
   not start subagents or coordinate with each other; the parent owns the task
   graph, explicit handoffs, and integration.
5. Collect every result before making a dependent decision or finishing:

```bash
"$PI_SUB" --status reviewer.xxxxxx  # queued, running, complete, or lost
"$PI_SUB" --result reviewer.xxxxxx  # immediate; fails while active
"$PI_SUB" --wait reviewer.xxxxxx    # wait; relay stdout, stderr, and exit code
```

Treat a child result as evidence, not authority. Verify its claims against the
workspace and reconcile any authorized edits. The orchestration is complete
only when every relevant run is collected and its output is validated or its
failure is accounted for.

## Runtime Contract

Runs started by a Pi bash tool inherit the parent `PI_SESSION_ID`; only that
session's watcher receives the completion event. Runs started from a normal
shell have no owner and must be collected manually. If `PI_SUB_RUN_DIR` is
overridden, set it in the parent Pi environment as well so its watcher scans
the same artifacts.

Same-alias runs are serialized; different aliases may run concurrently. Piped
stdin is captured before launch. Artifacts use the system temp directory unless
`PI_SUB_RUN_DIR` is set. Aliases accept letters, digits, `.`, `_`, and `-`.

The default model is `deepseek-v4-flash`; override it with
`PI_SUB_DEFAULT_MODEL` or `--model`. The wrapper owns print mode, naming, and
session selection. It rejects `--` because Pi does not implement an
end-of-options marker.
