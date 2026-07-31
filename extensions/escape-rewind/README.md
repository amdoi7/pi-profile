# escape-rewind

A small local Pi plugin for one narrow case.

If a user message has been sent but the assistant has not started replying yet:

1. first `Esc` aborts the turn
2. second `Esc` quickly rewinds to that just-submitted user message with **No summary**
3. Pi puts the old prompt back into the editor so it can be rewritten

Once the assistant has started replying, Pi falls back to the normal built-in interrupt behavior.

## Enablement

`agent/settings.json`

```json
{
  "extensions": [
    "./extensions/escape-rewind"
  ]
}
```

## Note

Fully restart Pi after changing this plugin. `/reload` is not enough for key-handler patches bound during interactive-mode startup.
