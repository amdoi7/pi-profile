# pi-context

Memory-owned implementation home for `/context` statistics.

## Boundary

- No root extension entrypoint lives here.
- Runtime registration happens from `extensions/memory/index.ts`.
- This directory owns the context runtime, its helpers, and its tests.

## Structure

- `src/index.ts` — wiring for commands and hooks
- `src/register-context-commands.ts` — `/context`
- `src/register-context-hooks.ts` — provider payload tracking for context analysis
- `src/context-analyzer.ts` / `src/history-analyzer.ts` — working-context and history analysis
- `src/context-renderer.ts` / `src/context-hud.ts` — overlay and HUD rendering
- `test-node/*.mjs` — focused behavior tests

## Runtime model

1. `/context` shows token and history statistics only.

## Verification

```bash
./node_modules/.bin/tsc -p tsconfig.json
node --test test-node/*.mjs
```
