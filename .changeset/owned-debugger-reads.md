---
"@opencode-ai/browser-control": patch
---

Verify extension debugger ownership before reconnect announcements and tab grouping, excluding DevTools and other extensions. Bound page.title() reads to five seconds so a missing execution context does not indefinitely hold a session execute. Bundled extension version is now 0.0.25 and requires reloading the unpacked extension.
