# diff-engine

Rust diff engine for pi extension diff rendering (fff pattern: Rust CDylib +
C ABI + JSON round-trip + ffi-rs binding).

## Build

```bash
cargo build --release
# -> target/release/libdiff_engine.dylib (macOS)
#    target/release/libdiff_engine.so (Linux)
#    target/release/diff_engine.dll (Windows)
```

Uses the latest nightly (`rustup update nightly`).

## C ABI (include/diff_engine.h)

- `char *diff_generate_json(const char *old, const char *new, unsigned context,
  unsigned timeout_ms)` — returns a JSON string (never null; errors are encoded
  as `{"error":"..."}`). Ownership stays in the engine's ring pool; the pointer
  stays valid until the pool wraps, so bindings must consume it synchronously.
- `void diff_free_string(char *ptr)` — no-op, kept for ABI compatibility.
- `unsigned diff_engine_api_version(void)` — protocol version (1).

JSON contract (v1): `{v, rows, stats:{a,d,cl}, first?, degraded?}` with rows of
kind `c` (context), `r` (remove), `a` (add), `u` (unlocated), `f` (fold),
`x` (annotation). Highlights are `h: [[start,end],...]`.

## Architecture

- Line diff: Myers (jsdiff-compatible semantics incl. timeout degradation).
- Line pairing: interned tokens + inverted index (go-difflib b2j) + popular
  pruning (difflib autoJunk / imara-diff histogram) + weighted monotone chain
  (Fenwick tree), dense O(m*n) fallback.
- Word highlights: jsdiff `diffWordsWithSpace` token classes per pair.
- Reorder: paired rows adjacent, inserts in new order, deletes monotone.

Behavior is locked by `extensions/_shared/final-diff.test.mjs` run under
`PI_DIFF_ENGINE=js` and `PI_DIFF_ENGINE=rust`.
