---
"@opencode-ai/browser-control": patch
---

Preserve per-tab native input order when cursor rendering is slow, and reject
queued input after its target changes. Clear stale protected-UI status when the
last restricted frame returns to an ordinary document.
