---
title: Browser Control Plan
description: Current product direction, architecture decisions, and prioritized work for Browser Control.
---

# Browser Control Plan

Browser Control is a local driver that lets trusted agents automate the user's
already-running Chromium-family browser through a small MV3 extension shim and
a persistent local Node daemon. It provides browser control, session isolation,
inspection helpers, proof recording, and diagnostics; it never calls models or
plans tasks.

```text
Agent / MCP client / CLI
  -> relay-backed execute session
  -> local relay (Effect v4 + stock playwright-core)
  -> browser extension shim (MV3)
  -> user's Chromium-family browser tabs
```

## Product Boundaries

- **Driver, not agent**: Browser Control never calls models or plans tasks.
- **User browser first**: the primary target is an already-running
  Chromium-family browser with the extension installed.
- **Code-first control**: `execute(code)` is the primary interface. Dedicated
  commands exist only for lifecycle operations (`session`, `recording`,
  `flight-recorder`, `network`, `secrets`, `relay`, `status`, `doctor`).
- **Stock Playwright**: uses stock `playwright-core` without a custom fork.
- **Stable extension shim**: Chrome API adaptation lives in `extension/src/`;
  orchestration lives in the Node relay so most changes require only a relay
  restart.
- **Concise self-description**: `browser-control skill` prints one current
  workflow document (`skills/browser-control/SKILL.md`).

## Architecture & Core Invariants

### Relay & Runtime Lifecycle

- Node-side code uses Effect v4 (`4.0.1`), with `effect`, `@effect/platform-node`,
  and `@effect/platform-node-shared` pinned to the exact same version.
- Relay-backed CLI and MCP commands share one detached relay on `127.0.0.1:19989`
  and auto-start it when needed. `status` and `doctor` are observational and
  never auto-start the relay; `serve` is the foreground debugging entrypoint.
- Ordinary CLI, MCP, and SDK calls never replace a running relay. Replacement
  requires `browser-control relay restart` against an exact managed instance
  speaking safe shutdown protocol 2 (`RelayShutdown`), which closes admission,
  drains accepted work and persistence, and refuses raw CDP clients or active
  recordings/captures.
- Runtime candidates are built and validated outside the live checkout via
  `pnpm runtime:prepare` and activated atomically for future CLI/MCP processes
  via `pnpm runtime:select`.

### Sessions, Target Ownership & CDP Routing

- `TargetRegistry` is the sole live target-ownership authority. Session state
  retains one durable default-target identity and owner (`relay` or `user`),
  persisted per port under `~/.browser-control/relays/<port>/sessions.json`.
- `CdpClientPool` owns per-client target announcements and aliases. Session-owned
  tabs are visible only to that session's clients; unowned attached tabs are
  visible to all clients (`src/cdp-visibility.ts`).
- `CdpRouter` validates target and session visibility, browser-context routing
  (skipping crashed roots for named clients), and root-versus-child Chrome
  session routing.
- `CdpRuntime` owns register-before-send `Runtime.enable` context observation
  and bounded reset fallback.
- `RootTargetLifecycle` owns per-tab debugger setup, verification, replacement
  generations, and scoped reconciliation workers.
- `ProtectedFrameTracker` (`src/protected-frames.ts`) retracts and suppresses
  restricted child frames (such as password-manager `chrome-extension://` inline
  menus), records `protectedUi` on the root target, and surfaces
  `target/cross-extension-page` with a human-action warning instead of replacing
  the page.
- `session adopt` reserves, resolves, and commits user-tab ownership as a
  serialized transaction. When exactly one user-attached tab is open,
  `session adopt` auto-selects it without requiring `--target-url` or
  `--target-index`. Adopted user tabs are never closed by `reset` or `delete`.

### Execute Sandbox & Page Recovery

- Each session owns one persistent `ExecuteSandbox` with `page`, `context`,
  `browser`, `state`, and selected Node built-ins (`fs`, `path`, `os`, `crypto`,
  `url`, `util`, `events`, `stream`, `buffer`, `http`, `https`, `zlib`).
- `page.title()` and `page.content()` carry a 5-second read watchdog
  (`src/page-read-timeout.ts`) so missing execution contexts fail with a
  `session-page/context-read-timeout` diagnostic instead of hanging for 30s.
- `page.setViewportSize()` checks actual `window.innerWidth/innerHeight` after
  resizing and warns when non-100% browser zoom scales the CSS viewport.
- `page.emulateMedia({ colorScheme: "light" })` marks explicit light-mode
  emulation (`__bc_explicit__`) so the relay preserves it across navigations
  while still stripping Playwright's unrequested default light-mode override on
  attach.
- When a session page is closed externally and replaced with `about:blank`,
  untouched `about:blank` locator timeouts fail in `2.5s` (instead of `30s`)
  with a warning naming the previous closed URL until `page.goto()` or
  `page.setContent()` is called.

### Inspection, Handoffs & Proof Recording

- `snapshot(options?)` returns a bounded semantic tree with stable same-document
  `ref("eN")` handles, `diff`/`delta` modes, and `find` search. It traverses
  open Shadow DOM roots, `<slot>` assigned nodes, and `display: contents`
  wrappers, strips React SSR comment boundaries when computing accessible names,
  and retries once on transient mid-capture navigation.
- `screenshotWithLabels()` renders visual `e1..eN` badges and registers those
  refs in the session's `SnapshotRefRegistry` so `ref("e1")` works immediately.
- `handoff(message, { timeoutMs?, start? })` and `demonstrate()` bind to the
  exact page target and wait for human completion via the in-page control.
- Allowed Playwright mouse actions reveal the on-page Ghost Cursor (`src/ghost-cursor.ts`),
  defaulting to `distance-glide` motion (straight on short hops `< 50px`, curved
  Bezier wrist-arc with bounded bank on longer sweeps, returning to `0°` before
  contact) and `tactile-bloom` SVG variable-stroke click shockwaves.
- Proof overlays (`ghostCursor.caption`, `ghostCursor.callout`,
  `ghostCursor.spotlight`, `ghostCursor.zoom`, `ghostCursor.resetZoom`, and
  `ghostCursor.keys`) and the native Rust 60fps Steadicam compositor
  (`crates/bc-studio`) support high-craft proof recordings with $C^3$-continuous
  camera motion and per-pixel line-integral motion blur.

### Network Capture, Secret Profiles & Authenticated Origins

- `NetworkCapture` records normalized exchanges with bounded body retention and
  exports HAR artifacts using route-scoped `BC_SECRET_N` references.
- `SecretProfile` stores lossless values in mode-`0600` local files and injects
  them into child workers via `secrets run`, redacting known values (>= 4 chars
  or non-boolean/non-digit tokens) from stdout/stderr.
- `BrowserControlClient` provides schema-decoded, origin-pinned `window.fetch`
  requests inside the session's live page, with `Redacted` support for sensitive
  responses.

## Next Priorities

1. **Automated Steadicam Post-Processing Integration**: Wire `crates/bc-studio`
   directly into an optional `browser-control recording studio` / `--studio`
   workflow so agents can produce 2x Retina Steadicam proof videos in one command.
2. **Chrome Web Store Publication**: Complete review of the unlisted MV3 shim
   (`0.0.25`, protocol `2`) before public Store listing.
3. **Simultaneous Multi-Profile Support (`PR #72`)**: Rebase and land pinned
   per-profile session isolation when simultaneous multi-profile workflows are
   needed.
