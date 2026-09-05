# @opencode-ai/browser-control

## 0.6.0

### Minor Changes

- bb6b3d2: Require explicit `browser-control relay restart` for managed relay replacement.
  Ordinary clients still start an absent relay, but never upgrade one behind other
  clients. Safe shutdown protocol 2 attributes restart requests and drains accepted
  work without cancelling its browser transport; legacy relays require a coordinated
  manual stop once. Add isolated candidate preparation and installation selection.
  
  Preserve nested staged targets during root replacement and report catalog sync
  failures instead of treating readable bytes as proof of durability.

### Patch Changes

- 26dd2d5: Pin the shared Node platform to the same Effect prerelease as the CLI runtime,
  preventing incompatible scope layouts in fresh standalone installations. Validate
  the packed dependency cohort, CLI, and SDK in an isolated pnpm consumer before
  accepting a runtime candidate or publishing through the release workflow.
- 6bda258: Preserve the active browser connection when another browser or profile connects, with contention diagnostics and bounded liveness recovery. Keep pages intact when Chromium blocks protected password-manager extension UI and explain the required user action.
  
  Restore opt-in defaults for CLI boolean flags so commands work without explicitly passing `--json`, `--read-only`, or `--audio`.
- bb6b3d2: Upgrade Effect and its Node platform to 4.0.0-rc.112 while preserving explicit CLI boolean defaults and the existing MCP protocol adapters. Obsolete 2024-10-07 MCP offers negotiate 2025-06-18.
- 9c5b377: Skip crashed session-owned roots when routing named browser-context commands,
  without changing raw-client ambiguity or explicit target visibility and routing.
  Preserve exhausted root-probe errors and reject malformed target information for
  committed roots as well as staged roots. Failed inventory readiness closes the
  extension connection and clears live target state rather than reporting success.
- bb6b3d2: Keep CDP attachment and alias cleanup consistent across target replacement,
  detachment, and ownership changes. Ignore target updates from retired session
  sandboxes so reset or recreated sessions retain their own persisted identity.
- bb6b3d2: Keep Runtime enable recovery tied to the original target generation and client
  visibility instead of resetting a successor target after a delayed response.
  Verify handoff readiness against the selected page, not an unrelated default page.

## 0.5.1

### Patch Changes

- 73beb8a: Simplify session, target, recording, and extension lifecycles while avoiding duplicate network-capture settlement and stale finalizer waiters.

## 0.5.0

### Minor Changes

- b26536f: Update Playwright, WebSocket, parser, package-manager, build, test, and TypeScript dependencies to their current compatible releases. Align the documented Node.js requirement with the Node 22.19 minimum required by the current Effect Platform runtime.

### Patch Changes

- 6994459: Wait through transient extension reconnects when constructing the TypeScript client and report sessions connected only when they have a live default page.
- 3146cdc: Wait for the destination page execution context before returning from a navigation-triggering human handoff.
- 5271076: Expose safe Secret Profile status and profile-worker execution through the TypeScript SDK.
- 2d05bbc: Automatically replace a stale detached relay that supports guarded shutdown with the current CLI build before running operational commands, while older and foreground relays continue to fail closed with restart guidance.
- 2de472a: Make session deletion idempotent when the requested session is already absent.
- 83904e5: Wake the extension service worker and reconnect to the relay after a full browser restart.

## 0.4.1

### Patch Changes

- 7874e37: Update Effect and the Node platform package from `4.0.0-beta.97` to `4.0.0-rc.111`, including current tagged errors and explicit MCP protocol adapters.
- 8d6897d: Keep the unauthenticated HTTP and CDP relay bound to loopback while allowing explicitly configured extension origins for same-host unpacked installs.
- f625957: Register ARIA snapshot redaction selectors on each connected Playwright context so `ariaSnapshot()` works through `connectOverCDP`.
- ba7f5b5: Keep extension readiness independent from browser tab-group APIs that can remain pending indefinitely in Arc, and give unpacked builds a stable extension id with platform-correct migration support for existing Windows installs.
- f12441c: Route Playwright browser-context permission and cookie commands through the correct session-owned tab.
- 045805c: Omit text-control values from detailed ARIA snapshots so sensitive form contents do not enter agent output.
- 4761e61: Harden `ariaSnapshot()` redaction for custom ARIA value controls, rich editable content, concurrent callers, and frame lifecycle changes.

## 0.4.0

### Minor Changes

- 05b068d: Stream tab-capture recordings to disk with intrinsically framed, sequenced binary messages instead of buffering complete recordings in relay memory.

### Patch Changes

- 05b068d: Isolate CDP client state so concurrent clients retain their own auto-attach
  settings, invalidate target aliases when ownership hides a tab, reject hidden
  session routing, avoid arbitrary target fallback, and detach child targets when
  their root disappears. Centralize target and alias routing so stale root and
  child sessions fail closed.
- 05b068d: Accept `--session`, `-s`, and `BROWSER_CONTROL_SESSION` for session reset and
  delete while retaining positional and current-session selection.
- 05b068d: Prepare an unlisted Chrome Web Store extension with protocol-based relay
  compatibility, deterministic packaging, and more reliable cold-start target
  creation. Session reset and delete now recover relay-owned targets whose
  debugger attachment was permanently lost during an extension update.
- d0285d9: Allow release builds to connect to the exact unpacked extension bundled with
  the installed package while continuing to reject arbitrary extension origins.
- 05b068d: Search recursively through open shadow roots in `fillInput` and `fillInputs`,
  and report the closed-root boundary when a selector has no match.
- fcacf49: Prevent snapshot refs from timing out when a page's accessible name differs slightly from Browser Control's compact display name.
- 05b068d: Preserve page focus while `fillInput` and `fillInputs` update controlled fields,
  preventing focus-sensitive extensions from making the target unresponsive.
- 05b068d: Keep the Chrome extension connected across idle service-worker suspension, repair missing reconnect alarms whenever the worker starts, start the managed relay correctly when MCP runs through a package-manager bin symlink, and make Doctor compare the runtime extension with the manifest shipped in the npm package.

## 0.3.2

### Patch Changes

- 4699f7d: Pin production WebSocket access to the assigned Chrome Web Store extension ID
  while retaining an explicit source-development path for unpacked extensions.

## 0.3.1

### Patch Changes

- abfcabb: Prepare an unlisted Chrome Web Store extension with protocol-based relay
  compatibility, deterministic packaging, and more reliable cold-start target
  creation. Session reset and delete now recover relay-owned targets whose
  debugger attachment was permanently lost during an extension update.

## 0.3.0

### Minor Changes

- 7aee5fd: Add a public Effect client with atomic named sessions and schema-decoded, same-origin JSON requests authenticated by the live browser page. Sensitive responses are returned as `Redacted` values and bypass execute journals and active network captures.

### Patch Changes

- 7aee5fd: Add `BrowserControlClient.reveal` for consuming sensitive authenticated responses across package-manager layouts with separate Effect runtime instances, plus `resetSession` for recovering disconnected named sessions without invoking the CLI.
- 7aee5fd: Reorganize the Browser Control agent skill around an inspect-act-verify golden
  path, explicit completion criteria, and concise optional workflows.
- 4427f40: Allow cold managed relays up to ten seconds to restore persisted sessions and
  become ready before reporting startup failure.

## 0.2.0

### Minor Changes

- 8ffa89c: Add session-scoped authenticated network capture, credential-redacted HAR
  exports, stable reusable secret profiles, credential refresh, and redacted
  command execution across CLI, MCP, and the execute sandbox.

### Patch Changes

- 3ba9951: Persist named session identity and exact target ownership across relay process
  restarts while clearly resetting process-local JavaScript state and snapshot
  references. Allow handoffs to register before starting actions that may block on
  native WebAuthn or payment prompts.
- edf33c2: Reject stale relays before operational CLI and MCP calls, preserve sessions
  across same-tab target and execution-context replacement, retain bounded relay
  fault diagnostics, and safely escape snapshot attribute selectors.

## 0.1.3

### Patch Changes

- 3729b6c: Rewrite the README around npm installation, agent skill and MCP setup, first-run workflows, and safety boundaries.

## 0.1.2

### Patch Changes

- 161e420: Keep snapshot references stable across safe rerenders when a control has a unique class and accessible identity.
