---
"@opencode-ai/browser-control": patch
---

Avoid the Runtime reset wait when reconnecting a canonical CDP client to a live target with valid cached execution contexts. Replay missing contexts only to that client after its frame-tree response, preserve target and ownership validation, and retain bounded recovery for cache misses and command aliases.
