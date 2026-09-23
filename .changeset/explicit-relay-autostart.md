---
"@opencode-ai/browser-control": patch
---

Support `BROWSER_CONTROL_AUTOSTART=false` for externally supervised relays. Ordinary calls fail if the relay is unavailable instead of starting a detached replacement; existing relays and explicit restart commands retain their normal behavior.
