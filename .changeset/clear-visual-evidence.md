---
"@opencode-ai/browser-control": minor
---

Add the code-first screenshotDiff helper for PNG visual comparisons, changed-pixel
metrics, and highlighted diff images. Expose CDP recording quality in stop/status
receipts and JSON output, including screenshot fallback. Reject frame rates outside
the supported integer range of 1 through 60 instead of silently clamping them.
