# apply_patch

Small Go implementation of the Codex patch envelope. The runtime uses only the standard library and accepts relative or absolute patch paths.

## Build

```bash
go build -o ~/.pi/agent/bin/apply_patch .
```

The workspace already places `~/.pi/agent/bin` on `PATH`.

## Usage

Pass one UTF-8 patch argument or pipe the patch on stdin:

```bash
apply_patch '*** Begin Patch
*** Update File: hello.txt
@@
-old
+new
*** End Patch'
```

```bash
apply_patch <<'PATCH'
*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch
PATCH
```

Supported operations are `Add File`, `Delete File`, `Update File`, `Move to`, `@@` context locators, multiple update chunks, and `End of File` anchors.

## Semantics

- Operations execute in patch order.
- Each update validates and computes all chunks before writing that file.
- Syntactically invalid hunks are skipped with a `skipped` report; every other
  operation is applied. When nothing remains valid the failure uses
  `PARTIAL_APPLY` with the full skip list.
- An apply failure stops at the first failing operation and reports its exact
  code with `appliedPrefix` and any `skipped` hunks; a later failure never
  rolls back an earlier successful operation.
- Add fails when the target exists. Move fails when the destination exists.
- Relative patch paths resolve from the working directory and reject `..` traversal. Absolute paths are applied directly, including paths outside the working directory.
- Update follows symlinks, including targets outside the workspace, and preserves the link. Delete removes the link itself.
- Patch input and CRLF files are converted to LF once at their input boundaries.
- Update context uses exact line matching. Whitespace and Unicode punctuation are not rewritten.
- A match failure reports the expected lines inside the error message. A
  trailing empty line that stands for the replaced region's terminating
  newline is retried without it, mirroring the Codex matcher.
- Failed apply reports list each applied change; update and move changes also
  carry `oldContent` and `newContent` so consumers can render exact diffs or
  roll back without re-reading files.
- Writes use a synced temporary file followed by rename or link.

Success uses the Codex summary format on stdout. Failure writes one JSON object to stderr:

```json
{
  "ok": false,
  "exitCode": 1,
  "error": {
    "code": "CONTEXT_NOT_FOUND",
    "message": "Failed to find expected lines in example.txt",
    "hunk": {
      "index": 0,
      "operation": "update",
      "path": "example.txt",
      "chunkIndex": 1
    }
  },
  "appliedPrefix": []
}
```

Exit codes follow the Codex CLI contract:

- `0`: patch applied
- `1`: parse, matching, or filesystem failure
- `2`: invalid CLI usage

## Verification

```bash
go test ./...
go test -race ./...
go vet ./...
```

The tests cover parse boundaries, exact matching, CRLF input, update atomicity, ordered partial failure, skip-and-continue degradation, add/move collisions, absolute and relative path handling, symlink target updates, and machine-readable failures.
