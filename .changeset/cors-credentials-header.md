---
"@opencode-ai/browser-control": patch
---

Stop treating the `Access-Control-Allow-Credentials` response header as a credential
during network capture, so its `true` value no longer becomes a Secret Profile slot
or replaces `true` in execute output while a capture is active.
