---
"@opencode-ai/browser-control": patch
---

Clear relay tab state when a tab detaches before its root target commits, and close a race that could let two same-ID session lifecycle changes proceed together.
