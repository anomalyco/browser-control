---
"@opencode-ai/browser-control": patch
---

Keep Runtime enable recovery tied to the original target generation and client
visibility instead of resetting a successor target after a delayed response.
Verify handoff readiness against the selected page, not an unrelated default page.
