# Browser Control

Browser Control is a local browser driver for trusted agents. It controls the
user's existing Chromium-family browser through a small MV3 extension shim and a
local Node relay.

## Source Of Truth

- Keep `PLAN.md` updated when architecture, scope, install flow, or product
  preferences change.
- Keep `CONTEXT.md` updated when domain language changes.
- Keep `skills/browser-control/SKILL.md` updated when the agent-facing workflow,
  commands, setup steps, or troubleshooting behavior changes.
- Keep the installed OpenCode skill at
  `~/.config/opencode/skills/browser-control/skill.md` synced with
  `skills/browser-control/SKILL.md` after agent-facing workflow changes.
- If a code change affects how agents should use Browser Control, update the
  skill in the same change.
- `browser-control skill` must print the current `skills/browser-control/SKILL.md`
  text so another agent can fetch the installed workflow instructions.

## Architecture Preferences

- Browser Control is a driver, not an LLM agent.
- Use the user's already-running Chromium-family browser first.
- Keep tabs in a loose attached-tab pool for v1.
- Prefer a code-first `execute(code)` interface over many tiny action tools.
- Execute runs inside relay-backed sessions. Bare CLI execute atomically creates
  a fresh readable id such as `cosmic-otter-866` and prints how to continue with
  `--session`; it never infers agent identity from shared current-session state.
- Relay-backed CLI commands auto-start a detached relay when needed. `status`
  and `doctor` remain observational, and `serve` is only the foreground/debug
  path. MCP uses the same detached relay lifecycle instead of owning an
  in-process relay, so an MCP restart cannot interrupt CLI handoffs. The first
  session is created atomically in the execute request.
- Each Browser Control session owns one default page and persistent JavaScript
  `state`; do not default to arbitrary shared tabs for normal execute calls.
- Use stock `playwright-core` for v1.
- Use Effect v4 / `effect-smol` for Node-side code. Treat
  a local `effect-smol` checkout as the source of truth for
  Effect APIs and patterns.
- Prefer `Effect.fn` / `Effect.fnUntraced` for functions that return Effects,
  and use scoped resources (`Effect.acquireRelease`, `Effect.scoped`) for
  Playwright and relay lifecycles.
- Read application runtime configuration through Effect `Config`. Direct
  `process.env` access is reserved for synchronous process-fault reporting and
  child-process environment forwarding at Node adapter boundaries.
- Keep the relay/extension protocol as custom JSON-over-websocket unless there is
  a concrete reason to adopt Effect RPC across that boundary.
- Keep the extension as a stable shim over Chrome APIs. Put behavior in the
  relay when possible so iteration usually requires only restarting Node, not
  reloading the extension.
- Relay HTTP wire shapes live in `src/relay-schema.ts` (Effect Schema). Both the
  HTTP responders and clients must derive types from those schemas; do not
  hand-roll relay JSON parsers. Error responses use the shared coded
  `ErrorEnvelope`; keep the relay message top-level while mapping tagged domain
  errors to stable codes and HTTP statuses.
- Tie relay HTTP effects to the response lifetime with an `AbortSignal`.
  Browser execute itself is uninterruptible at the underlying Playwright
  Promise boundary so interruption cannot release its session permit while the
  script still mutates the page.
- The CLI and MCP server talk to the relay only through the shared
  `src/relay-client.ts` service (`RelayClient.Service`), never through ad-hoc
  fetch/node:http calls. Failures are tagged errors that keep the relay's own
  error message as the top-level message.
- Human session-management commands keep an endpoint-scoped current id in
  `~/.browser-control/session.json`; execute and adopt never use it implicitly.
  Invalid persisted session JSON is reported and preserved, never treated as an
  empty store that a later write may overwrite.
- An extension RPC timeout fails only that command; the extension socket is
  closed only when a websocket-level ping probe also fails.
- CDP guardrails are pure logic in `src/cdp-guardrails.ts`, enforced at the top
  of `routeCdpCommand`. Destructive browser-state methods are always blocked;
  read-only sessions additionally reject `Input.*`.
- Human handoff waiters live in `src/handoff.ts`; derive their stable CDP target
  id from the actual Playwright `Page`, then bind the exact registry
  target/tab/session. The relay resolves only a matching handoff id from that
  tab's in-page completion control. Toolbar clicks never resolve handoffs or
  detach a tab whose session is mid-execute. The extension must not clear page
  status directly from `chrome.debugger.onDetach`: the relay owns root-detach
  classification, and ambiguous `target_closed` events from extension child
  targets must preserve the handoff UI.
- `TargetRegistry` is the sole production target-ownership authority. Session
  state keeps only the adopted default-page pointer. Adoption reserves,
  commits, or rolls back registry ownership transactionally and reconciles CDP
  visibility, grouping, and page status for every changed target.
- Adopted targets are exclusive to one Browser Control session. Serialize
  adopts, reject competing owners, and release ownership on detach, reset, or
  delete. If adoption times out, roll back visibility immediately but retain
  the execute and adopt permits until uncancellable Playwright work settles.
  Relay shutdown must close the adoption gate and drain those workers rather
  than interrupting them.
- Execute results carry per-call `warnings` and an `aftermath` summary
  (URL movement, navigations, error counts, handoffs). After an execution-context
  diagnostic or target crash, the next normal execute performs a bounded page
  health check: recreate unhealthy relay-owned pages only after the old page
  closes, but never close or replace unhealthy adopted user tabs. Crash events
  reject pending debugger commands for only that tab and remain visible in
  status/doctor until navigation or detach.
  Do not add a passive `page.on("dialog")` listener for aftermath: it would
  suppress Playwright's dialog auto-dismiss and hang pages.
- Allowed Playwright mouse actions automatically reveal a spring-animated arrow cursor;
  explicit helpers can keep it visible or disable it for the current document.
  Read-only input is rejected before cursor mirroring.
- Compact `snapshot()` refs are scoped to the session's latest snapshot and
  rejected after main-frame navigation. Their locators combine structural and
  accessible identity so sibling drift fails closed. Snapshot budgets reserve
  semantic groups, lists, tables, block code, alerts, and primary links before
  repeated metadata; text input and textarea values are omitted. Snapshot diffs
  are explicit, require a compatible prior baseline, invalidate earlier refs,
  and expose refs only for added or changed current lines. Keep `ariaSnapshot()`
  and raw Playwright as deeper inspection layers; do not replace the code-first
  execute interface with many action commands.
- Authenticated network capture is owned by the persistent Execute Sandbox and
  records normalized exchanges; HAR is only an export adapter. Written
  artifacts always use route-scoped stable `BC_SECRET_N` references. Lossless
  values live in restrictive secret profiles and enter generated clients only
  through `secrets run`. Keep recorder transitions serialized, body retention
  bounded per body and in aggregate, profile updates locked across relay
  processes, and credential values out of normal outputs, diagnostics, and
  journals.
- With `BROWSER_CONTROL_DEBUG=1`, `[bc:ctx]` lines trace bounded metadata for
  target ownership/browser-context identity, main-frame loaders, Runtime context
  lifecycle/reset attempts, and failed evaluates. Never add expressions,
  arguments/results, headers, cookies, or form values to this trace.
- The session journal (`src/session-journal.ts`) appends one JSON line per
  execute under `~/.browser-control/sessions/<id>/journal.jsonl`; writes are
  best-effort and must never fail the execute call.
- Relay-owned recording uses `Page.startScreencast`, immediately acknowledges
  compositor frames, activates the target to avoid background-tab throttling,
  and fits its viewport within 1280×720. Stream each distinct JPEG once in a
  timestamped Matroska envelope and let ffmpeg produce constant 25 fps output;
  never push duplicated JPEGs through Node or derive duration from discontinuous
  navigation timestamps.
- Session delete/reset must acquire the session's execute permit before closing
  the sandbox, so running scripts are never yanked mid-flight.
- The version string and build id are injected by `scripts/build-cli.ts`
  (`src/version.ts`, `0.0.0-dev` / `dev` when running from source). The relay
  reports both so `doctor` can detect a long-running relay left stale by a CLI
  rebuild; never hardcode version literals.
- `dist/mcp.js` self-runs via the dedicated `src/mcp-main.ts` entrypoint. Do not
  add `process.argv[1] === import.meta.url` self-run guards to modules that get
  bundled into `dist/cli.js`; esbuild inlining makes the guard fire inside the
  CLI bundle.
- CDP target visibility is scoped per client (`src/cdp-visibility.ts`):
  session-owned tabs are announced and their events delivered only to that
  session's clients; unowned tabs stay visible to everyone. Do not reintroduce
  broadcast-to-all: it double-initializes pages across clients and hangs
  `newPage`/`setContent`/`evaluate` (regression case: `stale-client-checkout`
  smoke).
- Client-side CDP aliases for already-announced root targets must route commands
  without a Chrome child `sessionId`; only child-target aliases carry a real
  Chrome session id. Use `chromeSessionIdForClientRequest` for both ordinary
  commands and `Runtime.enable`.
- `session adopt` makes a user-attached tab the session's default page. Adopted
  tabs are never closed by session reset/delete — only released. Adopting
  closes the session's previously relay-created page.
- Relay-created tabs should persist across short-lived `browser-control execute`
  commands so shell-based agents do not create and delete a visible tab for every
  probe.
- Root page targets must be stored before applying `Target.setAutoAttach`, because
  Chrome can emit child/OOPIF attach events immediately and the relay needs the
  root target to route and store them.
- `Target.setAutoAttach` forwards dedicated `worker` targets to Playwright, but
  resumes and suppresses unsupported children such as page-scoped service
  workers. Exposing an unroutable paused child can hang its parent navigation.
- OOPIF reconnect depends on replaying stored child target attaches plus the
  current child frame navigation on the child session for stock Playwright.
- Relay shutdown should await HTTP and websocket close callbacks so scoped tests
  and smoke runs do not leak listeners or ports.
- Use plain TypeScript for the MV3 extension unless a build-system need forces a
  change.

## Development

- Run `pnpm typecheck` after TypeScript changes.
- Run `pnpm test` (vitest) after changes to schemas, relay-client, session
  store/manager, extension-rpc, or execute auto-return logic. Unit tests live in
  `test/` and must not require a browser.
- Run `pnpm build:cli` after CLI or relay source changes that should affect the
  linked `browser-control` binary.
- Run `pnpm build:extension` after extension changes.
- Extension shim changes require reloading the unpacked extension once in Brave.
- Relay-only changes should not require reloading the extension.
- Use `termctrl` for long-running relay sessions during testing.
- Run `SMOKE_CASE=local-forms,local-cart,local-checkout,reconnect-evaluate,redirect-reconnect-evaluate,execute-target-url,execute-page-recovery,execute-page-detach-recovery,execute-fill-helpers,execute-snapshot-refs,handoff-navigation,handoff-cross-tab,handoff-target-detach,oopif-reconnect,dedicated-worker,network-capture,session-download-capability,execute-ghost-cursor,session-isolation,multi-client,stale-client-checkout,raw-first-checkout pnpm smoke`
  before claiming the current smoke set is green.
- CDP target visibility is scoped per client (`src/cdp-visibility.ts`):
  session-owned tabs are announced and their events delivered only to that
  session's clients; unowned tabs stay visible to everyone. Do not reintroduce
  broadcast-to-all: it double-initializes pages across clients and hangs
  `newPage`/`setContent`/`evaluate` (regression case: `multi-client` smoke).
- Run the relay with `BROWSER_CONTROL_DEBUG=1` to log per-client CDP requests,
  responses, and extension debugger events when diagnosing protocol issues.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build:cli
pnpm build:extension
SMOKE_CASE=oopif-reconnect pnpm smoke
browser-control serve
browser-control status
browser-control session new
browser-control session new inspect --read-only
browser-control session list
browser-control execute 'return { url: page.url(), title: await page.title() }'
browser-control execute --json 'page.url()'
browser-control journal
browser-control skill
```

## Extension

- Load `extension/dist` as the unpacked extension.
- The relay listens on `127.0.0.1:19989` by default.
- Current shim version is `0.0.17`.
- On socket open the shim sends `hello` and then re-announces every tab it still
  has `chrome.debugger` attached to (`debugger.attached` events), so a restarted
  relay rebuilds its target registry without the user re-clicking the toolbar.
- The relay dedupes target announcements per CDP client by targetId: a
  re-announce under a new sessionId emits `Target.detachedFromTarget` for the
  old session first. Never announce the same targetId twice to one client
  without a detach — playwright-core's `Duplicate target` assert kills the
  connection's process.
- The relay installs scoped `uncaughtException`/`unhandledRejection` guards for
  its lifetime; in-process playwright event dispatch errors are logged, not
  fatal.
- Session-owned tabs, including adopted user tabs, share a purple `control`
  group within each browser window. Merely attached tabs remain in their
  existing location. Releasing an adopted tab removes it from `control` without
  closing it. The shim also recognizes legacy `browser-control`, `bc:*`, and
  `bc · *` groups for cleanup.
