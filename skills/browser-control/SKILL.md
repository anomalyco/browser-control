---
name: browser-control
description: Control the user's existing Chromium-family browser through the Browser Control extension and local relay. Use when asked to automate, test, inspect, or drive the visible browser with Browser Control, especially in this repo or once the extension is installed.
---

# Browser Control

Use Browser Control as a **driver**: run deterministic Playwright code against
the user's visible Chromium-family browser. Do not treat it as an autonomous
agent.

## Workflow

1. Run the first task directly.

```bash
browser-control --help
browser-control execute 'return { url: page.url(), title: await page.title() }'
```

Relay-backed commands start a detached relay when needed and wait briefly for
the extension to reconnect. Do not start `browser-control serve` first; it is
the foreground debugging path and intentionally does not return.
CLI and MCP share this detached relay; restarting the MCP process does not stop
the relay or interrupt a CLI execute or pending handoff.

If `browser-control` is not on PATH, install it with `npm install --global
@opencode-ai/browser-control`. Use the source setup in the repository README only
when developing Browser Control itself.

`browser-control skill` prints this skill text from the installed package/repo.
Use it to verify another agent has the current Browser Control instructions.

Completion criterion: execute returns a page result and a readable session id
with the exact `--session` continuation command.

2. Inspect health only when setup or runtime behavior is unclear.

```bash
browser-control doctor
browser-control doctor --json
browser-control status
browser-control status --json
browser-control session list
```

`status` and `doctor` are read-only and never start the relay. A stopped `status`
prints one concise next step instead of a stack trace. When running, `status`
reports relay build compatibility, extension connectivity, sessions, targets,
child target counts, and `crashed=true` for known crashed targets.

Use `browser-control doctor` before deeper debugging. It is read-only and checks
the package/bin metadata, relay HTTP endpoint, extension connection/version,
current and stale sessions, active, relay-owned, crashed, and browser-error
targets, whether the running relay matches the current CLI build, and built
artifacts such as `dist/cli.js`,
`dist/mcp.js`, and `extension/dist/manifest.json`. Relay-backed commands reject
a stale relay build with a concise restart message.

After extension shim changes, also confirm `version` matches
`extension/manifest.json`.

3. Create once, then continue the named session.

Bare execute always creates a fresh isolated session and prints `Continue with
--session <id>`. Every later shell call must pass that id (or set
`BROWSER_CONTROL_SESSION`). No toolbar attachment is required.

To control a tab already open in the user's browser, ask the user to click the
Browser Control toolbar button on that tab, then select it while creating a new
session or adopt it for sticky reuse:

```bash
browser-control execute --target-url example.com 'return page.url()'
browser-control session adopt --target-url example.com
```

4. Execute Playwright code.

```bash
# Creates a fresh session and prints its id.
browser-control execute 'return { url: page.url(), title: await page.title() }'
# Continue only with that returned id.
browser-control execute --session cosmic-otter-866 'page.url()'
browser-control execute --session cosmic-otter-866 --file ./script.js
browser-control session new amazon
browser-control execute --session amazon 'await page.goto("https://www.amazon.com")'
browser-control execute --target-url example.com 'return page.url()'
browser-control execute --target-index 0 'return page.url()'
```

Use `page`, `context`, `browser`, relay-backed persistent `state`, and `fillInput`
inside execute code. Without a session, CLI execute atomically creates a fresh
one and returns its id without reading or writing shared current-session state.
Explicit ids from `--session`, `BROWSER_CONTROL_SESSION`, or MCP `execute({
session: "id" })` must already exist. Each session gets one owned default page
that persists across named execute calls. MCP keeps its own process-local current
session because the MCP process itself is the agent boundary.

Create an explicit id with `session_new` first. With MCP, omit the id to let the
server establish its process-local current session. `targetUrl` and
`targetIndex` only select pages that already exist in
the attached page pool; they never navigate or create a page. Use `page.goto()`
to open a URL in a session-owned page, or attach an existing user tab with the
toolbar before selecting or adopting it.

The sandbox also exposes Node modules both through `modules` and convenient
aliases such as `fs` and `path`. Execute code runs in its own lexical scope, so
scripts may safely declare local names such as `const path = ...` without
colliding with those aliases.

MCP `execute` extracts returned screenshot buffers, including buffers nested in
objects and arrays, into ordered native image attachments without temporary
files. This lets one call return images plus metadata. A screenshot saved to a
path but not returned remains file-only. `snapshot()` remains the preferred
compact textual read; request images only when visual layout matters.

Bare execute drives its new session-owned page, never the user's attached tabs. To
drive a tab the user attached with the toolbar, adopt it as the session's
default page:

```bash
browser-control session adopt --target-url opencode-agent
browser-control session adopt --target-index 0 -s my-session
```

Adoption is sticky: later executes reuse the adopted tab. Adopting closes the
session's previous relay-created page; session reset/delete releases an adopted
tab but never closes it. MCP exposes the same operation as `session_adopt`.
When a bare execute has to create a fresh page while a user-attached tab is
open, the result includes a warning tip suggesting the adopt command —
that is the "why did a new tab appear?" moment. `--target-url`/`--target-index`
on execute itself remain one-command selections, not sticky adoption. For multi-field forms that wedge on repeated
locator-level DOM evaluation, use `fillInputs(page, fields)` to fill several
selectors in one page execution.

For authentication already established in a user-attached tab, prefer
`execute --target-url <unique-url-part>` for one command or `session adopt
--target-url <unique-url-part>` for sticky reuse rather than reproducing login in
a fresh relay-owned tab. After navigation or `handoff`, verify the expected URL
or a stable element before entering data or continuing.

Single-expression snippets such as `page.url()` and `await page.title()` return
their value automatically; multi-statement scripts still require `return` for a
value. Use `browser-control execute --file <path>` for longer scripts instead of
embedding code in the shell. Prefer single-quoted shell arguments with
double-quoted JavaScript strings so `$`, backticks, and `!` are not expanded by
the shell. If the script itself needs shell single quotes, use `--file`. Do not
pass both positional code and `--file`.
Execute responses include structured per-call script/page console logs and page
errors; human CLI output prints the returned value first, then logs, then any
warnings and a one-line aftermath summary when the page URL changed or the call
navigated, hit page errors, or paused for handoffs.

Use `browser-control execute --json` when you want to branch on the result: it
prints `{ ok, isError, text, value, valueUnavailable, error?: { _tag, message },
logs, warnings, diagnostic?, aftermath, session }`. `value` is the structured JSON result of
the script (jq-able: `execute --json '({a: 1})' | jq .value.a` prints `1`);
`text` is the human-formatted rendering. `value` carries plain data only: objects,
arrays, and primitives round-trip; `Map` becomes a plain object, `Set` an
array, bigints strings. Class instances (Playwright `Page`, `Locator`, ...)
and results whose JSON exceeds 32KB are withheld: `value` is `null` and
`valueUnavailable` is `true` — fall back to `text`.
`aftermath` reports `startUrl`, `endUrl`, main-frame `navigations`,
`consoleErrorCount`, `pageErrorCount`, and `handoffs` for that one call.
Recurring permissions-policy warnings and blocked analytics resources are folded
into representative log entries, while application errors stay distinct and
aftermath error counts continue to include every event. Warnings are delivered
with the call that caused them, for example when the session default page was
closed, crashed, or recreated. After an execution-context failure or crash,
the next normal execute gives the default page a one-second health check. An
unhealthy relay-owned page is recreated after it closes; a close failure gives
reset guidance instead of leaking the old tab. An unhealthy adopted tab is
preserved and the call fails quickly with reset/adopt guidance. Failed
execution-context calls also carry a short fixed diagnostic classification with page/navigation
counts; cross-extension navigation failures use
`target/cross-extension-page`. Diagnostics never include evaluation arguments
or results.

Playwright downloads are not available through extension-backed tabs. Chromium
blocks both `Browser.setDownloadBehavior` and the legacy
`Page.setDownloadBehavior` through `chrome.debugger`, so
`page.waitForEvent("download")` rejects immediately with a capability error
instead of timing out and `download.saveAs()` cannot receive an artifact. When
the page exposes the payload through fetch or an API response, read those bytes
in the page and write them with the sandbox's `fs` module instead.

## Guardrails And Read-Only Sessions

The relay always blocks CDP commands that would destroy the user's real browser
state: `Network.clearBrowserCookies`, `Network.clearBrowserCache`,
`Storage.clearCookies` (which backs `context.clearCookies()`), and
`Browser.close`. Scripts that call them fail with a clear error; never try to
work around this.

For inspect-only tasks, create a read-only session. The relay rejects
input-dispatching CDP (`Input.*`) for it, so scripts can navigate, read, and
screenshot but not click or type:

```bash
browser-control session new inspect-prod --read-only
browser-control execute -s inspect-prod 'await page.goto("https://example.com"); return await page.title()'
```

In a read-only session, Playwright actions like `locator.click()` keep retrying
the rejected input dispatch until their own timeout; pass a short `{ timeout }`
if you expect a click to be blocked. Note that `page.evaluate` can still mutate
the page via JavaScript; read-only guards trusted mistakes, not malicious code.

## Human Handoff

When a flow hits 2FA, CAPTCHAs, payment confirmation, or anything the user must
do personally, call `handoff(message, { timeoutMs })` inside execute code. It
shows the message and an accessible **I'm done, continue** control in the page,
blocks the script, and resumes only when the user activates that control. The
WAIT UI survives top-level navigation and ambiguous extension child-target
closures. Actual tab removal cancels the handoff explicitly. Default timeout is
10 minutes; a timeout throws so the failure is explicit.

```js
await page.goto("https://accounts.example.com/login")
await fillInput("#email", "me@example.com")
await page.getByRole("button", { name: "Continue" }).click()
await handoff("Complete the 2FA prompt, then use the in-page continue control")
if (!page.url().startsWith("https://app.example.com/")) {
  throw new Error(`2FA did not reach the app: ${page.url()}`)
}
await page.getByRole("heading", { name: "Dashboard" }).waitFor()
return await page.title()
```

Tell the user what you need before or while the handoff is pending. Handoffs are
counted in the result aftermath and recorded in the session journal. Human
acknowledgment is not proof that the task succeeded: always assert the expected
URL or element after `handoff` before continuing. A toolbar click never resumes
a handoff and does not detach its tab while the execute call is active.

## Session Journal

Every execute call is journaled to
`~/.browser-control/sessions/<id>/journal.jsonl` with a timestamp, the code, the
result status, duration, URL movement, warnings, handoffs, and any bounded
execution-context failure diagnostic. Use it to audit
what an agent did to the browser or to debug a session after the fact:

```bash
browser-control journal -s amazon --limit 50
browser-control journal -s amazon --json
```

For concurrent agents, let each agent's first bare execute create a fresh session,
then require that agent to retain and pass its returned id. Use `browser-control
session list` to see session-owned pages. `--target-url` and `--target-index` are manual
recovery selectors for adopting a specific attached page for one command. The same
selection can be supplied to scripts with `BROWSER_CONTROL_TARGET_URL` or
`BROWSER_CONTROL_TARGET_INDEX`. `--target-url` must match exactly one attached
page; use a more specific URL substring or `--target-index` if it matches multiple
pages. Do not set URL and index selectors together.

Prefer normal Playwright actions first:

```js
await page.getByRole("textbox", { name: "Email" }).fill("me@example.com")
```

Inspect before acting. Start with `snapshot()` and use `ariaSnapshot()` when the
compact view omits the structure you need; do not spend a default 30-second
locator timeout testing a guessed role or selector. Use a short exploratory
timeout, inspect the current page after a miss, and only then choose the stable
locator. After a click that navigates, verify the destination URL or a stable
element before filling the next document. If execution-context diagnostics
repeat, stop changing selectors and investigate page/session health instead.

For visual verification, return screenshot buffers through MCP so the image is
actually attached and inspectable. Saving a screenshot to a path and returning
only `"ok"` proves that capture completed, not that the layout looks correct.
Report exactly the viewport, state, and interaction path tested; do not describe
a synthetic browser fixture as broad end-to-end or physical-device coverage.

If normal `locator.fill()` hangs on login/password-style fields in the user's
existing browser, use the explicit DOM-input fallback:

```js
await fillInput("#user-name", "standard_user")
await fillInput(page.getByPlaceholder("Username"), "standard_user")
await fillInputs(page, [
  { selector: "#first-name", value: "Kit" },
  { selector: "#last-name", value: "BrowserControl" },
])
```

This is useful when installed browser extensions, such as password managers,
interfere with Playwright's focus/fill machinery. It sets the value and dispatches
`input` and `change` events; it is only for `input` and `textarea` locators.

Allowed Playwright mouse actions automatically show a spring-animated arrow cursor that
fades after idle time. The relay mirrors successful `Input.dispatchMouseEvent`
move/press/release commands; blocked read-only input never renders the cursor.
Use the helpers to keep it visible, customize it, or disable it for the current
document:

```js
await page.goto("https://example.com")
await page.mouse.move(100, 120)
await page.getByRole("button", { name: "Submit" }).click()
await showGhostCursor({ size: 20 })
await ghostCursor.hide()
```

`showGhostCursor()` / `ghostCursor.show()` enters persistent mode.
`hideGhostCursor()` / `ghostCursor.hide()` disables the cursor until the page's
next document. Recording does not change cursor mode, and the cursor does not
start or edit recordings.

## Recording

Use `browser-control recording start <output-path>` to record an attached tab.
The default `--mode auto` keeps `chrome.tabCapture` for user-owned tabs and uses
timestamped CDP screencasting for relay-owned tabs, so session-created `bc-tab-*`
pages can be recorded without clicking the extension icon. CDP mode requires
`ffmpeg` on `PATH`, accepts `.webm` or `.mp4`, defaults to 25 fps, and bounds
the active viewport within 1280×720. It activates the recorded tab because
Chromium throttles compositor frames in background tabs. `tab-capture` output
must end in `.webm`; pass `--mode cdp` for `.mp4` or to force CDP on a
user-owned tab.
The `--session` flag accepts either the Browser Control session id you use with
`execute` or the lower-level CDP `bc-tab-*` session id from `status --json`.

```bash
browser-control recording start ./tmp/demo.mp4 --session my-session --mode cdp
browser-control recording status --session my-session
browser-control recording stop --session my-session
```

`tab-capture` writes a WebM file and can include audio. `cdp` writes WebM or MP4
plus a `.json` metadata sidecar with source, encoded, coalesced, and dropped
frame counts; it does not capture audio.

Session-owned pages stay attached and visible so repeated shell commands reuse the
same browser state. Use `browser-control session reset` or
`browser-control session delete` to close a session-owned page and clear its
state. Close manually attached tabs normally, call `await page.close()`, or detach
with the toolbar when you want to release them.

For multi-step UI tasks, prefer one `execute` block when the steps depend on
transient page state such as selected rows, open menus, dialogs, hover state, or
in-progress form edits. Persistent tabs preserve navigation and DOM state between
commands, but a single script is safer when one action creates the exact UI state
that the next action must consume.

## Authenticated Network Capture

Use network capture when repeated direct HTTP calls would be faster and more
reliable than driving the browser every time. Browser Control records normalized
Playwright request/response exchanges itself; HAR is only the interoperable
export format.

Start from a logged-in session, then exercise each client flow at least twice
with different inputs so constants and parameters can be distinguished:

```bash
browser-control network start --session github --url /api/ \
  --resource-type fetch --resource-type xhr
browser-control execute --session github --file ./perform-flow.js
browser-control network status --session github
browser-control network stop --session github \
  --output ./github.har --secrets github
```

Captures span execute calls and handoffs and follow the session's default page
when it is adopted or recovered. Bodies default to `embed`; use `--content omit`
when shapes are unnecessary. The defaults cap each body at 1 MB, total retained
body data at 25 MB, and entries at 1000. Status and stop results report body
bytes, truncations, failures, and dropped entries without captured values.
JSON, URL-encoded forms, and text-only multipart forms are exported with
credential substitution. Opaque, malformed, file-bearing multipart, binary, and
truncated bodies are omitted and counted as truncated rather than written
without reliable redaction.
Response bodies also require an uncompressed declared `Content-Length` within
the remaining budgets; unknown-length or compressed bodies are omitted rather
than materialized without a memory bound.

Written artifacts are safe by default: credential-bearing headers, cookies,
token-like query parameters, and structured body fields become literal stable
references such as `${BC_SECRET_1}`. `--secrets github` stores the original
values separately in `~/.browser-control/secrets/github.json` with mode `0600`.
Never copy profile values into generated source, output, diagnostics, or a
session journal.
While capture is active, Browser Control also substitutes values observed in
completed exchanges and removes secret-shaped returned fields from execute
results, logs, URLs, and journal records. Do not deliberately return or log
credentials; this redaction is a final safety boundary, not a secret-inspection
interface.

Inspect the HAR offline to identify first-party JSON endpoints, request
dependencies, response shapes, pagination, and required headers. Generate one
typed function per observed flow. Generated code reads the exact `BC_SECRET_N`
environment variables referenced by the artifact and gives a concise refresh
instruction on 401/403. Verify every generated function with a harmless live
request before declaring the client complete.

Run a generated client without exposing credential values:

```bash
browser-control secrets status github
browser-control secrets run github -- ./github-cli repositories
```

Browser Control injects the profile as environment variables and replaces known
values in bounded child stdout/stderr with their references. Do not print the
environment variables in generated code; redaction is defense in depth, not an
invitation to log credentials.

For credentials normally renewed by a page reload:

```bash
browser-control secrets refresh github --session github --url /api/
```

Refresh preserves a reference when the credential observed at that source
changes, and succeeds when a still-valid value is observed unchanged. If the
site requires login, 2FA, or another human action instead, reauthenticate in the
adopted tab and repeat `network start`/`network stop --secrets github`; the same
source-based refresh behavior applies.

Execute code has equivalent `network.start(options)`, `network.status()`,
`network.stop({ outputPath, secrets })`, and `network.cancel()` helpers. MCP
provides `network_start`, `network_status`, `network_stop`, `network_cancel`,
`secrets_status`, `secrets_refresh`, and `secrets_run` over the same recorder and
profile store.
Pass an absolute `outputPath` from execute code (use the provided `path.resolve`)
so artifact location does not depend on the detached relay's original working
directory. CLI and MCP resolve relative output and child-command paths against
their caller process working directory before contacting the relay.

## Labeled Screenshots

Use `screenshotWithLabels({ page, path? })` when a visual page read would help.
The helper overlays simple `e1`, `e2`, ... labels on visible likely-interactive
elements, captures a Playwright screenshot, removes the overlay, and returns
image plus label metadata. Omit `path` and return the result through MCP for an
in-memory attachment; when supplied, `path` must be absolute and the image is
saved instead.

```js
const screenshotPath = path.resolve("tmp/home-labels.png")
return await screenshotWithLabels({ page, path: screenshotPath })
```

Labels cover a small DOM-only set: buttons, links, inputs, textareas, selects,
`role=button/link/tab/menuitem`, `[onclick]`, and `[contenteditable]`. Each
label entry carries its `ref` (`e1`, `e2`, ...), a `selector` for the next
Playwright locator, and, when ambiguous, a short `context` string from the
nearest row/section/heading so identical buttons (five "Connect" buttons in
five integration rows) are distinguishable without another round-trip.

## Accessibility Snapshot

Prefer `snapshot()` for the compact read-before-act happy path. It uses the
page's single `main` region when available, collapses navigation, and spends its
bounded item budget on alerts, semantic groups, lists, tables, block code,
headings, primary links, and controls before repeated metadata. It summarizes
select option counts, pairs table headers with row cell values, and assigns refs
to controls. Its timeout defaults to 10 seconds to accommodate a cold first
browser evaluation. Text input and textarea values are omitted:

```js
return await snapshot()
```

Use a returned ref on the next execute call as a Playwright locator:

```js
await ref("e12").click()
```

Refs belong to the latest snapshot and are rejected after main-frame navigation.
They combine structural position with captured accessible identity, so sibling
DOM drift fails closed instead of silently retargeting a different named control.
Drill into omitted context with `snapshot({ within, interactive, compact, depth,
maxItems, timeout })`.

After a full snapshot establishes a baseline, use `snapshot({ diff: true })`
with the same page and shape options to return only semantic additions and
removals plus an unchanged count:

```js
await ref("e12").click()
return await snapshot({ diff: true })
```

Each successful diff becomes the next baseline. A diff invalidates earlier refs
and assigns current refs only to added or changed lines. Take another full
snapshot before acting on an unchanged element.

Use `ariaSnapshot(target?, { timeout })` when the compact view omitted needed
structure. It defaults to a 5-second timeout and
returns Playwright's YAML aria snapshot for a selector, locator, or the whole
page (default `body`), so one call shows you whether a "tab bar" is really a
`<select>`, what a control's accessible name is, and which roles exist —
without burning a 30s locator timeout on a wrong `getByRole` guess:

```js
return await ariaSnapshot("main", { timeout: 10_000 })
```

Omit the options for the 5-second default, or override `timeout` in milliseconds
for a deliberately slow region. Use `screenshotWithLabels` when you need visual
layout rather than structure, and raw Playwright when neither snapshot shape is
specific enough.

## Destructive UI Recipe

For destructive UI work, such as deleting drafts when no CLI/API command exists,
use a two-phase read-confirm-verify flow. Do not confirm destructive actions in
the same script that first discovers candidates unless the user already approved
the exact stable identifiers/text.

Phase 1 inspects candidates and returns exact row text/IDs for user approval:

```js
await page.goto("https://example.com/items", { waitUntil: "domcontentloaded" })
await page.waitForTimeout(3000)

const rows = await page.locator("[role=row], tr").evaluateAll((nodes) => {
  return nodes.map((node, index) => ({
    index,
    text: (node.textContent || "").replace(/\s+/g, " ").trim(),
  })).filter((row) => row.text.includes("Draft"))
})

return { url: page.url(), title: await page.title(), rows }
```

Phase 2 acts only on approved rows. Scope clicks from stable row text or IDs, read
the confirmation dialog, and throw unless the dialog matches the approved action:

```js
const approvedTexts = ["Draft invoice A $10.00", "Draft invoice B $20.00"]

for (const approvedText of approvedTexts) {
  const row = page.locator("[role=row], tr").filter({ hasText: approvedText })
  if (await row.count() !== 1) {
    throw new Error(`Expected exactly one row for ${approvedText}`)
  }
  await row.locator("input[type=checkbox], [role=checkbox]").first().click()
}

const selected = await page.locator("input[type=checkbox]").evaluateAll((nodes) => {
  return nodes.map((node, index) => ({ index, checked: node instanceof HTMLInputElement && node.checked }))
    .filter((item) => item.checked)
})
if (selected.length !== approvedTexts.length) {
  throw new Error(`Expected ${approvedTexts.length} selected rows, got ${selected.length}`)
}

await page.getByRole("button", { name: /delete/i }).click()

const dialogText = await page.locator("[role=dialog], [aria-modal=true]").innerText()
if (!dialogText.includes(String(approvedTexts.length)) || !dialogText.match(/delete/i)) {
  throw new Error(`Unexpected confirmation dialog: ${dialogText}`)
}

await page.getByRole("button", { name: /delete|confirm/i }).last().click()
await page.waitForTimeout(1000)

return { approvedTexts, selected, dialogText, url: page.url() }
```

After confirming in the UI, verify independently with a fresh read path, such as
the app's list page, a CLI/API command, or a second `browser-control execute` that
reloads the page and checks the target rows are gone.

Never globally auto-accept native browser dialogs. If a native alert/confirm/prompt
is expected, use `page.waitForEvent("dialog")`, assert `dialog.type()` and exact
`dialog.message()`, then accept only that dialog.

## Iteration Rule

The extension is a stable Chrome API shim. Prefer changing relay code over
extension code. Relay-only changes should require restarting `serve`, not
reloading the browser extension.

If `extension/src/background.ts`, `src/protocol.ts`, or extension build config
changes, run:

```bash
pnpm build:extension
```

Then reload the unpacked extension once in Brave.

The relay/extension protocol is a small custom JSON-over-websocket protocol. The
Node relay uses Effect for orchestration, but the MV3 shim does not use Effect RPC
unless a future protocol-versioning need justifies it.

## Keep Docs Synced

When architecture, commands, install flow, troubleshooting, or agent-facing
behavior changes, update this file and `PLAN.md` in the same change. When domain
language changes, update `CONTEXT.md` too.

## Troubleshooting

- `connected:false`: run a relay-backed command to auto-start the relay, then
  reload the unpacked extension if its reconnect loop does not recover.
- `Target not found`: check `/extension/status`, then attach a tab or inspect
  relay logs.
- Extension changes not taking effect: rebuild `extension/dist` and reload the
  unpacked extension once.
- Repeated `hello` messages or in-flight RPC timeouts: check for duplicate shim
  websocket reconnects. The current shim version is `0.0.17`.
- Relay restarted while tabs were attached: shim `0.0.7`+ re-announces attached
  tabs after reconnecting, so the relay rebuilds its target registry without
  re-clicking the toolbar. If `activeTargets` stays 0 with an older shim,
  reload the unpacked extension and re-attach.
- All tabs suddenly detached (`activeTargets: 0`) while the browser looks fine:
  the user probably dismissed the "is being debugged" banner, which detaches
  chrome.debugger from every tab at once. Re-attach via the toolbar (or
  `session adopt` after re-attaching).
- Control group: shim `0.0.16`+ puts session-owned tabs, including adopted user
  tabs, in a purple `control` group within each browser window. Merely attached
  tabs remain where the user put them. Reset, delete, or re-adoption releases an
  adopted tab from the group without closing it. Legacy `browser-control`,
  `bc:*`, and `bc · *` groups remain recognized for cleanup.
- Full session ids remain in CLI status, journals, and in-page accessibility
  text. The toolbar badge shows `ON` when attached, `RUN` while a mutable session executes,
  and `WAIT` while a handoff is pending. Read-only execution stays quietly `ON`.
  Badges beyond `ON` require shim `0.0.6`
  or newer. The explicit in-page handoff completion control and navigation
  reinjection require shim `0.0.10`; cursor-anchored handoff prompts require
  `0.0.15`.
- Active targets after an execute run are expected: relay-created tabs persist
  across short-lived CLI calls. Close the visible tab, call `await page.close()`,
  or detach it with the toolbar if you want `/extension/status` to return to zero.
- Clipboard failures on HTTP pages: prefer a secure origin and explicit browser
  permissions. DOM clicking alone may not update or expose clipboard contents.
- Download waits fail with a direct capability error: Chromium does not expose
  download artifact control through an extension's `chrome.debugger` tab
  attachment. Prefer fetching the payload and writing it with `fs`; do not wait
  for a Playwright download event or retry the click.
- Login or password field fill timeouts: suspect installed browser extensions
  interfering with Playwright's native fill path. Try selector-based
  `fillInput(selector, value)` first, or `fillInput(locator, value)` after
  confirming the locator resolves.
- Ghost cursor overlay: allowed Playwright mouse actions show it automatically,
  and it fades when idle. Use `showGhostCursor()`, `hideGhostCursor()`, or
  `ghostCursor.show/hide` for persistent/customized or disabled behavior.
  Read-only input is rejected before rendering; recording does not change mode.
- Closed page during input on real-world React apps: suspect CDP session detach
  handling around `Target.detachFromTarget` / `Input.dispatchKeyEvent`. Reproduce
  with local smoke fixtures before changing unrelated locator code, then compare
  against the real-world page after accounting for browser extension interference.
- Missing iframe after reconnect: run `SMOKE_CASE=oopif-reconnect pnpm smoke`.
  Browser Control should replay stored child target attaches and current child
  frame navigation for the current OOPIF canary.
- Repeated `Execution context was destroyed` failures: run one short follow-up
  execute so Browser Control can health-check the default page. A relay-owned
  page is recreated automatically; reset or re-adopt an unhealthy user-owned
  tab because Browser Control will not replace it. If failures continue,
  restart the relay with `BROWSER_CONTROL_DEBUG=1` before reproducing. `[bc:ctx]`
  lines contain bounded metadata only: target/context IDs, ownership, loader changes, URL origin/shape
  plus fingerprint, reset outcomes, and evaluate shape/failure class. They never
  include expressions, arguments, results, headers, cookies, or form values.
- Long-running relay testing: from the repository root, use `termctrl start
  browser-control-relay --cwd "$PWD" --cols 120 --rows 24 --
  browser-control serve`.
- Bursty navigation to the same heavyweight origin: if several fresh sessions
  all stall before commit while other origins work, serialize those navigations
  or give `page.goto` a deliberate longer timeout. Browser Control preserves raw
  Playwright navigation semantics rather than adding hidden retries.
