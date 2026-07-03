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
  `/Users/kit/.config/opencode/skills/browser-control/skill.md` synced with
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
- Execute runs inside relay-backed sessions. If the user does not provide a
  session id, the CLI creates a readable id such as `cosmic-otter-866`, stores it
  as the current local session, and reuses that session for later commands.
- Each Browser Control session owns one default page and persistent JavaScript
  `state`; do not default to arbitrary shared tabs for normal execute calls.
- Use stock `playwright-core` for v1.
- Use Effect v4 / `effect-smol` for Node-side code. Treat
  `/Users/kit/code/open-source/effect-smol` as the local source of truth for
  Effect APIs and patterns.
- Prefer `Effect.fn` / `Effect.fnUntraced` for functions that return Effects,
  and use scoped resources (`Effect.acquireRelease`, `Effect.scoped`) for
  Playwright and relay lifecycles.
- Keep the relay/extension protocol as custom JSON-over-websocket unless there is
  a concrete reason to adopt Effect RPC across that boundary.
- Keep the extension as a stable shim over Chrome APIs. Put behavior in the
  relay when possible so iteration usually requires only restarting Node, not
  reloading the extension.
- Relay HTTP wire shapes live in `src/relay-schema.ts` (Effect Schema). Both the
  HTTP responders and clients must derive types from those schemas; do not
  hand-roll relay JSON parsers.
- The CLI and MCP server talk to the relay only through the shared
  `src/relay-client.ts` service (`RelayClient.Service`), never through ad-hoc
  fetch/node:http calls. Failures are tagged errors that keep the relay's own
  error message as the top-level message.
- The CLI's current session id is endpoint-scoped in
  `~/.browser-control/session.json` via `src/session-store.ts`.
- An extension RPC timeout fails only that command; the extension socket is
  closed only when a websocket-level ping probe also fails.
- CDP guardrails are pure logic in `src/cdp-guardrails.ts`, enforced at the top
  of `routeCdpCommand`. Destructive browser-state methods are always blocked;
  read-only sessions additionally reject `Input.*`.
- Human handoff waiters live in `src/handoff.ts`; the relay resolves them from
  `toolbar.clicked` before considering attach/detach toggles, and never
  detaches a tab whose session is mid-execute.
- Execute results carry per-call `warnings` and an `aftermath` summary
  (URL movement, navigations, error counts, handoffs). Do not add a passive
  `page.on("dialog")` listener for aftermath: it would suppress Playwright's
  dialog auto-dismiss and hang pages.
- The session journal (`src/session-journal.ts`) appends one JSON line per
  execute under `~/.browser-control/sessions/<id>/journal.jsonl`; writes are
  best-effort and must never fail the execute call.
- Session delete/reset must acquire the session's execute permit before closing
  the sandbox, so running scripts are never yanked mid-flight.
- The version string is injected at build time by `scripts/build-cli.ts`
  (`src/version.ts`, `0.0.0-dev` when running from source); never hardcode
  version literals.
- `dist/mcp.js` self-runs via the dedicated `src/mcp-main.ts` entrypoint. Do not
  add `process.argv[1] === import.meta.url` self-run guards to modules that get
  bundled into `dist/cli.js`; esbuild inlining makes the guard fire inside the
  CLI bundle.
- Relay-created tabs should persist across short-lived `browser-control execute`
  commands so shell-based agents do not create and delete a visible tab for every
  probe.
- Root page targets must be stored before applying `Target.setAutoAttach`, because
  Chrome can emit child/OOPIF attach events immediately and the relay needs the
  root target to route and store them.
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
- Run `SMOKE_CASE=local-forms,local-cart,local-checkout,reconnect-evaluate,execute-target-url,execute-fill-helpers,oopif-reconnect,session-isolation,multi-client pnpm smoke`
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
browser-control execute "return { url: page.url(), title: await page.title() }"
browser-control execute --json "page.url()"
browser-control journal
browser-control skill
```

## Extension

- Load `extension/dist` as the unpacked extension.
- The relay listens on `127.0.0.1:19989` by default.
- Current shim version is `0.0.7`.
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
- The attached tab group should use the purple `browser-control` group.
