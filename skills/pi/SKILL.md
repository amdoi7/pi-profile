---
name: pi
description: >-
  The pi harness itself. Use when working on or answering questions about pi:
  extensions, custom tools, skills, prompt templates, themes, TUI components,
  keybindings, SDK/RPC integration, custom providers, models, packages,
  environment variables, sessions, compaction, or settings.
---

# Pi Harness Documentation

Local install is authoritative for the running version:

- Main documentation: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)
- If these paths are missing, resolve the install root with `npm root -g` and look under `@earendil-works/pi-coding-agent`.
- Upstream source (for issues/PRs, not for running-version truth): https://github.com/earendil-works/pi

## Resolution Rules

- Resolve `docs/...` under Additional docs and `examples/...` under Examples, never under the current working directory.
- Read pi .md files completely and follow .md cross-references before implementing (e.g., extensions.md → tui.md for TUI API details).

## Topic Map

- Extensions, custom tools: docs/extensions.md, examples/extensions/
- Themes: docs/themes.md
- Skills: docs/skills.md
- Prompt templates: docs/prompt-templates.md
- TUI components: docs/tui.md
- Keybindings: docs/keybindings.md
- SDK integration: docs/sdk.md, examples/sdk/
- RPC mode: docs/rpc.md
- Custom providers: docs/custom-provider.md
- Adding models: docs/models.md
- Pi packages: docs/packages.md
- Environment variables: docs/environment-variables.md
- Settings: docs/settings.md
- Sessions/compaction: docs/sessions.md, docs/session-format.md, docs/compaction.md
