---
name: pi-subagent
description: >
  Start Pi as a background one-shot subagent, keep a deterministic
  project-local session by alias, and collect the run later.
---

# Pi Subagent

Invoke the script from the target project directory. It returns after the
background worker is ready; Pi continues without blocking the calling shell.

```bash
PI_SUB="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/pi-subagent/pi-sub.sh"
```

## Start And Collect

```bash
"$PI_SUB" reviewer "Review this repository"
# {"ok":true,"state":"started","runId":"reviewer.xxxxxx","sessionId":"..."}

"$PI_SUB" --status reviewer.xxxxxx
# queued, running, complete, or lost

"$PI_SUB" --result reviewer.xxxxxx
# Return immediately. Fails while the run is active.

"$PI_SUB" --wait reviewer.xxxxxx
# Wait for this run, then relay Pi stdout, stderr, and exit code.
```

Continue useful parent work after `start`; call `--wait` only when the result is
needed. Reusing an alias resumes the same Pi session. Runs for the same alias
are serialized by the OS file lock, while different aliases may run together.

## Inputs And Options

```bash
"$PI_SUB" reviewer --model sonnet:high @README.md "Review this file"

git diff | "$PI_SUB" commit-writer "Write a commit message"

"$PI_SUB" audit --tools read,grep,find,ls "Review this repo"

"$PI_SUB" audit --no-tools "Analyze the supplied text only"
```

Aliases accept letters, digits, `.`, `_`, and `-`. Piped stdin is captured
before the worker starts. Run artifacts live under the system temp directory;
override it with `PI_SUB_RUN_DIR` when durable result files are required.

Subagent runs default to `deepseek-v4-flash` (pinned in `pi-sub.sh`); override
with `PI_SUB_DEFAULT_MODEL` or an explicit `--model`.

The wrapper owns print mode, session selection, session directory, and session
name. Invoke `pi` directly for interactive mode, `--resume`, `--fork`, an
ephemeral session, or an explicit session ID.

## Native Pi Sessions

```bash
pi -c                 # Continue the latest session
pi -r                 # Browse sessions
pi --session <id>     # Open a specific session
pi --fork <id>        # Fork a session
pi --no-session       # Use an ephemeral session
pi --name "Audit"     # Name an interactive session
```
