---
title: Browser Control Plan
description: Current product direction, architecture decisions, and prioritized work for Browser Control.
---

# Browser Control Plan

Browser Control is a local driver that lets trusted agents automate the user's
already-running Chromium-family browser. It provides browser control, session
isolation, and diagnostics; it does not call models or decide what to do.

```text
Agent / MCP client / CLI
  -> relay-backed execute session
  -> local relay
  -> browser extension
  -> user's Chromium-family browser tabs
```

The end-to-end path is working. Current work should simplify the relay and make
recording robust. New features
should not weaken the code-first interface or move behavior into the extension
without a concrete browser-API reason.

## Next Priorities

Work these in order unless field evidence changes the priority. Every item
should land with unit or smoke evidence appropriate to the behavior.

### 1. Split the relay into testable responsibilities

Extract cohesive modules from `makeRelay` without changing the protocol:

- Deepen `CdpRouter` with command classification, guardrails, and compatibility
  shims.
- `ExtensionEventHandler`: extension event decoding and registry mutation.

`CdpClientPool` now owns client sockets, per-client attachment sets, aliases,
auto-attach settings, and connection generations. `CdpRouter` now owns
client-relative visibility, target inventory, target and alias resolution, and
exact root-versus-child Chrome session routing.

The goal is browser-free testing of routing and lifecycle behavior, not smaller
files for their own sake. Keep orchestration in `makeRelay` and avoid exposing
internal protocol details to the CLI or MCP server.

Verification:

- Extend reconnect, OOPIF, and multi-client smoke cases to cover root detach and
  conflicting client auto-attach settings.

### 2. Stream recordings with unambiguous framing

- Include the tab id and sequence number in each binary websocket frame instead
  of pairing a JSON metadata frame with the next binary frame.
- Stream chunks to disk instead of buffering complete recordings in relay
  memory.
- Add MCP recording start, stop, status, and cancel tools after the relay path is
  robust.
- Build the flight-recorder ring buffer only after chunk streaming lands.

Verification:

- Exercise interleaved recordings and a recording larger than the intended
  in-memory bound.
- Confirm CLI and MCP recording behavior match.

### 3. Resolve smaller agent-experience gaps

Verification:

- Add a local open-shadow-root form fixture for both fill helpers and assert the
  closed/no-match diagnostic separately.
- Add CLI parsing tests for positional, `--session`, and `-s` reset/delete forms.
- Assert reset/delete target the requested session and do not change the saved
  human-shell current session unexpectedly.

## Recently Shipped

### Fill helpers traverse open shadow roots

String selectors passed to `fillInput` and `fillInputs` now search recursively
through open shadow roots. A zero-match error explains that closed roots remain
unavailable and suggests `locator.fill()` when Playwright can resolve the field.

### Session lifecycle selectors are consistent

`session reset` and `session delete` accept positional ids, `--session`/`-s`,
and `BROWSER_CONTROL_SESSION` before falling back to the saved current session.
Smoke coverage verifies explicit missing flag and environment ids fail instead
of falling back to the saved current session.

### CDP routing fails closed

Identity-free `Target.getTargetInfo` no longer returns an arbitrary tab, and
otherwise-unhandled sessionless CDP commands require an explicit session. All
explicit target and session routing now rechecks client visibility, including
session-scoped auto-attach. Root teardown emits each announced child detach
before detaching the root so clients cannot retain orphaned sessions. The
browser-free `CdpRouter` module keeps these visibility, alias, and generation
rules out of relay transport orchestration.

### CDP client state is isolated per connection

`CdpClientPool` now owns each CDP client's session identity, target
announcements, aliases, auto-attach settings, and idle-reset generation. New
targets use the originating client's auto-attach settings instead of global
last-writer-wins state. Ownership visibility changes also invalidate target
aliases, so a client cannot continue routing commands to a tab after it becomes
hidden.

### Wedged session pages recover or fail fast

A 2026-07-09 field failure left a relay-owned page open but unusable after its
execution context was destroyed. Later calls each consumed their full timeout,
and the target remained at `chrome-error://chromewebdata/`.

Browser Control now remembers context failures and browser crash events. Before
the next normal execute, it gives the default page a one-second health check.
An unhealthy relay-owned page is closed and recreated with a stale-reference
warning; if it cannot be closed, execute fails with reset guidance instead of
leaking ownership. An unhealthy adopted user tab is never closed or replaced;
the execute fails quickly and tells the agent to reset or adopt another tab.

`Inspector.targetCrashed` and `Target.targetCrashed` events mark the target,
reject its pending debugger commands without disconnecting the extension, and
appear as `crashed=true` in status and doctor data. `chrome-error://` targets are
also unhealthy. Cross-extension navigation failures receive the bounded
`target/cross-extension-page` diagnostic.

The `execute-page-recovery` smoke crashes a relay-owned renderer, asserts prompt
failure and status visibility, then verifies that the next execute receives a
fresh page. Unit coverage verifies that adopted pages are preserved.

### Extension child targets stay subordinate

Unknown `Target.targetInfoChanged` events no longer overwrite a tab's root
target. URL-less child pages are held until their destination is known, and a
child that resolves to another extension is removed without changing the
session-owned page. This prevents password-manager UI from becoming the
session default or producing cross-extension navigation failures.

### Downloads fail with an explicit capability boundary

Chromium rejects both `Browser.setDownloadBehavior` and the legacy
`Page.setDownloadBehavior` through a tab-scoped `chrome.debugger` attachment.
Without either command, stock Playwright cannot retain the GUID-named artifact
that backs `download.saveAs()`. Browser Control therefore rejects
`page.waitForEvent("download")` immediately with the reason and a fetch-plus-`fs`
workaround rather than allowing a 30-second timeout. A local blob/fetch fixture
keeps this failure direct. Supporting native download artifacts later would
require a new extension capture protocol and permission model.

## Product Boundaries

- **Driver, not agent**: Browser Control never calls models or plans tasks.
- **User browser first**: the primary target is an already-running
  Chromium-family browser with the extension installed.
- **Trusted local execution**: `execute(code)` trusts the calling agent. It is
  not an untrusted-code security boundary.
- **Code-first control**: `execute(code)` is the primary interface. Dedicated
  tools exist only for lifecycle operations that benefit from explicit command
  semantics.
- **Playwright first**: v1 uses stock `playwright-core`. Custom behavior should
  not require a Playwright fork.
- **Local by default**: the relay binds to trusted local interfaces. Remote
  access requires an explicit authentication design before it is added.
- **Stable extension shim**: Chrome API adaptation belongs in the extension;
  orchestration belongs in the relay so most changes require only a relay
  restart.
- **Minimal extension UI**: the toolbar controls attachment, while subtle
  in-page UI communicates attached, running, and waiting states. There is no
  side panel.
- **Concise self-description**: `browser-control skill` prints one short,
  current workflow document. Do not split it into topic subcommands or require
  agents to perform a reading ceremony.

## Distribution And Installation

- The product, repository, CLI, and MCP server use the name `browser-control`.
  The npm package is `@opencode-ai/browser-control`.
- The package is published publicly on npm. Normal setup installs the npm
  artifact; source development uses `pnpm install`, `pnpm build`, and `bun
  link`.
- Until the first Store review completes, the browser extension is loaded
  unpacked from the npm package's `extension/dist` directory or a source build.
  Its current shim version is `0.0.22`.
- Extension and npm releases are independently versioned. The extension hello
  reports an explicit protocol version, and compatibility rather than exact
  package-version equality determines whether the local driver may use it.
- Browser data crosses only the loopback connection unless an authorized local
  caller sends returned data elsewhere.
- Extension source changes require rebuilding and reloading the unpacked
  extension. Relay-only changes do not.
- `pnpm package:extension` produces the deterministic Chrome Web Store review
  ZIP. Distribution starts as an unlisted beta before becoming public. A bundled
  unpacked extension belongs to future managed-browser launch flows.

## Session And Tab Model

An attached tab is a browser target exposed by the extension. An unowned
attached tab remains visible to connected clients for explicit recovery and raw
CDP workflows. A Browser Control session owns one default page and persistent
JavaScript `state`; normal execute calls use that page instead of choosing an
arbitrary tab from the attached pool.

- Bare CLI execute atomically creates a fresh readable session and prints its
  id.
- `--session` or `BROWSER_CONTROL_SESSION` explicitly continues a CLI session.
- One MCP server process owns one implicit execute session. Explicit MCP session
  management remains available for lifecycle operations.
- The CLI never infers an agent's session from human-shell current state.
- Human session-management commands store their endpoint-scoped current id in
  `~/.browser-control/session.json`.
- The relay stores private session descriptors under
  `~/.browser-control/relays/<port>/sessions.json`. Relay restart restores ids,
  read-only mode, and exact target ownership when the tab reappears; JavaScript
  `state` and snapshot refs reset with an explicit warning.
- A session owns one default page. Relay-created pages persist across
  short-lived CLI connections.
- `session adopt` makes an attached user tab the session's default page and
  closes the session's previous relay-created page.
- Adoption is exclusive: one target can belong to only one Browser Control
  session. `TargetRegistry` is the ownership authority; session state retains
  only the adopted default-page pointer.
- Adoption reserves target ownership before Playwright resolves the page, then
  commits or rolls back as one serialized transaction. A caller timeout rolls
  back visibility immediately while the worker retains the execute and adopt
  permits until any uncancellable Playwright work settles.
- Reset, delete, or detach releases an adopted tab without closing it.
- Reset and delete acquire the execute permit before closing a sandbox, so they
  cannot interrupt a running script.
- Reset and delete give an absent persisted relay target a bounded opportunity
  to re-announce. A completed protocol-v1 inventory, or expiry of the reconnect
  grace, declares that identity dead so recovery cannot require catalog edits.
  The relay never guesses a physical tab to close when the live target identity
  is unavailable.
- Corrupt session catalogs fail relay startup without being overwritten.
- The relay wins the endpoint port before loading the catalog or enabling
  catalog writes. Lifecycle responses wait for atomic file replacement, file
  sync, and directory sync before acknowledging durable state.
- Session-owned tabs share a purple `control` group within each browser window.
  Merely attached, unowned tabs stay in their existing location.
- Explicit URL selection must match exactly one page. URL and index selectors
  cannot be combined.

CDP target visibility is scoped per client. Session-owned tabs and their events
are visible only to that session's clients; unowned tabs are visible to all
clients. This prevents concurrent Playwright clients from double-initializing a
page while retaining explicit attached-tab recovery. Every ownership change
reconciles existing client announcements, browser grouping, and page status.

## Current Capabilities

### Execute

- Navigate, inspect, click, fill, wait, evaluate, and capture screenshots with
  stock Playwright APIs.
- Create tabs through `context.newPage()` and preserve session `state` across
  execute calls.
- Run inline code or `--file <path>` scripts, with conservative auto-return for
  single expressions such as `page.url()`.
- Expose selected Node built-ins: `fs`, `path`, `os`, `crypto`, `url`, `util`,
  `events`, `stream`, `buffer`, `http`, `https`, and `zlib`. `child_process` is
  not exposed by default.
- Return structured values, script and page logs, page errors, warnings,
  diagnostics, session identity, and per-call aftermath.
- Health-check a default page after execution-context failure or a crash event.
  Recreate unhealthy relay-owned pages and preserve unhealthy adopted tabs.
- Transfer returned PNG, JPEG, and WebP buffers through a dedicated media
  channel. MCP emits native image attachments without temporary files or
  duplicated base64 metadata.

### Authenticated Network Capture

- Each Execute Sandbox owns one normalized network recorder that follows its
  default or adopted page across execute calls and page recovery.
- Playwright page events capture root-frame and child-frame exchanges. HAR is
  an export adapter, not the recorder's domain model.
- Request and response bodies have per-body and aggregate byte budgets;
  truncation, failures, and dropped-entry counts remain visible in summaries.
- Written artifacts always replace credential-bearing headers, cookies, query
  parameters, and structured body fields with stable `BC_SECRET_N` references.
- Named secret profiles retain lossless values in restrictive local files.
  Cross-process locks serialize profile publication; repeated captures and
  reload-based refresh preserve references by observed request source.
- `secrets run` injects profile values into a child process and redacts known
  values from bounded stdout and stderr before returning them.
- While capture is active, values observed in completed exchanges and
  secret-shaped returned data are removed from execute results, URLs, logs,
  and journal records before they leave the sandbox.
- CLI, MCP, and execute-sandbox helpers call the same session-owned recorder.
  Capture is cancelled on session reset, deletion, and relay shutdown.

### Inspection And Interaction Helpers

- `snapshot(options?)` provides a bounded semantic read-before-act view.
- `snapshot({ diff: true })` compares against the previous compatible snapshot
  and exposes refs only for current additions or changes.
- `ref(id)` resolves controls from the latest valid snapshot and fails closed
  after navigation or incompatible DOM drift.
- `ariaSnapshot()` and raw Playwright provide deeper inspection when compact
  snapshots are insufficient.
- `screenshotWithLabels({ page, path? })` annotates likely interactive elements
  and returns label metadata.
- `fillInput` and `fillInputs` provide a DOM-evaluation fallback when browser
  extensions make native Playwright filling hang.
- Allowed Playwright mouse actions can reveal a spring-animated cursor.
  `showGhostCursor()`, `hideGhostCursor()`, and `ghostCursor.show/hide` provide
  explicit cosmetic control.

### Human Control And Safety

- The extension toolbar attaches or detaches the active tab. A toolbar click
  cannot detach a tab while its session is executing or waiting for a handoff.
- `handoff(message, { timeoutMs, start? })` binds a waiter to the exact page target,
  survives top-level navigation, and resumes only from the matching in-page
  completion control. The relay ignores ambiguous `target_closed` events from
  extension child targets, so the extension preserves the WAIT UI until the
  relay confirms a root detach or the tab is removed.
- `start` registers WAIT state before invoking a prompt-triggering action, so
  native WebAuthn or payment UI cannot block the script before handoff exists.
  It runs only after the extension acknowledges WAIT. Human completion waits
  for the action to settle; timeout or target cancellation disconnects the
  sandbox's Playwright connection before releasing the execute permit, so a
  non-settling action cannot mutate the page later.
- Destructive browser-state CDP methods such as `Browser.close` and cookie or
  cache clearing are always blocked.
- Read-only sessions additionally reject `Input.*`. They reduce trusted
  mistakes; they do not prevent mutation through `page.evaluate`.
- Safe destructive UI scripts inspect the target first, validate confirmation
  dialog text inside the approved action, and verify the result through an
  independent read path.

### Operations And Diagnostics

- Relay-backed CLI and MCP commands share one detached relay and start it when
  needed. The relay outlives the MCP process, so a CLI handoff is not coupled to
  MCP lifecycle. `status` and `doctor` remain observational; `serve` is the
  foreground debugging path.
- `doctor` reports relay and extension versions, build mismatches, sessions,
  active targets, child targets, crashed/browser-error targets, and built
  artifacts.
- `browser-control skill` prints the concise, current agent workflow.
- Each execute appends a best-effort bounded entry to
  `~/.browser-control/sessions/<id>/journal.jsonl`.
- Recording supports extension `chrome.tabCapture` WebM for user-owned tabs and
  relay-owned CDP screencasting to WebM or MP4.

## Architecture Decisions

### The relay owns orchestration

- Node-side code uses Effect v4, with
  a local `effect-smol` checkout as the API and pattern reference.
- Effect-returning functions prefer `Effect.fn` or `Effect.fnUntraced`.
- Playwright and relay resources use scoped lifecycles.
- Application configuration uses Effect `Config`; direct environment access is
  limited to synchronous Node process adapters.
- The extension remains plain TypeScript and browser-native.
- The extension protocol remains custom JSON over websocket until schema or
  versioning needs justify Effect RPC. Its shared pure validators reject
  malformed commands and envelopes without pulling Effect into the MV3 shim.
- Authenticated capture stays in the relay-backed session sandbox. The
  extension forwards the CDP traffic Playwright already needs; Node handles
  correlation, budgets, export, credential profiles, and refresh.

### One schema and one client define the relay boundary

- HTTP wire shapes live in `src/relay-schema.ts` as Effect Schemas.
- Responders and clients derive types from those schemas rather than hand-written
  JSON checks.
- CLI and MCP relay access goes through `src/relay-client.ts`; neither maintains
  an ad hoc HTTP client.
- The public Effect client uses the same typed relay client. It atomically
  ensures named sessions and exposes an origin-bound capability for structured
  JSON requests in the live default page.
- Authenticated-origin requests use page-context `window.fetch`, never exported
  cookies or Secret Profiles. They pin an exact origin, accept relative paths,
  block redirects, bound response bytes, and never retry mutations.
- Sensitive authenticated responses bypass execute journals, return as Effect
  `Redacted` values, set `Cache-Control: no-store`, and fail closed while a
  session Network Capture is active.
- The public client reveals sensitive responses through its own `reveal`
  operation so package-manager layouts with multiple Effect instances do not
  cross incompatible module-local Redacted registries.
- Boundary failures use tagged schema errors and a shared coded error envelope.
  The relay retains its message as the top-level human-readable message while
  clients can branch on stable codes for invalid requests, missing resources,
  ownership conflicts, lifecycle conflicts, and internal failures.
- Each HTTP effect is interrupted when its response closes. Execute protects
  the underlying uncancellable Playwright Promise so its session permit remains
  held until browser work actually settles.
- Corrupt current-session persistence fails visibly and remains untouched
  rather than being interpreted as an empty store.

### CDP relay invariants preserve reconnect correctness

- Store a root page target before applying `Target.setAutoAttach`; Chrome can
  emit child or OOPIF attachment events immediately.
- Forward routable dedicated workers to Playwright. Resume and suppress paused
  unsupported children, such as page-scoped service workers, so they cannot
  block parent navigation.
- Replay stored child attachments and current child-frame navigation when an
  OOPIF reconnects.
- Never announce one target id twice to the same client. Emit
  `Target.detachedFromTarget` before re-announcing it with a new session id.
- Treat a new root target/session generation for an existing physical tab as a
  replacement transaction: preserve committed ownership, roll back provisional
  adoption ownership, detach old clients and children, rebind handoffs, and
  reacquire the new Playwright page by exact target id.
- Await HTTP and websocket close callbacks during relay shutdown so tests and
  smoke runs do not leak ports or listeners.
- Relay shutdown closes the adoption gate and drains active or queued adoption
  workers before session resources. It never interrupts a worker whose
  underlying Playwright Promise may still mutate its sandbox.

### A command timeout does not imply a dead extension

A timed-out extension RPC fails only that command. The relay closes the
extension socket only when a websocket ping also fails. This prevents one
dialog-blocked tab from destroying every session's relay state.

### Execute output describes one call

Warnings and aftermath belong to the execute call that caused them. Aftermath
tracks URL movement, main-frame navigation, console and page errors, and
handoffs. The relay does not install a passive `page.on("dialog")` listener
because that would suppress Playwright's auto-dismiss behavior and can hang the
page.

### Debug traces exclude user data

With `BROWSER_CONTROL_DEBUG=1`, `[bc:ctx]` logs contain bounded target,
ownership, context-lifecycle, loader, reset, and error-shape metadata. They do
not contain expressions, arguments, results, headers, cookies, or form values.

### Builds provide runtime identity

`scripts/build-cli.ts` injects the package version and build id. Source runs use
`0.0.0-dev` and a deterministic fingerprint of `src/*.ts`, `package.json`, and
`pnpm-lock.yaml`; runtime code does not hardcode release versions. The
relay reports both values so `doctor` can identify a stale long-running relay.
It also reports an instance id, start time, and PID; bounded managed-relay
process-fault diagnostics are retained locally so unexpected same-build
restarts can be distinguished from session eviction.

## Known Limitations

- Browser Control does not expose custom `page.sessionId()`, `page.targetId()`,
  `frame.frameId()`, or `locator.selector()` APIs.
- Raw CDP behavior has no guarantees beyond stock Playwright and the relay's
  documented guardrails.
- Native `locator.fill()` can hang on login-style fields when installed browser
  extensions inject focus handlers or overlays. `fillInput` is the explicit
  fallback for ordinary `input` and `textarea` elements.
- `fillInput` cannot reach fields inside closed shadow roots.
- OOPIF behavior is guaranteed only by the current reconnect smoke scenarios.
- Clipboard automation on insecure origins is not guaranteed.
- Playwright download events and `download.saveAs()` are unavailable in
  extension-backed tabs because Chromium blocks download behavior commands from
  `chrome.debugger`; download waits return a direct capability error.
- CDP recording activates its tab to avoid background compositor throttling,
  fits the viewport within 1280x720, requires `ffmpeg` on `PATH`, and does not
  capture audio.
- The trusted sandbox exposes selected Node built-ins, not unrestricted local
  command execution.
- Exact parity across third-party authentication remains a manual diagnostic.
  Compare the same starting URL and browser profile in a fresh relay-owned tab
  and an authenticated adopted tab without automating credentials, tokens, or
  production account state.

## Backlog

These items are accepted directions but are not current priorities:

- Keep approximately the last 60 seconds of CDP frames in a flight-recorder ring
  buffer and support `recording save-last 30s` after recording streaming is
  bounded.
- Harden extension reconnect handling with `addEventListener`, one source for
  the `hello` message, and a bounded outbound event queue if lost debugger events
  continue to matter in practice.
- Add optional managed browser launch, including Brave and profile selection.
- Scope the saved human-shell current session by browser profile, in addition to
  relay endpoint, if multiple profiles become a supported workflow.
- Add stricter workspace or session ownership only if the loose shared attached
  tab pool causes concrete failures.
- Promote the reviewed Chrome Web Store extension from unlisted beta to public
  after one successful extension/relay compatibility cycle.
- Bundle an unpacked extension for managed and development browser launch.
- Add token-authenticated remote relay mode only if the relay must bind beyond
  trusted local interfaces.
- Evaluate custom CDP or a smaller Playwright-compatible client only after stock
  Playwright creates a concrete blocker.
- Add richer compact snapshot semantics only in response to demonstrated agent
  failures.
- Add broader local execution behind an explicit capability only when an agent
  workflow requires it.
- Consider a right-click `send element to Browser Control` pin if handoff
  evidence shows a recurring element-selection problem.
- Add true mid-script cancellation. Toolbar clicks currently preserve active
  executes and handoffs rather than interrupting them.

Explicitly declined for now:

- Dedicated observation commands such as `browser-control snapshot`,
  `screenshot`, or `logs`; execute-level helpers are sufficient.
- Topic-specific `skill` subcommands; the workflow should remain one concise
  document.
- A side panel.

## Historical Milestone

The first milestone proved the complete path from toolbar attachment through the
extension and relay to stock Playwright. It also proved navigation,
`context.newPage()`, reconnect, OOPIF replay, dedicated workers, concurrent
session isolation, compact snapshots, handoffs, media returns, and local fixture
checkout flows.

The current smoke matrix covers local forms, cart and checkout, reconnect and
redirect reconnect, explicit target selection, crashed- and detached-page
recovery, fill helpers with string and Locator targets, snapshot refs, handoff
navigation and cross-tab binding, OOPIF reconnect, dedicated workers, the
download capability boundary, cursor behavior, session isolation,
multi-client visibility, stale-client ordering, and raw-client checkout.
Historical milestone scope is no longer used as the active backlog; `Next
Priorities` is authoritative.
