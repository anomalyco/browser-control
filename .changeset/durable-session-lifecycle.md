---
"@opencode-ai/browser-control": patch
---

Serialize same-session callers behind durable lifecycle commits and rollbacks so concurrent creation, ensure, reset, and deletion cannot acknowledge or replace uncommitted identities. Clean up child targets and cached frame events when a staged-only root detaches.
