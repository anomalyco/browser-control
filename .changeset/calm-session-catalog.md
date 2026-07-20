---
"@opencode-ai/browser-control": patch
---

Persist named session identity and exact target ownership across relay process
restarts while clearly resetting process-local JavaScript state and snapshot
references. Allow handoffs to register before starting actions that may block on
native WebAuthn or payment prompts.
