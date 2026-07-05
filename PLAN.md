---
title: Browser Control Plan
description: Provisional product and architecture plan for browser-control v1.
prompt: |
  Create a planning folder for a standalone browser-control project. Capture
  the decisions from a design discussion where the product is a trusted driver
  for agents to control the user's already-running Chromium-family browser via
  a Chrome extension, loose attached-tab semantics, code-first execution,
  persistent sandboxes, stock Playwright for v1, and no built-in LLM agent.
---

# Browser Control Plan

## Product Shape

Browser Control is a standalone local driver for trusted agents to control the
user's visible browser. It is not an LLM agent and does not choose actions on
its own.

```text
Agent / MCP client / CLI
  -> browser-control execute sandbox
  -> local bridge
  -> browser extension
  -> user's Chromium-family browser tabs
```

## Settled Decisions

- **Driver, not agent**: Browser Control does not call models or plan tasks.
- **User browser first**: v1 targets an already-running Chromium-family browser
  with the extension installed.
- **Loose tab model**: any attached tab is visible and controllable to connected
  agents.
- **User detach**: users can release a tab from agent control without closing it.
- **Code-first control**: the primary capability is `execute(code)`, not many
  small action tools.
- **Skill self-description**: the CLI exposes `browser-control skill` so another
  agent can print the current Browser Control workflow instructions.
- **Concise skill, no reading ceremony**: keep the skill one document that is
  short, clear, and correct instead of splitting it into topic subcommands or
  demanding "read every line" rituals. If the skill needs a warning about
  truncated reading, the skill is too long.
- **Persistent sandbox**: CLI and MCP execute calls run through relay-backed
  Browser Control sessions with long-lived JavaScript `state`.
- **MCP semantics**: one MCP server process owns one implicit execute sandbox.
- **CLI semantics**: bare execute atomically creates one fresh readable session
  and returns its id; later calls continue it only through `--session` or
  `BROWSER_CONTROL_SESSION`. The CLI never guesses agent identity from shared
  ambient current-session state.
- **Playwright v1**: v1 uses stock `playwright-core`; it does not clone
  Playwright.
- **Effect v4**: the Node-side CLI, relay, and later MCP code should use
  `effect-smol` / Effect v4 patterns, with
  `/Users/kit/code/open-source/effect-smol` as the local source of truth for
  APIs and examples.
- **Trusted execution**: `execute(code)` is a trusted local automation
  capability, not a secure untrusted-code boundary.
- **Trusted local sandbox**: v1 exposes browser objects plus selected Node
  built-ins; the sandbox trusts the agent, not arbitrary web code.
- **Minimal extension UI**: v1 uses the extension toolbar action for
  attach/detach plus a subtle in-page status and handoff control. It does not
  include a side panel.
- **Single presence surface**: the subtle in-page status is the persistent
  indicator that Browser Control is attached; it does not claim tabs with
  browser tab groups.
- **Best-effort stock CDP only**: v1 does not add custom raw-CDP helpers; agents
  may use whatever stock `playwright-core` exposes.
- **Name**: use `browser-control` for the product, repository, CLI command, and
  MCP server name. Publish as `@anomalyco/browser-control` unless the unscoped
  npm name becomes available.
- **Source install until publication**: while the package is private, setup uses
  a source checkout, `pnpm build`, and a global link. Switch the documented flow
  to npm when the package is actually published.
- **Extension distribution**: v1 uses an unpacked extension. Later releases can
  add Chrome Web Store distribution for user browsers and a bundled unpacked
  extension for managed/dev browser modes.
- **Stable extension shim**: keep extension code as a small Chrome API bridge so
  most behavior can be changed by restarting the Node relay, not by repeatedly
  reloading the extension in Brave.
- **Protocol shape**: v1 uses a small custom JSON-over-websocket protocol between
  relay and extension. Node-side orchestration uses Effect, but the browser shim
  does not use Effect RPC for now.
- **Persistent relay-created tabs**: tabs created by Playwright/CDP clients stay
  attached after short-lived CLI commands disconnect, so repeated shell commands
  reuse the same visible browser state. Users can close tabs, call `page.close()`,
  or detach with the toolbar.
- **Automatic CLI relay startup**: relay-backed CLI commands start a detached
  relay when none is reachable and wait briefly for the extension to reconnect.
  `status` and `doctor` remain observational; `serve` is the explicit foreground
  debugging path. Existing relay build mismatches are reported, never silent.
- **Explicit target selection**: when multiple tabs are attached, CLI execute can
  select by URL substring or zero-based page index for manual recovery. Normal
  execute calls use the session-owned default page instead of guessing from the
  shared attached-tab pool. URL selection must match exactly one page, and
  URL/index selectors cannot be combined.
- **Exclusive adoption**: one attached target can be the sticky default of only
  one Browser Control session at a time; detach, reset, and delete release it.
- **Shared wire contract**: the relay HTTP API shapes (sessions, execute
  responses, targets, extension status, recording responses) are defined once in
  `src/relay-schema.ts` with Effect Schema, and both server responders and
  clients derive their types from those schemas. No hand-rolled `typeof`
  parsers for relay JSON.
- **One relay client**: the CLI and the MCP server share `src/relay-client.ts`,
  a `Context.Service` over Effect `HttpClient`, instead of maintaining separate
  fetch/node:http clients and duplicated response parsers.
- **Tagged errors at boundaries**: relay-client and session-store failures are
  `Schema.TaggedErrorClass` values with the human-readable relay message kept as
  the top-level error message, so agents see the real failure instead of a
  generic `post /cli/execute` wrapper.
- **Command timeout is not connection failure**: a timed-out extension RPC fails
  only that command. The extension socket is closed only when a websocket-level
  ping probe also fails, so one dialog-blocked tab cannot wipe every session's
  relay state.
- **Session close is serialized with execute**: session delete/reset acquire the
  session's execute permit before closing the sandbox, so a running script is
  never yanked mid-flight.
- **Human-shell current session**: `~/.browser-control/session.json` stores the
  session selected by management commands per relay endpoint. Agent execute and
  adopt calls never consume or update this ambient selection.
- **Build-time version**: the CLI/MCP/relay report the package version injected
  by esbuild at build time (`0.0.0-dev` when running from source); no hardcoded
  version literals.
- **Unit tests for pure logic**: vitest covers the wire schemas, relay-client
  error mapping, auto-return analysis, host-header validation, session store,
  and the session delete/execute race. Browser-dependent behavior stays in
  `pnpm smoke`.

## V1 Capability Target

The initial automation surface should cover normal Playwright-compatible work:

```ts
await page.goto("https://example.com")
await page.getByRole("button", { name: "Submit" }).click()
await page.locator("input[name=email]").fill("me@example.com")
await fillInput("#user-name", "standard_user")
await fillInput(page.getByPlaceholder("Username"), "standard_user")
await fillInputs(page, [{ selector: "#first-name", value: "Kit" }])
state.title = await page.title()
state.page = await context.newPage()
```

Expected v1 support:

- Connect to an installed browser extension through a local bridge.
- Expose attached tabs as Playwright pages.
- Auto-create a tab when no attached tabs exist, if the extension is connected.
- Let agents create new tabs through `context.newPage()`.
- Support basic navigation, locator actions, screenshots, evaluate, and waits.
- Preserve sandbox `state` across execute calls.
- Create and reuse one default page per Browser Control session so concurrent
  agents do not collide on `context.pages()[0]`.
- Provide `browser-control session new/list/current/use/reset/delete`.
- Print the current agent workflow through `browser-control skill`.
- Expose an explicit `fillInput(selectorOrLocator, value)` escape hatch for
  existing-browser login/password fields when installed browser extensions make
  Playwright's native `locator.fill()` hang after the locator resolves.
- Expose `fillInputs(page, fields)` for multi-field forms where repeated
  locator-level DOM evaluation can hang in the user's existing browser.
- Expose `showGhostCursor()`, `hideGhostCursor()`, and `ghostCursor.show/hide`
  as cosmetic overlay helpers that mirror Playwright mouse move/press/release
  CDP commands while visible.
- Expose `screenshotWithLabels({ page, path })` for absolute-path screenshots
  annotated with simple DOM labels on visible likely-interactive elements.
- Document safe destructive UI flows: inspect target rows/IDs first, ask for
  explicit approval, open and read the confirmation dialog in the approved action
  script, confirm only after validating dialog text, then verify via an
  independent read path.
- Expose selected Node built-ins in the execute sandbox, such as `fs`, `path`,
  `os`, `crypto`, `url`, `util`, `events`, `stream`, `buffer`, `http`, `https`,
  and `zlib`.
- Provide status and setup errors when no extension is connected.
- Provide `browser-control doctor` for read-only local install and runtime
  diagnostics, including relay reachability, extension connection/version,
  sessions, active targets, built artifacts, and stale running relays after a
  CLI rebuild.
- Show target indexes, tab IDs, session IDs, and ownership in status output so
  agents can pick a page explicitly.
- Show child target counts in status so OOPIF/iframe relay state is visible while
  debugging replay issues.
- Show active-tab attach/detach through the extension toolbar action and keep a
  subtle in-page indicator for attached/running/waiting state.
- Remove legacy Browser Control tab groups; the in-page status is sufficient.

## First Milestone

Prove the smallest end-to-end path before adding product polish:

```text
1. Start local relay.
2. Extension connects to relay.
3. Toolbar click attaches the active tab.
4. Relay exposes one CDP endpoint.
5. Stock playwright-core connects over CDP.
6. execute('await page.title()') works.
7. context.newPage() creates and attaches a new tab.
```

Current status:

- Relay starts at `http://127.0.0.1:19989`.
- Extension shim `0.0.15` connects without websocket reconnect storms, reports
  its version in relay status, and re-announces attached tabs after reconnect so
  a restarted relay recovers the attached-tab pool. It removes legacy Browser
  Control groups on startup/reconnect and does not group attached tabs.
- `browser-control session adopt --target-url/--target-index` makes a
  user-attached tab the session's sticky default page; adopted tabs are
  released, never closed, by session reset/delete. Execute warns with an adopt
  tip when it creates a fresh page while a user-attached tab is open.
- CDP target visibility is scoped per client so concurrent sessions and raw
  clients cannot double-initialize each other's pages (`stale-client-checkout`
  smoke pins the regression).
- `browser-control execute 'return await page.title()'` works.
- `context.newPage()` works.
- `page.goto("https://example.com")` reaches load and locator reads work.
- UI Testing Playground obstacle checks pass for dynamic IDs, AJAX waits,
  physical clicks, client-side delay, progress timing, text input, sample login,
  scrollbars, and Shadow DOM generation. Login-field smoke cases use the explicit
  `fillInput` fallback because the user's existing browser can include password
  manager extensions that interfere with native Playwright fill.
- Relay-created tabs persist after short-lived execute sessions, preventing the
  visible tab from appearing and disappearing on every CLI probe.
- CLI execute supports `--target-url`, `--target-index`,
  `BROWSER_CONTROL_TARGET_URL`, and `BROWSER_CONTROL_TARGET_INDEX` for explicit
  page selection when a session needs to manually select or recover a shared tab.
- CLI execute supports `--file <path>` for longer scripts, auto-returns
  conservative single-expression snippets such as `page.url()`, and returns
  structured per-call script/page console logs plus page errors. Routine
  permissions-policy and blocked-analytics chatter is folded without removing
  distinct application errors or changing raw aftermath error counts.
- Bare CLI execute creates a fresh readable session in the execute request and
  prints the id. `--session` or `BROWSER_CONTROL_SESSION` explicitly reuses that
  session's default page and JavaScript `state` across commands.
- The relay stores and replays child target attach events, replays current child
  frame navigation for OOPIF reconnects, replays discovery events, filters
  restricted Chrome/extension targets, resumes filtered targets that were waiting
  for debugger, stores root page targets before applying auto-attach so early
  child events are not dropped, reapplies auto-attach to existing tabs, waits
  briefly for default runtime execution contexts after `Runtime.enable`, and
  awaits HTTP/websocket close callbacks during scoped relay shutdown.
- The 17-case smoke matrix passes local forms/cart/checkout, stale/raw client
  ordering, reconnect and redirect-reconnect evaluation, OOPIF reconnect,
  explicit execute targets, fill helpers, compact snapshots, cross-navigation
  and cross-tab handoffs, dedicated workers, automatic cursor modes, session
  isolation, and multi-client visibility. Smoke cases use local fixtures for app
  flows instead of third-party ecommerce sites so the signal is not coupled to
  the user browser profile or external site health.
- Execute exposes `screenshotWithLabels({ page, path })`, a small DOM-based
  labeled screenshot helper that writes to an absolute path, removes its overlay
  after capture, and returns label/ref metadata.
- Execute exposes `snapshot(options?)` as the compact semantic happy path and
  `ref(id)` for controls from the latest snapshot. The default prefers one
  `main`, collapses navigation, reserves its bounded budget for safety text and
  semantic structures, prioritizes primary links and controls over repeated
  metadata, summarizes selects, pairs table headers with row cell values, and
  omits form values. Refs combine structural
  selectors with accessible identity so DOM drift fails closed. Explicit
  `snapshot({ diff: true })` captures compare semantic lines against the previous
  compatible snapshot, expose refs only for current additions or changes, and
  advance the baseline. Full `ariaSnapshot` and Playwright code remain
  progressively deeper escape hatches.
- The relay control path is Effect-first at the Node boundary; websocket and
  Chrome extension APIs remain callback adapters.

Out of scope for the first milestone:

- Full CLI session management.
- MCP server polish.
- Tab grouping.
- Install packaging.
- Full accessibility snapshots and richer labeled screenshots.
- Download handling.
- Raw CDP documentation.

Implementation shape for the first milestone:

- Use Effect v4 for Node-side service boundaries, resource lifecycles, logging,
  and errors.
- Prefer `Effect.fn` / `Effect.fnUntraced` for effectful functions, and model
  Playwright/relay cleanup with scoped resource lifecycles instead of manual
  cleanup after success paths.
- Do not introduce Effect RPC until there is a concrete need for schema/versioned
  protocol machinery across the relay/extension boundary.
- Keep the extension plain TypeScript because MV3 extension code should stay
  small and browser-native. Treat it as a stable shim that forwards toolbar,
  debugger, tab, and action calls to the relay.
- Use `@effect/platform-node` for Node runtime/platform integrations where it
  helps, instead of hand-rolling lifecycle wiring.
- Prefer small services such as relay server, extension connection registry,
  Playwright connection, and execute sandbox.

## Known V1 Limitations

V1 intentionally avoids capabilities that would require forking
`playwright-core` or patching Playwright internals:

- No `page.sessionId()` or `page.targetId()`.
- No `frame.frameId()`.
- No `locator.selector()`.
- Ghost cursor support is a transient relay-injected arrow with spring motion and
  persistent and disabled overrides, not a recording or demo-video editing system.
- Recording supports existing `chrome.tabCapture` WebM for user-owned tabs and a
  relay-side CDP JPEG frame-directory fallback for relay-owned tabs. CDP recording
  does not encode video or capture audio yet.
- No advanced raw-CDP helper guarantees.
- No custom raw-CDP helper API beyond stock Playwright behavior.
- No custom timeout, dialog, or inspect patches to Playwright internals.
- No unrestricted local command execution by default, such as `child_process`.
- Clipboard automation on non-secure origins is not guaranteed. For example,
  UI Testing Playground's HTTP Shadow DOM clipboard case cannot read
  `navigator.clipboard`; clipboard support needs explicit secure-origin and
  permission handling.
- Native Playwright `locator.fill()` can hang on login/password-style fields in
  the user's existing browser when installed extensions, such as password
  managers, inject focus handlers or overlays. Use `fillInput(selector, value)`
  or `fillInput(locator, value)` as an explicit fallback for `input` and
  `textarea` fields.
- Broader OOPIF scenarios beyond the current reconnect smoke canary are not yet
  guaranteed.
- Exact URL A/B parity across third-party authentication is a deliberate manual
  diagnostic step, not an automated smoke: use the same browser profile and
  exact starting URL in a fresh relay-owned tab and an already-authenticated
  adopted tab, verify the post-redirect URL/element, and capture
  `BROWSER_CONTROL_DEBUG=1` metadata. Do not automate credentials, auth tokens,
  or production account state to manufacture parity.

## Architecture Debt Queue

Sequenced follow-ups from the 2026-07 architecture review that are not yet
implemented. Each item should land with smoke evidence.

1. **Split `makeRelay`**: extract `CdpRouter` (command routing + shims),
   `ExtensionEventHandler` (extension event decode + registry mutation), and
   `CdpClientPool` (client sockets, per-client attach sets, generation counter)
   out of the 700-line closure in `src/relay.ts` so relay behavior is testable
   without a browser.
2. ~~**Scope CDP event broadcast per client**~~ **Done (2026-07-02)**: target
   visibility is per client (`src/cdp-visibility.ts`). Session-owned tabs are
   announced and their events delivered only to that session's CDP clients;
   unowned tabs (user toolbar-attached, raw-client-created) stay visible to
   everyone so raw reconnects and `--target-url` recovery keep working. The
   root failure was double initialization: every client used to receive
   `Target.attachedToTarget` for every tab, so concurrent clients raced each
   other's `Runtime.enable`/`Page.createIsolatedWorld` on the same chrome
   session and `newPage`/`setContent`/`evaluate` hung non-deterministically.
   Regression coverage: `multi-client` smoke case; smoke no longer requires a
   sandbox-free relay. Two simultaneous raw `connectOverCDP` clients can still
   interfere with each other's tabs (sessions are the supported isolated path).
3. **Remove arbitrary-first-target fallbacks** in CDP routing
   (`Target.getTargetInfo`, sessionless commands) and make `autoAttachParams`
   per-client instead of global last-writer-wins. (The arbitrary fallbacks now
   at least respect per-client visibility.)
4. ~~**Runtime.enable stall**~~ **Done (2026-07-02)**: the default-context
   waiter is registered before the enable command is forwarded (context events
   arriving during the round trip no longer eat the full 3s wait), and when no
   default `Runtime.executionContextCreated` arrives the relay kicks a
   `Runtime.disable`/`Runtime.enable` cycle to force Chrome to re-emit
    contexts. Verified live: the kick immediately unsticks a `page.evaluate`
    that would otherwise wait forever after Chrome swallowed a re-enable.
   `BROWSER_CONTROL_DEBUG=1` now emits bounded `[bc:ctx]` metadata for target
   ownership/browser-context identity, main-frame loaders, context lifecycle,
   reset outcomes, and failed evaluate shape/error class. Expressions,
   arguments/results, headers, cookies, and form values are excluded; URLs are
   origin/shape/fingerprint summaries. The deterministic
   `redirect-reconnect-evaluate` smoke covers a local 302, cross-document context
   replacement, client reconnect, and successful `page.evaluate`.
5. **Emit child `Target.detachedFromTarget`** when a root target detaches so
   clients do not hold orphaned child sessions.
6. **Recording chunk framing**: prefix tabId + sequence number into the binary
   websocket frames instead of pairing a JSON metadata frame with "the next
   binary frame", and stream chunks to disk instead of buffering whole
   recordings in relay memory.
7. **Extension reconnect hardening**: use `addEventListener` in the shim,
   single-source the `hello` send, and consider a bounded outbound queue so
   debugger events during a websocket blip are not silently dropped.
8. **MCP recording tools**: expose recording start/stop/status/cancel over MCP
   so the MCP surface is not weaker than the CLI.

## UX Roadmap (Accepted Directions)

Differentiators accepted after comparing against similar browser drivers.

Shipped:

1. **Relay-level guardrails** (shipped): the relay blocks
   `Network.clearBrowserCookies`, `Network.clearBrowserCache`,
   `Storage.clearCookies`, and `Browser.close` for every CDP client
   (`src/cdp-guardrails.ts`, enforced at the top of `routeCdpCommand`).
   `session new --read-only` (and MCP `session_new { readOnly: true }`) creates
   a session whose CDP client is additionally denied `Input.*`; Playwright
   actions retry until their own timeout, so blocked clicks surface as
   timeouts. `page.evaluate` can still mutate the page; read-only guards
   trusted mistakes, not malicious code.
2. **Structured execute output** (shipped): `execute --json` prints
   `{ ok, value | error: { _tag, message }, logs, warnings, diagnostic?, aftermath,
   session }`. `aftermath` reports startUrl/endUrl, main-frame navigations,
   console/page error counts, and handoffs for that one call. Warnings (page
   recreated, relay reconnect) are delivered with the call that caused them.
   Dialog capture was deliberately skipped: a passive `page.on("dialog")`
   listener would suppress Playwright's auto-dismiss and hang pages.
3. **Visible session identity** (shipped): full ids remain in diagnostics while
   the subtle in-page status and toolbar badge show presence; the badge shows
   `RUN` (amber) while mutable sessions execute, stays quietly `ON` for read-only
   work, and shows `WAIT` (blue) while a handoff is pending. A toolbar
   click during execution never detaches the tab, including a user-owned tab
   bound to an active handoff. True mid-script interruption (cancelling the
   running effect) is future work.
4. **Human-in-the-loop handoff** (shipped): `await handoff(message, {
   timeoutMs })` in execute code shows an in-page message and explicit
   completion control, blocks, and resumes only when that control returns the
   matching handoff id from the bound tab (`src/handoff.ts` + content-script
   routing in the relay). Binding uses the actual Playwright page's stable CDP
   target id, then retains the exact registry target/tab/session identity, so
   top-level navigation cannot change which page owns the waiter. The relay
   reinjects pending WAIT state after navigation. Timeouts (default 10 minutes) throw. Human acknowledgment is not
   proof of success, so scripts must assert the expected URL or element after
   resuming. A right-click "send element to Browser Control" pin is a later
   maybe.
5. **Session journal** (shipped): every execute is appended to
   `~/.browser-control/sessions/<id>/journal.jsonl` (`src/session-journal.ts`)
   with timestamp, truncated code, status, duration, URL movement, warnings,
   handoffs, and a bounded fixed diagnostic for execution-context failures.
   `browser-control journal [-s id] [--limit n] [--json]` renders
   the timeline. Journal writes are best-effort and never fail the execute.

Remaining:

6. **Flight-recorder ring buffer**: keep roughly the last 60 seconds of CDP
   frames for attached tabs at all times so
   `browser-control recording save-last 30s` can rescue evidence after
   something surprising happens. Post-hoc capture beats deciding to record in
   advance. Depends on debt item 6 (recording chunk streaming) landing first.

Explicitly considered and declined for now:

- Dedicated observe CLI verbs (`browser-control snapshot`/`screenshot`/`logs`):
  the code-level versions inside execute are enough.
- Topic-scoped skill subcommands (`skill recording`, etc.): keep one concise
  skill document instead.

## Later Todo

- Add optional browser launching, including Brave/profile selection.
- Add token-authenticated remote relay mode only if Browser Control needs to bind
  beyond trusted local interfaces.
- Publish the browser extension through the Chrome Web Store once behavior is
  stable.
- Bundle the extension with the CLI for managed/dev browser launch flows.
- Evaluate whether custom CDP or Playwright-lite is worth building.
- Add stricter workspace/session ownership only if loose shared tabs cause real
  failures.
- Consider richer accessibility snapshots after the basic DOM-labeled screenshot
  helper proves useful.
- Add custom raw-CDP helpers only after concrete use cases require them.
- Consider an explicit flag for broader local code execution if agents need it.
- Add smoke coverage that asserts `browser-control execute --session x` and
  `BROWSER_CONTROL_SESSION=x browser-control execute` fail when `x` does not
  exist. Explicit session creation now goes through `browser-control session new
  x` or MCP `session_new`.
- Scope the saved current CLI session by selected user browser profile (endpoint
  scoping is done) so switching profiles does not accidentally reuse an
  unrelated session id.

## Open Questions
