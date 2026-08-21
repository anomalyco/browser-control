---
"@opencode-ai/browser-control": minor
---

Support driving a browser on another host (e.g. Chrome on Windows → relay in
WSL). Two opt-in settings, both defaulting to today's behavior:

- `BROWSER_CONTROL_HOST` sets the relay bind host (default `127.0.0.1`); set it
  to `0.0.0.0` so a browser off-host can reach the relay.
- `BROWSER_CONTROL_EXTENSION_ORIGINS` allowlists extra `chrome-extension://<id>`
  origins for the extension WebSocket (comma- or whitespace-separated), so an
  unpacked extension whose path-derived id cannot match the relay's own bundled
  path can still connect without patching `node_modules`.

Adds `docs/WSL.md`. Provides a supported workaround for the cross-host 403 in
#40 / #41 / #43.
