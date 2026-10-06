# @opencode-ai/browser-control

## 0.8.4

### Patch Changes

- 6acc64f: - Add biomechanical pointer, scroll, and keyboard pacing (`src/human-input.ts`, `src/human-model.ts`) synchronized with `GhostCursor` (`src/ghost-cursor.ts`), plus empirical model fitting from the Cloudflare motor calibration obstacle course.
  - Serialize per-tab `Input.*` and `DOM.scrollIntoViewIfNeeded` transactions with target freshness checks, and clear root `protectedUi` when restricted child frames navigate back to ordinary documents.
  - Acknowledge `Page.screencastFrame` immediately inside the extension service worker and preserve unscaled backing surfaces so `ffmpeg` crops emulated `setViewportSize` regions without black compositor padding.
  - Keep Browser Control tab groups expanded, format auto-generated session IDs as `🤖 <site/title>`, preserve attached tabs across `POST /extension/reload`, and reap abandoned relay-owned tabs after the idle TTL.
  - Promote sibling tab bars, top-level `<nav>` fallback headers, and clickable `<tr>` cell summaries in `snapshot()` while preserving `mainRoot` when Radix/Floating UI portals are open.
- 86fb059: - Preserve `about:blank` and newly navigated documents during session-page recovery, and clear crash evidence on target replacement and main-frame navigation.
  - Use `NodeHttpClient.layerNodeHttp` in `RelayClient` and disable `httpServer.requestTimeout` so long `handoff()` and `secrets run` requests do not fail after five minutes with `HeadersTimeoutError`.
  - Guard `snapshot()` when `document.body` is absent during early navigation, traverse open Shadow DOM controls, include `<input type="button|submit|reset">` values in accessible names, and prefer visible button text and native `<label>` text over `title` attributes so snapshot refs match Playwright `getByRole`.
  - Allow `session adopt` and MCP `session_adopt` to omit `--target-url`/`--target-index` when adopting a single user-attached tab, register `screenshotWithLabels()` refs for `ref(id)`, bound `page.content()` with the 5-second read watchdog, and surface pointer-interception blocker warnings.
  - Wait a full 30-second MV3 alarm period plus margin (`35s`) for a sleeping extension worker to reconnect, explain Node-side `window`/relative `fetch` errors in `execute`, include the file-system reason in `execute --file` errors, and stage `pnpm build:extension` outputs atomically.

## 0.8.3

### Patch Changes

- 34726b9: Keep handoff deadlines and exact-target cancellation active after human completion while the start action is still settling. Timeout or target loss disconnects the sandbox before execution resumes, preventing a stuck start action from hanging the execute call indefinitely.
- 124da97: Avoid the Runtime reset wait when reconnecting a canonical CDP client to a live target with valid cached execution contexts. Replay missing contexts only to that client after its frame-tree response, preserve target and ownership validation, and retain bounded recovery for cache misses and command aliases.
- 34726b9: Name bounded page.title() failures with a session-page/context-read-timeout diagnostic and the operation's timeout budget. The diagnostic reports an unavailable or busy execution-context read without claiming renderer failure or activating page recovery. Ordinary locator timeouts remain unclassified, and protected extension UI retains its more specific diagnosis.
- 7393e6b: Serialize same-session callers behind durable lifecycle commits and rollbacks so concurrent creation, ensure, reset, and deletion cannot acknowledge or replace uncommitted identities. Clean up child targets and cached frame events when a staged-only root detaches.
- da7c8d2: Support `BROWSER_CONTROL_AUTOSTART=false` for externally supervised relays. Ordinary calls fail if the relay is unavailable instead of starting a detached replacement; existing relays and explicit restart commands retain their normal behavior.
- f5ae66a: Update to Effect 4.0.0-rc.118 and Playwright 1.63. MCP tool failures now follow the updated Effect MCP server behavior: an `isError` tool result on protocol 2025-11-25, and JSON-RPC `-32603` rather than `-32602` on older protocols.
- 34726b9: Adopt attached user tabs by exact target identity without waiting for a responsive renderer. Resolve Playwright pages lazily with a bounded native connection timeout, preserve adopted targets after setup failure, and report when user code did not run.
- c2ea370: Keep rotated credentials in transient redaction memory so execute output and captured JSON echoes remain protected while auth profiles retain only current values. Protect OAuth credential fragment parameters in absolute and relative redirect URLs while preserving public fragment text.
- 34726b9: Invalidate compact snapshot diff baselines on main-frame navigation and keep old reference IDs retired after a new capture. Correct native roles for multi-select and sized selects, range and file inputs, and datalist-backed text controls so their snapshot references resolve through Playwright.
- 4463bbe: Clear relay tab state when a tab detaches before its root target commits, and close a race that could let two same-ID session lifecycle changes proceed together.

## 0.8.2

### Patch Changes

- 9a5ab7b: Name the password-manager permission boundary instead of treating it as a broken page. Focusing or filling a card or credential field lets an extension such as 1Password inject a `chrome-extension://` inline-menu iframe into the webpage; Chrome then rejects every debugger command for that tab, which Playwright surfaced as an empty-URL phantom frame under the main frame, "Execution context was destroyed", and 30 s locator timeouts, and which the 0.8.1 health check went on to treat as an unresponsive page. The relay now tracks such protected frames: it retracts the forwarded attach with a synthetic `Page.frameDetached`, suppresses the frame's later events, and records the debugger block as `protectedUi` on the root target (shown as `protected-ui=true` in `status` and `doctor`) until a command succeeds again or the frame is removed. While the tab is blocked, execute reports masked destroyed-context and locator-timeout failures as `target/cross-extension-page` with the existing human-action warning and skips the page health check, so the tab is never repaired or replaced for a prompt the user has to dismiss.

## 0.8.1

### Patch Changes

- 8bb33c8: Keep a relay-owned session page whose execution context stops answering automation instead of closing it and replacing it with `about:blank`. Only crashed, `about:blank`, or `chrome-error://` relay-owned pages are recreated; any other live page is re-resolved over a fresh relay connection once and then reported with a `session-page/*-unresponsive` diagnosis that names the kept tab. A resolved handoff whose destination context never appears now explains that the user finished and only Browser Control's view is stale. `session adopt --session <id>` creates the named session when it does not exist, and an ambiguous `--target-url` lists the matching pages.

## 0.8.0

### Minor Changes

- b1410ca: Add snapshot search and automatic deltas with persistent compatible refs, contenteditable filling, WebMCP page tools, human demonstration code generation, MCP recording controls, and a rolling flight recorder. Fix Windows relay startup and session persistence on filesystems that reject directory fsync, and validate browser-context CDP routing by healthy Chromium context identity.

### Patch Changes

- b1410ca: Correct compact snapshot refs for native number/search inputs and disclosure controls, include portal dialogs in the default scope, and bound reserved list wrappers so dense result pages retain actionable links.

## 0.7.1

### Patch Changes

- 1cdd1e4: Include visible image alt text in compact snapshot labels and clarify that explicit execute target selection is per-call. Keep Effect and its shared Node adapter aligned in standalone runtime installations so clean npm installs can start successfully.
- 6785d65: Initialize MCP without probing or starting the relay. Tool discovery, skill
  retrieval, and current-session lookup remain available while the relay is down;
  operational tools still ensure readiness and reject build mismatches on each call.
  
  Remove redundant shutdown bookkeeping and network-capture copies while preserving
  drain guarantees, body limits, and output redaction.
- 1cdd1e4: Verify extension debugger ownership before reconnect announcements and tab grouping, excluding DevTools and other extensions. Bound page.title() reads to five seconds so a missing execution context does not indefinitely hold a session execute. Bundled extension version is now 0.0.25 and requires reloading the unpacked extension.

## 0.7.0

### Minor Changes

- a2e5bc9: Add the code-first screenshotDiff helper for PNG visual comparisons, changed-pixel
  metrics, and highlighted diff images. Expose CDP recording quality in stop/status
  receipts and JSON output, including screenshot fallback. Reject frame rates outside
  the supported integer range of 1 through 60 instead of silently clamping them.

### Patch Changes

- a2e5bc9: Fix undersized, padded CDP recordings with emulated viewports and Retina backing
  surfaces. Preserve the starting viewport instead of downscaling to 720p, improve
  source image quality, and default to 60 fps with a 60 fps ceiling. Frame delivery
  still depends on the browser; use a lower frame rate for smaller recordings.

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
