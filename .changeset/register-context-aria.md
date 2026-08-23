---
"@opencode-ai/browser-control": patch
---

Register ARIA snapshot redaction selectors on each connected Playwright context so `ariaSnapshot()` works through `connectOverCDP`.
