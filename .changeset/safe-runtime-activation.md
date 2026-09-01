---
"@opencode-ai/browser-control": minor
---

Require explicit `browser-control relay restart` for managed relay replacement.
Ordinary clients still start an absent relay, but never upgrade one behind other
clients. Safe shutdown protocol 2 attributes restart requests and drains accepted
work without cancelling its browser transport; legacy relays require a coordinated
manual stop once. Add isolated candidate preparation and installation selection.

Preserve nested staged targets during root replacement and report catalog sync
failures instead of treating readable bytes as proof of durability.
