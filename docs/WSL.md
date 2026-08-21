# Running Browser Control in WSL (Windows Chrome → relay in WSL)

Browser Control's relay and the browser normally share one host, so the relay
binds loopback (`127.0.0.1`) and only trusts the extension it can identify by
its own install path. In WSL that assumption breaks in two independent ways,
because the **relay runs in Linux (WSL)** while **Chrome runs on Windows**:

1. **Reachability** — WSL and Windows have separate loopback stacks, so Windows
   Chrome cannot reach a relay bound to `127.0.0.1` inside WSL. Symptom in the
   extension's service-worker log:
   `WebSocket connection to 'ws://127.0.0.1:19989/extension' failed: … ERR_CONNECTION_REFUSED`.
2. **Origin trust** — an unpacked extension's id is a hash of its *load path*.
   Chrome (Windows) loads it from a Windows path; the relay (WSL) computes the
   allowed id from its own Linux path. They can never match, so the handshake is
   rejected: `… WebSocket handshake: Unexpected response code: 403`.

Two opt-in settings fix each half. Both default off, so nothing changes for
same-host users.

## Option A — keep using Windows Chrome

### 1. Make the relay reachable from Windows

Enable WSL **mirrored networking** so Windows and WSL share a loopback. In
`C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then from a Windows terminal: `wsl --shutdown` and reopen WSL.

Bind the relay to all interfaces so it is reachable through the shared loopback
(mirrored mode alone does not expose a *loopback-only* WSL service):

```bash
export BROWSER_CONTROL_HOST=0.0.0.0
```

`ERR_CONNECTION_REFUSED` should now be gone (the 403 below remains until step 2).

### 2. Allowlist the unpacked extension's origin

Find the extension's id in Windows Chrome at `chrome://extensions` (the 32‑char
string on the **Browser Control** card), then allowlist exactly that origin:

```bash
export BROWSER_CONTROL_EXTENSION_ORIGINS=chrome-extension://<your-extension-id>
```

Restart the relay (`pkill -f browser-control`, then rerun any relay-backed
command) and reload the extension. `browser-control status` should report
`extension: connected`.

`BROWSER_CONTROL_EXTENSION_ORIGINS` accepts several origins separated by commas
or whitespace; anything that is not a bare `chrome-extension://<id>` origin is
ignored, so a malformed value can never widen the check to a web origin.

Persist both in `~/.bashrc` (or your shell profile) so the auto-started relay
inherits them.

### Security note

`BROWSER_CONTROL_HOST=0.0.0.0` makes the relay reachable from your LAN, not just
Windows. It stays gated by the `Host`-header allowlist and the extension-origin
allowlist (only the ids you list, plus the Web Store build, may connect), but
prefer a specific interface address over `0.0.0.0` where you can, and only
allowlist extension ids you trust.

## Option B — run Chromium inside WSL (no configuration)

Install a Linux Chromium/Chrome inside WSL and load the same
`extension/dist` there. The browser and relay then share one host and one
filesystem, so neither setting is needed — loopback works and the extension's
path-derived id matches the relay's. The trade-off is a separate browser profile
from your Windows Chrome.
