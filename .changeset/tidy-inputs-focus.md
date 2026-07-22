---
"@opencode-ai/browser-control": patch
---

Preserve page focus while `fillInput` and `fillInputs` update controlled fields,
preventing focus-sensitive extensions from making the target unresponsive.
