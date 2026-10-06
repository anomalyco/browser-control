# Browser Control

Browser Control is a local browser driver for trusted agents. It controls the
user's existing Chromium-family browser through a small MV3 extension shim and a
local Node relay.

## Source Of Truth

- Keep `PLAN.md` updated when architecture, scope, install flow, or product
  preferences change.
- Keep `CONTEXT.md` updated when domain language changes.
- Keep `skills/browser-control/SKILL.md` updated when the agent-facing workflow,
  commands, setup steps, or troubleshooting behavior changes, and sync it to
  `~/.config/opencode/skills/browser-control/skill.md`.
- `browser-control skill` must print the current `skills/browser-control/SKILL.md`
  text so another agent can fetch the installed workflow instructions.

## Architecture Invariants

### Driver & Relay Lifecycle

- Browser Control is a driver, not an LLM agent. Prefer the code-first
  `execute(code)` interface over adding narrow action commands.
- Use Effect v4 (`4.0.1`) for Node-side code, keeping `effect`,
  `@effect/platform-node`, and `@effect/platform-node-shared` pinned to the
  exact same version. Check `/Users/kit/code/open-source/effect` for Effect v4
  patterns. Prefer `Effect.fn` / `Effect.fnUntraced` and scoped lifecycles
  (`Effect.acquireRelease`, `Effect.scoped`). Read runtime configuration through
  Effect `Config`.
- Relay HTTP wire shapes live in `src/relay-schema.ts` (Effect Schema). The CLI,
  MCP server, and SDK talk to the relay only through `src/relay-client.ts`
  (`RelayClient.Service`), using `NodeHttpClient.layerNodeHttp` with
  `requestTimeout = 0` on the relay server so long `handoff()` and `secrets run`
  calls never hit `undici`'s 5-minute header timeout.
- Relay-backed CLI and MCP commands auto-start a detached relay when needed.
  `status`, `doctor`, `skill`, and `session_current` never contact or auto-start
  an absent relay.
- Ordinary CLI, MCP, and SDK calls never replace a running relay. Replacement
  requires `browser-control relay restart`, an exact managed instance, and safe
  shutdown protocol 2 (`RelayShutdown`). Record bounded attribution in
  `lifecycle.jsonl` without URLs, expressions, or credentials.

### Sessions, Target Ownership & CDP Routing

- Bare CLI `execute` atomically creates a fresh readable session id (e.g.
  `cosmic-otter-866`); `--session` or `BROWSER_CONTROL_SESSION` continues it.
  Human session commands persist their current id in `~/.browser-control/session.json`.
- Relay session descriptors persist per port under
  `~/.browser-control/relays/<port>/sessions.json`. After a relay restart,
  restore session ids, read-only mode, and exact target ownership when that tab
  reappears; JavaScript `state` and snapshot refs reset and warn.
- `TargetRegistry` is the sole live target-ownership authority. `CdpClientPool`
  owns per-client target announcements and aliases (`src/cdp-visibility.ts`):
  session-owned tabs are visible only to that session's clients; unowned tabs
  stay visible to everyone. Never broadcast session-owned targets to all clients.
- `RootTargetLifecycle` owns per-tab setup, verification, replacement
  generations, and scoped reconciliation workers. Store root page targets before
  applying `Target.setAutoAttach`. Forward dedicated `worker` targets, suppress
  page-scoped service workers, and replay stored child attaches + navigation for
  OOPIFs.
- `CdpRuntime` owns `Runtime.enable` context observation and bounded reset
  fallback. Client-side CDP aliases for already-announced root targets must route
  commands without a Chrome child `sessionId` (`chromeSessionIdForClientRequest`).
- `ProtectedFrameTracker` (`src/protected-frames.ts`) retracts and suppresses
  restricted child frames (`chrome-extension://` inline menus), marks
  `protectedUi` on the root target, and maps masked failures to
  `target/cross-extension-page` without replacing the page.
- `session adopt` makes a user-attached tab the session's default page (and
  auto-selects when only one user-attached tab is open). Adopted tabs are never
  closed by `reset` or `delete`.
- Never auto-collapse Browser Control tab groups (`collapsed: true`) in
  `extension/src/background.ts`. Auto-collapsing hides the open tab titles and
  favicons behind opaque group pills (making it hard for the user to see or find
  what tab is inside) and causes Chromium to throttle `requestAnimationFrame`
  and `IntersectionObserver` to 1 Hz inside collapsed groups.
- CDP guardrails (`src/cdp-guardrails.ts`) block destructive browser-state
  commands and reject `Input.*` in read-only sessions.

### Execute, Inspection, Handoffs & Proof Recording

- Execute results carry per-call `warnings` and `aftermath` (URL movement,
  navigations, console/page error counts, handoffs). Never add a passive
  `page.on("dialog")` listener (it suppresses Playwright's auto-dismiss).
- `snapshot()` refs (`e1..eN`) persist across compatible same-document captures
  and fail closed after main-frame navigation or incompatible DOM drift.
  `screenshotWithLabels()` also registers its `e1..eN` labels for `ref()`.
  `ariaSnapshot()` masks native text/range/editable values in Playwright's
  isolated world and must not run concurrently with other page operations.
- `handoff()` and `demonstrate()` bind to the exact Playwright `Page` target id
  and resolve only from the in-page completion control (`extension/src/content-script.ts`
  uses `__browser_control_*` shadow IDs and `aria-hidden` when passive so it
  never collides with page selectors or `getByRole("status")`).
- Allowed Playwright mouse actions reveal the on-page Ghost Cursor (`src/ghost-cursor.ts`),
  defaulting to `distance-glide` motion and `tactile-bloom` SVG variable-stroke
  click rings, driven by an unthrottled 60Hz timer loop. Proof overlays
  (`ghostCursor.caption`, `callout`, `spotlight`, `zoom`, `resetZoom`, `keys`)
  and the native Rust 60fps Steadicam compositor (`crates/bc-studio`) support
  high-craft proof videos.
- Relay-owned CDP recording (`src/recording-relay.ts`) uses `Page.startScreencast`,
  immediately acknowledges compositor frames, normalizes device pixels from the
  first frame's surface width, and streams timestamped Matroska frames to
  `ffmpeg` for constant 60 fps output. The flight recorder (`src/flight-recorder.ts`)
  maintains a bounded ring buffer for `save-last` clips.

## Development & Verification

- Run `pnpm check:locals` and `pnpm check:unused` (Knip) after TypeScript changes;
  run `pnpm audit:duplicates` during cleanups.
- Run `pnpm test` (Vitest) for unit tests in `test/` (browser-free) and
  `pnpm exec tsx scripts/check-snapshot.ts` for real-DOM `snapshot()`/`ref()`
  regressions.
- Prefer `pnpm gauntlet:isolated` for repeatable real-extension regressions, and
  use the project's `.opencode/skills/gauntlet/SKILL.md` workflow (**Gauntlet →
  Autoresearch → Simplify → Harvest**) when dogfooding navigation and API
  harvesting across live websites.
- Use `pnpm runtime:prepare --staging <fresh-dir> --install <fresh-dir>` and
  `pnpm runtime:select --install <validated-dir> --active <shared-symlink>` to
  deploy changes to `/Users/kit/.browser-control/current-runtime`, followed by
  `browser-control relay restart`.
- Run `pnpm build:extension` after `extension/src/` changes (replaces files in
  `extension/dist` in place without deleting the directory).

## Commands

```bash
pnpm check:locals && pnpm check:unused
pnpm test
pnpm build
pnpm runtime:prepare --help
pnpm runtime:select --help
browser-control status
browser-control doctor
browser-control relay restart
browser-control session new
browser-control session adopt
browser-control execute 'return { url: page.url(), title: await page.title() }'
browser-control recording start ./tmp/demo.mp4 --session <id> --mode cdp
browser-control recording stop --session <id>
browser-control skill
```
