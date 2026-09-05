---
"@opencode-ai/browser-control": patch
---

Initialize MCP without probing or starting the relay. Tool discovery, skill
retrieval, and current-session lookup remain available while the relay is down;
operational tools still ensure readiness and reject build mismatches on each call.

Remove redundant shutdown bookkeeping and network-capture copies while preserving
drain guarantees, body limits, and output redaction.
