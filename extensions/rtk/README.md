# RTK rewrite policy

`rtk/` owns the pure RTK command rewrite policy. Runtime hook ownership belongs to `../command-policy/`; this module only delegates eligible command groups to official `rtk rewrite` and returns the rewritten command.

## Flow

```text
Pi tool_call: bash / run_experiment
        │
        ▼
command-policy extension
        │
        ▼
RTK pure policy
        │  calls: rtk rewrite "<command>"
        ▼
official RTK rewrite registry
        │
        ├─ exit 0 + stdout  → use rewritten command
        └─ exit non-zero    → leave command unchanged
        │
        ▼
Pi executes command
        │
        ▼
rtk binary runs its command handler or TOML filter
```

This keeps official RTK as the source of truth. Updating the `rtk` binary updates rewrite behavior for Pi without changing this extension.

## Boundaries

Kept in this policy:

- Thin call to `rtk rewrite`.
- Pi-local Python boundary: `uv` owns `uv`, `python`, `python3`, `pip`, `pip3`, and `poetry`. Mixed top-level chains keep those segments raw and still rewrite sibling segments, for example `uv sync && bun test`.

Not kept here:

- No Pi runtime hooks; `command-policy` owns them.

- No local copy of RTK rules.
- No output compaction or sanitization.
- No `/rtk` status command.
- No runtime availability warning.
- No `user_bash` wrapper.
- No local allow/deny/suggest mode.

## Supporting all official rules

“Support official rules” means this extension delegates to the installed official `rtk` binary. It must not mirror `src/discover/rules.rs` in TypeScript.

If a command has an official TOML filter but `rtk rewrite` does not route to it, fix RTK upstream instead of patching this adapter. The check is:

```bash
cd /path/to/rtk
./target/debug/rtk rewrite 'turbo run build'
./target/debug/rtk rewrite 'nx test app'
./target/debug/rtk rewrite 'just test'
```

Exit `1` means the hook will not auto-prefix that raw command. Add or adjust an upstream `RtkRule`, then add rewrite tests in the RTK repo.

## Candidate upstream rule gaps

Built-in TOML filters observed without rewrite routing include:

- `turbo`
- `nx`
- `just`
- `task`
- `jj`
- `gradle`
- `xcodebuild`
- `oxlint`
- `basedpyright`
- `mise`

These belong in upstream RTK registry work, not in this Pi extension.

## Verification

For adapter changes:

```bash
cd agent/extensions/rtk
node --experimental-strip-types --test *.test.mjs

cd ../uv
node --experimental-strip-types --test *.test.mjs
```

For upstream RTK rule work:

```bash
cd /path/to/rtk
cargo test rewrite
./target/debug/rtk verify --require-all
```
