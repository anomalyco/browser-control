---
"@opencode-ai/browser-control": patch
---

Skip crashed session-owned roots when routing named browser-context commands,
without changing raw-client ambiguity or explicit target visibility and routing.
Preserve exhausted root-probe errors and reject malformed target information for
committed roots as well as staged roots. Failed inventory readiness closes the
extension connection and clears live target state rather than reporting success.
