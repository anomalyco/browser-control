---
"@opencode-ai/browser-control": patch
---

Clear a recovered page's stale crash status on main-frame navigation, preventing a later transient context failure from closing it. Add bounded exhaustive recovery checks covering event order, ownership, health outcomes, unrelated tabs, and listener cleanup.
