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
- Ordinary CLI, MCP, and SDK calls never replace a running relay. Replacement
  requires `browser-control relay restart`, an exact managed instance, and safe
  shutdown protocol 2. Legacy, foreground, source, and newer relays fail closed;
  never add a force-kill or implicit downgrade fallback.
- `RelayShutdown` owns admission and the reversible restart drain. Keep debugger
  RPCs and handoffs alive until accepted session work, queued work, native
  operations, and persistence settle. Timeout or pre-commit cancellation reopens
  admission and must never cause a delayed shutdown. Raw CDP clients and active
  recordings/captures require deliberate completion before restart.
- Record bounded requester/build/instance metadata in the private endpoint
  `lifecycle.jsonl` before committing a restart. Do not log expressions, URLs,
  command arguments, or credential values. The successor records the acknowledged
  request id; attribution is diagnostic metadata, not authenticated identity.
- Each Browser Control session owns one default page and persistent JavaScript
  `state`; do not default to arbitrary shared tabs for normal execute calls.
- Use stock `playwright-core` for v1.
- Use Effect v4 for Node-side code, keeping `effect`, `@effect/platform-node`,
  and `@effect/platform-node-shared` exactly pinned to the same release. The local
  `/Users/kit/code/open-source/effect` checkout is the source of truth for APIs and
  patterns; `effect-smol` is archived.
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
  Execute workers outlive an interrupted request once browser work starts;
  retain the session permit through final journal and catalog writes so aborted
  clients cannot lose aftermath bookkeeping or overlap later page mutations.
- The CLI and MCP server talk to the relay only through the shared
  `src/relay-client.ts` service (`RelayClient.Service`), never through ad-hoc
  fetch/node:http calls. Failures are tagged errors that keep the relay's own
  error message as the top-level message.
- Human session-management commands keep an endpoint-scoped current id in
  `~/.browser-control/session.json`; execute and adopt never use it implicitly.
  Invalid persisted session JSON is reported and preserved, never treated as an
  empty store that a later write may overwrite.
- Relay session descriptors persist per port under
  `~/.browser-control/relays/<port>/sessions.json`. After a relay restart,
  restore session ids, read-only mode, and exact target ownership when that tab
  reappears; JavaScript `state` and snapshot refs intentionally reset and warn.
  Win the endpoint port before loading or writing this catalog. Successful
  durable lifecycle operations await atomic replacement plus file and directory
  sync. Corrupt catalogs fail relay startup and are never overwritten.
- An extension RPC timeout fails only that command; the extension socket is
  closed only when a websocket-level ping probe also fails.
- CDP guardrails are pure logic in `src/cdp-guardrails.ts`, enforced at the top
  of `routeCdpCommand`. Destructive browser-state methods are always blocked;
  read-only sessions additionally reject `Input.*`.
- Browser-context CDP methods route through a non-crashed session-owned root for
  named clients or exactly one visible root for raw clients. A named client never
  falls back to an unrelated unowned tab. Crashed roots remain visible and count
  toward raw-client ambiguity; explicit target routes remain available.
- Human handoff waiters live in `src/handoff.ts`; derive their stable CDP target
  id from the actual Playwright `Page`, then bind the exact registry
  target/tab/session. The relay resolves only a matching handoff id from that
  tab's in-page completion control. Toolbar clicks never resolve handoffs or
  detach a tab whose session is mid-execute. The extension must not clear page
  status directly from `chrome.debugger.onDetach`: the relay owns root-detach
  classification, and ambiguous `target_closed` events from extension child
  targets must preserve the handoff UI.
- Handoff `start` actions run only after the waiter and WAIT UI are registered.
  Require extension acknowledgement of WAIT before invoking `start`. Human
  completion waits for the action to settle and for the destination execution
  context to become available. Timeout or target cancellation disconnects the
  sandbox before releasing its execute permit, preventing a non-settling prompt
  action from mutating the page later. Cancel the waiter if WAIT presentation or
  action startup fails.
- `TargetRegistry` is the sole production live target-ownership authority.
  Session state keeps one durable default-target identity and owner. Adoption reserves,
  commits, or rolls back registry ownership transactionally and reconciles CDP
  visibility, grouping, and page status for every changed target.
- `CdpClientPool` owns client announcements and aliases as private state. Its
  transitions dedupe attachments, detach descendants before parents, and
  invalidate aliases together. Callers supply visibility policy, never mutate
  announcement indexes. Keep its event sink browser-free for transition tests.
- A named CDP client is not necessarily an Execute Sandbox. Only the sandbox's
  internal client-kind header identifies its transport; other clients remain raw
  for restart safety even when they carry a session id. Track accepted CDP work
  beyond socket closure and permit sandbox continuation RPCs during drain.
- `RootTargetLifecycle` owns per-tab setup, staging, verification, commit, retry,
  and generation invalidation. Stale workers must never detach a successor tab.
  Drain its scoped workers before closing extension RPCs; keep presentation
  best-effort and outside authoritative ownership. Exhausted committed or staged
  root probes fail readiness; preserve original RPC errors. Readiness rejection
  closes the extension socket with 1011 and disconnect cleanup clears live targets.
- `BrowserControlSessions` installs the sandbox's default-target callback and
  binds it to the exact session instance. Retired sandbox callbacks must never
  update a reset or recreated session with the same id.
- Sandbox teardown exposes only settled close/disconnect operations. Bound the
  caller's wait in the manager while retaining the cleanup worker; do not add
  bounded sandbox variants that can hide unfinished browser work.
- `CdpRuntime` owns Runtime enable observation and the bounded reset fallback.
  Start context windows before sending commands. Recovery and idle cleanup must
  recheck captured root/child identity, extension generation, and caller
  visibility before each unsent command. Disconnected clients never fall back
  to raw-client visibility. Keep reset failures best-effort and return the
  original enable result.
- Same-tab root target generations are explicit replacements, never map
  overwrites. Preserve committed ownership, roll back provisional adoption
  ownership, detach the old generation before announcing the new one, rebind
  pending handoffs, and make the owning sandbox reacquire the exact new target.
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
  and expose refs only for added or changed current lines. `ariaSnapshot()` also
  omits native text-control values, custom ARIA range values, and editable
  composed-tree content while preserving surrounding structure. Register its
  unique selector engine for each connected Playwright context before any page
  or locator work; pre-connect registration does not reach the default context
  returned by `connectOverCDP`. Track each mask with a module-unique token and
  clean it only through the frame where it was activated; a destroyed execution
  context is already clean. It temporarily masks those values in Playwright's
  isolated world, so do not run it concurrently with other operations on the
  same page. Keep raw
  Playwright as a deeper inspection layer; do not replace the code-first execute
  interface with many action commands.
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
- Session deletion is idempotent for a resolved session id: return whether a
  live session was deleted instead of failing when it is already absent.
- Reset/delete of an absent persisted relay-owned target waits for protocol-v1
  inventory reconciliation or a bounded grace, then forgets the dead identity
  without guessing a physical tab to close. Never apply this dead-target path
  to adopted user tabs.
- The version string and build id are injected by `scripts/build-cli.ts`
  (`src/version.ts`; source runs use `0.0.0-dev` and a deterministic source
  and dependency-lock fingerprint). The relay
  reports both so `doctor` can detect a long-running relay left stale by a CLI
  rebuild; never hardcode version literals.
- Relay version metadata includes an instance id, start time, and PID. Bounded
  managed-relay process-fault diagnostics are retained with mode `0600` in
  `~/.browser-control/relay.log` so same-build restarts and session loss are
  diagnosable instead of appearing as eviction.
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
- Run `pnpm check:unused` (Knip) and `pnpm check:locals` during cleanup; both are
  CI gates. Keep `knip.ts` aligned with CLI/MCP, published SDK, browser-loaded,
  and sandbox-script entry points. Review findings before deleting declarations:
  an unused export can still be used inside its module. Never hide public SDK
  exports or dynamic entry points to make the audit green.
- For occasional whole-codebase audits, run `pnpm exec knip --production`.
  Trailing `!` patterns retain runtime roots while excluding tests. Findings are
  advisory: test-only exports may still have live same-file callers. Keep this
  separate from the normal Knip CI gate.
- Run `pnpm audit:duplicates` alongside larger cleanups. It is advisory: shared
  text does not prove shared behavior, especially around permits and cleanup.
- Run `pnpm test` (vitest) after changes to schemas, relay-client, session
  store/manager, extension-rpc, or execute auto-return logic. Unit tests live in
  `test/` and must not require a browser.
- Do not link the active CLI/MCP installation to a mutable checkout. Use
  `pnpm runtime:prepare --staging <fresh-absolute-dir> --install <fresh-absolute-dir>`
  to build and validate a standalone candidate without changing the live tool.
  `pnpm runtime:select --install <validated-dir> --active <shared-symlink>` changes
  only future command selection; it never restarts a relay or reloads an extension.
  Retain previous installation directories while any process may still use them.
- Use `pnpm build:cli --outdir <external-directory>` to validate CLI/relay changes
  without overwriting a linked installation. The default build still writes
  checkout `dist`; never run it against an installation used by other agents.
- Run `pnpm build:extension` after extension changes.
- Extension shim changes require reloading the unpacked extension once in Brave.
- Relay-only changes should not require reloading the extension.
- Use `termctrl` for long-running relay sessions during testing.
- Run `SMOKE_CASE=local-forms,local-cart,local-checkout,reconnect-evaluate,redirect-reconnect-evaluate,session-missing-selector,execute-target-url,execute-page-recovery,execute-page-detach-recovery,execute-fill-helpers,execute-snapshot-refs,handoff-navigation,handoff-cross-tab,handoff-target-detach,oopif-reconnect,dedicated-worker,network-capture,session-download-capability,execute-ghost-cursor,session-isolation,multi-client,stale-client-checkout,raw-first-checkout pnpm smoke`
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
pnpm runtime:prepare --help
pnpm runtime:select --help
pnpm runtime:check-lifecycle --help
pnpm build:extension
SMOKE_CASE=oopif-reconnect pnpm smoke
browser-control serve
browser-control status
browser-control relay restart
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
- Current shim version is `0.0.24` and extension protocol version is `2`.
- Store and npm versions may differ while their extension protocol versions remain compatible.
- The source and unpacked-build manifest carries the public key for stable id
  `eibhgjafffkigblngnhafgbcipofaeon`. Store packaging must strip that key so the
  Chrome Web Store keeps its assigned extension id.
- On socket open the shim sends `hello` and then re-announces every tab it still
  has `chrome.debugger` attached to (`debugger.attached` events), so a restarted
  relay rebuilds its target registry without the user re-clicking the toolbar.
- Send `ready` after the attached-tab inventory; tab-group presentation and
  stale-group cleanup are best-effort and must never block extension readiness.
  Serialize group and ungroup presentation per tab so delayed browser APIs
  cannot apply an older ownership state after a newer one.
- Register `runtime.onStartup` at global scope so a full browser restart wakes
  the MV3 worker. Repair the reconnect alarm whenever the worker starts and send
  heartbeat traffic every 20 seconds while its relay socket is open. Chrome may
  clear persisted alarms and retires idle extension workers even with an open
  socket.
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
