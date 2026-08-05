# pi-sub

`pi-sub` starts isolated Pi print-mode workers in the background while the
parent Pi session retains orchestration and result ownership. The runtime is a
shell CLI; extensions do not own worker processes or lifecycle state.

## Install

```bash
./init.sh
```

This installs the runner at `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/pi-sub`.

## Start

Every run requires one explicit capability selector:

```bash
pi-sub reviewer --tools read,grep,find,ls \
  "Review the repository and report correctness risks with file references"

git diff | pi-sub diff-review --no-tools \
  "Review the supplied diff and report only actionable findings"
```

`bash`, `edit`, and `write` are mutation capabilities. A mutation run must
declare every exclusively assigned path; declarations are recorded for audit
and UI display, not used as a sandbox:

```bash
pi-sub implementer \
  --tools read,bash,edit,write,grep,find,ls \
  --write-scope src/auth \
  --write-scope tests/auth \
  "Implement the assigned change and run focused tests"
```

The child always runs with `--no-extensions --no-skills`. Explicit extension
or skill loading is rejected. The built-in tool allowlist is `read`, `bash`,
`edit`, `write`, `grep`, `find`, and `ls`.

The runner accepts these additional Pi options: `--provider`, `--model`,
`--api-key`, `--system-prompt`, `--append-system-prompt`, `--models`,
`--thinking`, `--prompt-template`, `--theme`, approval flags, offline mode,
verbose mode, and the `--no-*` forms for prompt templates, themes, and context
files. Unknown options fail closed so an option value cannot be mistaken for a
capability selector.

## Collect

Start prints a JSON envelope containing the `runId`. Lifecycle queries are:

```bash
pi-sub --list
pi-sub --status reviewer.xxxxxx
pi-sub --result reviewer.xxxxxx
pi-sub --wait reviewer.xxxxxx
pi-sub --transcript reviewer.xxxxxx
```

`--list` prints one JSON array for the current owner, ready for `jq`:
each entry carries `runId`, `alias`, `state` (`queued`, `running`, `complete`,
or `lost`), `exitCode` (number or `null`), `model` (string or `null`), and
`stateAgeSeconds` (seconds since the state was last published, taken from the
status file mtime). With `PI_SESSION_ID` set it lists exactly that session's
runs; without it, only unowned runs. `--list` detects `lost` workers the same
way `--status` does: a run whose lock is released without a published
completion.

`--result` fails while a worker is active. `--wait` blocks on the run lock.
Both relay child stdout, stderr, and the child exit code without consuming the
stored result. An alias reuses one child Pi session within its owner parent
session. Different parent Pi sessions in the same directory receive distinct
child sessions, and one active parent cannot query another parent's run.
Same-owner, same-alias runs are serialized by locking their shared durable
session file; different aliases may execute concurrently.

`--transcript` returns the alias session's durable Pi JSONL immediately. It is
repeatable while a run is active or complete and does not consume the result.

In TUI mode, the owner session receives an active-run widget below the
editor, a completion card with stdout and stderr bounded by Pi's standard
output limits, and a `/pisub` command that opens a floating history overlay
listing every run for the current session (newest first). Use ↑↓ to navigate
the list, Enter to view a run's metadata and output, and Esc to go back or
close. Exit 0 completes, exit 130 is reported as `cancelled`,
other nonzero exits fail, and a worker that died without publishing is
reported as `lost` with its worker stderr. Expand the card for output,
orchestration metadata, and repeatable result and transcript commands.
Cancelled and lost runs use warning/error notifications and retain the child
exit code where one exists.

## Artifacts

Runs live under `${PI_SUB_RUN_DIR:-${TMPDIR:-/tmp}/pi-subagent-$UID}/runs`.
Each run records status, stdout, stderr, owner session, alias, project cwd,
session ID and file, task mode, selected tools, requested provider, model,
thinking level, declared write scopes, a caller environment snapshot, and the
raw JSON event stream (`events`) emitted by the child. The child runs in JSON
event mode; stdout, stderr, and the exit code are projected from the last
assistant message, keeping the collected-result contract unchanged. `jq` is a
runtime dependency for the projection. Durable alias sessions live under
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/processes/pi-subagent-sessions`; each
session JSONL is also its alias lock carrier, so no separate lock artifacts are
created. The owner session notification is claimed atomically in the run
directory.

Model precedence is explicit child flags, parent Pi context,
`PI_SUB_DEFAULT_MODEL`, then Pi settings. Provider and model are inherited
together only when neither was supplied explicitly. Parent reasoning is
inherited independently unless the child supplies `--thinking` or a model
`:thinking` suffix.

## Verify

```bash
./pi-sub_test.sh
```
