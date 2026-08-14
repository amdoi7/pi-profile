# apply_patch Authoring Guide

How to write patches that apply cleanly. Follow these rules when generating
`apply_patch` envelopes; most apply failures are preventable authoring issues.

## Envelope Shape

```
*** Begin Patch
*** Add File: path/to/new.txt
+line one
+line two
*** Update File: path/to/old.ts
@@
-removed line
+replaced line
  unchanged context line
*** Delete File: path/to/dead.ts
*** End Patch
```

- Every operation needs its header: `*** Add File:`, `*** Delete File:`, or
  `*** Update File:`.
- Control lines (`*** Begin Patch`, operation headers, `@@`, `*** End Patch`)
  may carry leading whitespace (e.g. a heredoc body indented as a block); the
  leading whitespace is ignored. A uniform indent across the whole body
  (every line shifted by the same prefix, including content lines) is also
  supported: the indent is inferred from the control lines and stripped from
  every line before parsing.
- Add lines always start with `+`; delete lines with `-`; context lines with a
  single space. Content lines are matched verbatim — leading whitespace on a
  content line is part of the line text.
- Each `@@` chunk must contain at least one `+` or `-` line. A context-only
  chunk is invalid and is skipped by the engine.
- Reference paths relative to the working directory when possible. Absolute
  paths are supported but relative ones survive project moves.
- Prefer exact line text; whitespace and punctuation are matched verbatim.

## Context Rules

- Default to 3 lines of context above and 3 below each change. Enough context
  to identify the location, not a transcript of the file.
- When a change sits within 3 lines of a previous change, do not repeat the
  first change's post-context lines in the second change's pre-context lines.
  Merge them into one chunk instead.
- If context alone is ambiguous, anchor with `@@` headers:

```
*** Update File: src/app.ts
@@ class UserService
@@   private async findUser(
-  const user = await db.get(id);
+  const user = await db.find(id);
```

- Multiple `@@` headers jump the matcher through the file in order. Chunks must
  appear in file order; the matcher never searches backwards.

## End Of File

- A chunk that touches the last line of a file can use `*** End of File` after
  its lines to anchor at the tail:

```
*** Update File: src/app.ts
@@
-  return oldBehavior();
+  return newBehavior();
*** End of File
```

- The engine tolerates a trailing empty line that stands for the replaced
  region's terminating newline, but writing chunks without it matches more
  reliably.

## When A Patch Fails

- The error message includes the exact expected lines
  (`Failed to find expected lines in <path>: <lines>`). Read the file and fix
  the context rather than re-issuing the same patch.
- Syntactically invalid hunks are skipped with `skipped:` report lines; the
  rest of the patch still applies. Treat `PARTIAL_APPLY` as an error: collect
  the report, fix the skipped hunks, and re-apply.
- An apply failure (missing file, context mismatch, existing target) stops at
  the first failing operation and lists the applied prefix as `applied:`
  lines; do not assume later operations ran.
