---
"@opencode-ai/browser-control": patch
---

Keep handoff deadlines and exact-target cancellation active after human completion while the start action is still settling. Timeout or target loss disconnects the sandbox before execution resumes, preventing a stuck start action from hanging the execute call indefinitely.
