# apply_patch

Small Go implementation of the Codex patch envelope. The runtime uses only the standard library and accepts workspace-relative patch paths.

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
- A later failed operation does not roll back an earlier successful operation; failures report `appliedPrefix`.
- Add fails when the target exists. Move fails when the destination exists.
- Patch paths remain lexical workspace-relative paths: absolute paths and `..` traversal are rejected.
- Update follows symlinks, including targets outside the workspace, and preserves the link. Delete removes the link itself.
- Patch input and CRLF files are converted to LF once at their input boundaries.
- Update context uses exact line matching. Whitespace and Unicode punctuation are not rewritten.
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

The tests cover parse boundaries, exact matching, CRLF input, update atomicity, ordered partial failure, add/move collisions, lexical workspace traversal, symlink target updates, and machine-readable failures.
