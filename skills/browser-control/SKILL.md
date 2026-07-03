---
name: browser-control
description: Control the user's existing Chromium-family browser through the Browser Control extension and local relay. Use when asked to automate, test, inspect, or drive the visible browser with Browser Control, especially in this repo or once the extension is installed.
---

# Browser Control

Use Browser Control as a **driver**: run deterministic Playwright code against
the user's visible Chromium-family browser. Do not treat it as an autonomous
agent.

## Workflow

1. Start or reuse the relay.

```bash
cd /Users/kit/code/open-source/browser-control
browser-control --help
browser-control skill
browser-control serve
browser-control doctor
```

Completion criterion: the terminal shows
`browser-control relay listening at http://127.0.0.1:19989`.

If `browser-control` is not on PATH, run `bun link` from the repo root first.

`browser-control skill` prints this skill text from the installed package/repo.
Use it to verify another agent has the current Browser Control instructions.

2. Ensure the extension is connected.

```bash
browser-control doctor
browser-control doctor --json
browser-control status
browser-control status --json
browser-control session list
```

Completion criterion: `doctor` reports the relay as reachable and the extension
as connected. `status` also reports child target counts when OOPIF/iframe targets
are attached.

Use `browser-control doctor` before deeper debugging. It is read-only and checks
the package/bin metadata, relay HTTP endpoint, extension connection/version,
current and stale sessions, active and relay-owned targets, and built artifacts
such as `dist/cli.js`, `dist/mcp.js`, and `extension/dist/manifest.json`.

After extension shim changes, also confirm `version` matches
`extension/manifest.json`.

3. Attach a tab.

Click the Browser Control toolbar button on a normal web tab, or let the relay
create an initial tab when Playwright connects.

Completion criterion: `/extension/status` reports at least one active target, or
the execute smoke test succeeds.

4. Execute Playwright code.

```bash
browser-control execute "return { url: page.url(), title: await page.title() }"
browser-control execute "page.url()"
browser-control execute --file ./script.js
browser-control session new amazon
browser-control execute --session amazon "await page.goto('https://www.amazon.com')"
browser-control execute --target-url example.com "return page.url()"
browser-control execute --target-index 0 "return page.url()"
```

Use `page`, `context`, `browser`, relay-backed persistent `state`, and `fillInput`
inside execute code. If no session is provided, the CLI creates a readable session
id, stores it in `~/.browser-control/session.json`, and reuses it. Explicit
session ids from `--session`, `BROWSER_CONTROL_SESSION`, or MCP `execute({ session:
"id" })` must already exist; create them intentionally with `browser-control
session new <id>` or MCP `session_new`. Each session gets one owned default page
that persists across execute calls. If the stored current session no longer
exists on the relay (for example after a relay restart), execute recreates it
and prints a one-line stderr notice — the page and persistent `state` were
reset, so re-establish any context you relied on. For multi-field forms that wedge on repeated
locator-level DOM evaluation, use `fillInputs(page, fields)` to fill several
selectors in one page execution.

Single-expression snippets such as `page.url()` and `await page.title()` return
their value automatically; multi-statement scripts still require `return` for a
value. Use `browser-control execute --file <path>` for longer scripts instead of
embedding code in the shell. Do not pass both positional code and `--file`.
Execute responses include structured per-call script/page console logs and page
errors; human CLI output prints the returned value first, then logs, then any
warnings and a one-line aftermath summary when the page URL changed or the call
navigated, hit page errors, or paused for handoffs.

Use `browser-control execute --json` when you want to branch on the result: it
prints `{ ok, isError, text, value, valueUnavailable, error?: { _tag, message },
logs, warnings, aftermath, session }`. `value` is the structured JSON result of
the script (jq-able: `execute --json "({a: 1})" | jq .value.a` prints `1`);
`text` is the human-formatted rendering. `value` carries plain data only: objects,
arrays, and primitives round-trip; `Map` becomes a plain object, `Set` an
array, bigints strings. Class instances (Playwright `Page`, `Locator`, ...)
and results whose JSON exceeds 32KB are withheld: `value` is `null` and
`valueUnavailable` is `true` — fall back to `text`.
`aftermath` reports `startUrl`, `endUrl`, main-frame `navigations`,
`consoleErrorCount`, `pageErrorCount`, and `handoffs` for that one call.
Warnings are delivered with the call that caused them, for example when the
session default page was closed and recreated.

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
browser-control execute -s inspect-prod "await page.goto('https://example.com'); return await page.title()"
```

In a read-only session, Playwright actions like `locator.click()` keep retrying
the rejected input dispatch until their own timeout; pass a short `{ timeout }`
if you expect a click to be blocked. Note that `page.evaluate` can still mutate
the page via JavaScript; read-only guards trusted mistakes, not malicious code.

## Human Handoff

When a flow hits 2FA, CAPTCHAs, payment confirmation, or anything the user must
do personally, call `handoff(message, { timeoutMs })` inside execute code. It
shows a banner in the page, blocks the script, and resumes when the user clicks
the Browser Control toolbar button on the attached tab. Default timeout is 10
minutes; a timeout throws so the failure is explicit.

```js
await page.goto("https://accounts.example.com/login")
await fillInput("#email", "me@example.com")
await page.getByRole("button", { name: "Continue" }).click()
await handoff("Complete the 2FA prompt, then click the Browser Control toolbar button")
return await page.title()
```

Tell the user what you need before or while the handoff is pending. Handoffs are
counted in the result aftermath and recorded in the session journal. While a
script is executing, a toolbar click never detaches the tab; it resumes a
pending handoff instead.

## Session Journal

Every execute call is journaled to
`~/.browser-control/sessions/<id>/journal.jsonl` with a timestamp, the code, the
result status, duration, URL movement, warnings, and handoffs. Use it to audit
what an agent did to the browser or to debug a session after the fact:

```bash
browser-control journal
browser-control journal -s amazon --limit 50
browser-control journal -s amazon --json
```

For concurrent agents, create each explicit session first or let Browser Control
create the implicit current session automatically. Use `browser-control session
list` to see session-owned pages. `--target-url` and `--target-index` are manual
recovery selectors for adopting a specific attached page for one command. The same
selection can be supplied to scripts with `BROWSER_CONTROL_TARGET_URL` or
`BROWSER_CONTROL_TARGET_INDEX`. `--target-url` must match exactly one attached
page; use a more specific URL substring or `--target-index` if it matches multiple
pages. Do not set URL and index selectors together.

Prefer normal Playwright actions first:

```js
await page.getByRole("textbox", { name: "Email" }).fill("me@example.com")
```

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

To show a small cosmetic cursor overlay during visible actions, use the ghost
cursor helpers. The relay injects the overlay into attached pages and mirrors
`Input.dispatchMouseEvent` move/press/release commands into it while shown:

```js
await showGhostCursor()
await page.mouse.move(100, 120)
await page.getByRole("button", { name: "Submit" }).click()
await ghostCursor.hide()
```

Use `hideGhostCursor()` or `ghostCursor.hide()` to remove it. This does not start
recording or edit demo videos.

## Recording

Use `browser-control recording start <output-path>` to record an attached tab.
The default `--mode auto` keeps `chrome.tabCapture` for user-owned tabs and uses
CDP frame capture for relay-owned tabs, so session-created `bc-tab-*` pages can be
recorded without clicking the extension icon. Pass `--mode tab-capture` or
`--mode cdp` to force a mode.
The `--session` flag accepts either the Browser Control session id you use with
`execute` or the lower-level CDP `bc-tab-*` session id from `status --json`.

```bash
browser-control recording start ./tmp/demo-frames --session my-session --mode cdp
browser-control recording status --session my-session
browser-control recording stop --session my-session
```

`tab-capture` writes a WebM file and can include audio. `cdp` writes a directory
of JPEG frames plus `metadata.json`; it does not encode WebM or capture audio yet.

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

## Labeled Screenshots

Use `screenshotWithLabels({ page, path })` when a visual page read would help.
`path` must be absolute. The helper overlays simple `e1`, `e2`, ... labels on
visible likely-interactive elements, saves a Playwright screenshot, removes the
overlay, and returns `{ path, size, labelCount, labels }`.

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

Prefer `ariaSnapshot(target?)` for cheap read-before-act structure checks. It
returns Playwright's YAML aria snapshot for a selector, locator, or the whole
page (default `body`), so one call shows you whether a "tab bar" is really a
`<select>`, what a control's accessible name is, and which roles exist —
without burning a 30s locator timeout on a wrong `getByRole` guess:

```js
return await ariaSnapshot("main")
```

Use it before interacting with unfamiliar UI regions; use
`screenshotWithLabels` when you need visual layout rather than structure.

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

- `connected:false`: start the relay, wait for the extension reconnect loop, or
  reload the unpacked extension if shim code changed.
- `Target not found`: check `/extension/status`, then attach a tab or inspect
  relay logs.
- Extension changes not taking effect: rebuild `extension/dist` and reload the
  unpacked extension once.
- Repeated `hello` messages or in-flight RPC timeouts: check for duplicate shim
  websocket reconnects. The current shim version is `0.0.7`.
- Relay restarted while tabs were attached: shim `0.0.7` re-announces attached
  tabs after reconnecting, so the relay rebuilds its target registry without
  re-clicking the toolbar. If `activeTargets` stays 0 with an older shim,
  reload the unpacked extension and re-attach.
- Attached tabs group under a purple tab group titled `bc:<session-id>` for
  session-owned tabs (plain `browser-control` for user-attached tabs). The
  toolbar badge shows `ON` when attached, `RUN` while a script is executing, and
  `WAIT` while a handoff is pending. Badges beyond `ON` require shim `0.0.6`
  or newer; older shims still work but skip them.
- Active targets after an execute run are expected: relay-created tabs persist
  across short-lived CLI calls. Close the visible tab, call `await page.close()`,
  or detach it with the toolbar if you want `/extension/status` to return to zero.
- Clipboard failures on HTTP pages: prefer a secure origin and explicit browser
  permissions. DOM clicking alone may not update or expose clipboard contents.
- Login or password field fill timeouts: suspect installed browser extensions
  interfering with Playwright's native fill path. Try selector-based
  `fillInput(selector, value)` first, or `fillInput(locator, value)` after
  confirming the locator resolves.
- Ghost cursor overlay: use `showGhostCursor()`, `hideGhostCursor()`, or
  `ghostCursor.show/hide` inside execute code. It mirrors visible
  `Input.dispatchMouseEvent` move/press/release commands while shown and is
  overlay-only, not recording.
- Closed page during input on real-world React apps: suspect CDP session detach
  handling around `Target.detachFromTarget` / `Input.dispatchKeyEvent`. Reproduce
  with local smoke fixtures before changing unrelated locator code, then compare
  against the real-world page after accounting for browser extension interference.
- Missing iframe after reconnect: run `SMOKE_CASE=oopif-reconnect pnpm smoke`.
  Browser Control should replay stored child target attaches and current child
  frame navigation for the current OOPIF canary.
- Long-running relay testing: use `termctrl start browser-control-relay --cwd
  "/Users/kit/code/open-source/browser-control" --cols 120 --rows 24 --
  browser-control serve`.
