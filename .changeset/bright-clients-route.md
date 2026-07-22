---
"@opencode-ai/browser-control": patch
---

Isolate CDP client state so concurrent clients retain their own auto-attach
settings, invalidate target aliases when ownership hides a tab, reject hidden
session routing, avoid arbitrary target fallback, and detach child targets when
their root disappears. Centralize target and alias routing so stale root and
child sessions fail closed.
