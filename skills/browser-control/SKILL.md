---
name: browser-control
description: Drive the user's existing Chromium-family browser with deterministic Playwright. Use when asked to inspect, automate, test, or interact with a visible browser tab; continue an authenticated browser workflow; handle 2FA, passkeys, CAPTCHAs, or payment confirmation; record browser behavior; or capture an authenticated network flow.
---

# Browser Control

Browser Control is a **driver**, not an agent. The calling agent decides what to
do; Browser Control runs deterministic Playwright code in the user's visible
browser.

Use one loop throughout: **inspect, act, verify**. Inspect the real page before
choosing locators, act through the narrowest stable control, then verify the
result through a URL or fresh page read. Never treat a successful click or human
acknowledgment as proof that the task succeeded.

## Core Workflow

### 1. Run The Task Directly

Start with the requested browser work. Relay-backed commands start the detached
relay and wait for the extension; do not start `browser-control serve` first.

```bash
browser-control execute 'return { url: page.url(), title: await page.title() }'
```

Use `browser-control doctor` only when setup or runtime behavior is unclear.
`status` and `doctor` are observational and never start the relay.

```bash
browser-control doctor
browser-control status --json
```

Completion: one execute returns a page result and a readable session id, or
`doctor` identifies the concrete setup failure.

### 2. Choose The Page Deliberately

A bare CLI execute creates a fresh session-owned page and prints the exact
`--session <id>` continuation command. Every later CLI call must pass that id or
set `BROWSER_CONTROL_SESSION`; bare execute never guesses from human-shell
current state.

```bash
browser-control execute 'return page.url()'
browser-control execute --session cosmic-otter-866 'return page.url()'
```

MCP keeps one implicit process session. Omit `session` for that normal path, or
call `session_new` and pass an explicit id when one MCP process needs multiple
sessions.

To control a tab already open in the user's browser, ask the user to click the
Browser Control toolbar button on that tab. Select it for one execute or adopt
it for sticky reuse:

```bash
browser-control execute --target-url github.com 'return page.url()'
browser-control session adopt --target-url github.com --session github
```

`targetUrl` and `targetIndex` select existing attached pages; they never
navigate. A URL selector must match exactly one page, and URL and index selectors
cannot be combined. Adoption makes that tab the session default, closes the
session's previous relay-created page, and is exclusive to one Browser Control
session. Reset or delete releases an adopted user tab without closing it.

Prefer adoption for authenticated browser state rather than reproducing login
in a fresh page.

Completion: the selected page URL is the intended page, and later work either
retains the returned session id or intentionally uses the MCP process session.

### 3. Inspect, Act, Verify

Inspect before guessing roles or selectors:

```js
return await snapshot()
```

Then act from the returned structure and verify the destination:

```js
await ref("e12").click()
await page.getByRole("heading", { name: "Settings" }).waitFor()
if (!page.url().includes("/settings")) {
  throw new Error(`Unexpected destination: ${page.url()}`)
}
return { url: page.url(), heading: await page.getByRole("heading").first().innerText() }
```

Use normal Playwright first. Keep dependent interactions in one execute when
they rely on transient UI such as an open menu, selected rows, hover state, or
an in-progress form.

If native `locator.fill()` hangs because a browser extension interferes with
focus, use the explicit `input`/`textarea` fallback:

```js
await fillInput(page.getByPlaceholder("Username"), "standard_user")
```

Completion: the final return value contains evidence of the requested outcome,
not merely evidence that an action was attempted.

### 4. Continue Or Finish Cleanly

Named sessions preserve their default page across short-lived CLI and MCP
processes. They also survive relay restarts: Browser Control restores the id,
read-only mode, and exact default target. JavaScript `state` and snapshot refs
are process-local and reset after a relay restart with an explicit warning.

```bash
browser-control session list
browser-control session reset github
browser-control session delete github
```

Every execute is journaled under
`~/.browser-control/sessions/<id>/journal.jsonl`. The journal records code,
status, duration, URL movement, warnings, handoffs, and bounded diagnostics.
Never place credentials directly in execute source.

```bash
browser-control journal --session github --limit 50
```

Completion: retain the session only when follow-up work is expected; otherwise
reset or delete session-owned pages and report any warnings that affect later
work.

## Canonical Authenticated Flow

The distinguishing Browser Control workflow is an authenticated tab plus a
human-only prompt:

Attach and adopt the existing tab, inspect its real UI, fill ordinary fields,
then register `handoff` before triggering WebAuthn, 2FA, CAPTCHA, or payment UI.
After the user completes it, verify the authenticated destination. The same
session can continue after an MCP process or relay restart.

When the prompt-triggering action may itself block, put only that action in
`start`. Browser Control presents and acknowledges WAIT before invoking it:

```js
await handoff("Complete the security-key prompt, then continue", {
  timeoutMs: 600_000,
  start: () => page
    .getByRole("button", { name: /passkey|security key|sign in/i })
    .click({ timeout: 600_000 }),
})

await page.waitForURL((url) => !url.pathname.startsWith("/login"))
await page.getByRole("heading", { name: /account|dashboard/i }).waitFor()
return { authenticatedUrl: page.url(), title: await page.title() }
```

Tell the user what action is waiting. Human acknowledgment is not verification:
always assert the expected URL or stable element after `handoff`. If the action
was already completed and only the human step remains, call `handoff(message)`
without `start`. The default timeout is ten minutes.

Completion: the prompt was presented only after WAIT was registered, the action
settled, and the authenticated result was independently verified.

## Inspection Tools

Use the least expensive view that answers the question:

- `snapshot()` is the compact read-before-act default. It prioritizes semantic
  groups, alerts, lists, tables, headings, links, and controls. Text input and
  textarea values are omitted.
- `ref("e12")` resolves a control from the latest snapshot. Refs fail closed
  after navigation or incompatible DOM drift.
- `snapshot({ diff: true })` reports semantic changes from the compatible prior
  baseline. A diff invalidates earlier refs and exposes refs only for added or
  changed current lines.
- `ariaSnapshot(target?, { timeout })` returns Playwright's detailed YAML aria
  tree when the compact snapshot omits needed structure.
- `screenshotWithLabels({ page, path? })` adds visual labels and metadata when
  layout matters.

```js
return await snapshot({ within: "main", maxItems: 200 })
// When layout matters, return the image through MCP so it can be inspected.
return await screenshotWithLabels({ page })
```

Saving an image and returning only `"ok"` proves file creation, not visual
correctness. Return screenshot buffers through MCP when visual evidence matters.

## Execute Interface

Execute code can use `page`, `context`, `browser`, persistent `state`, selected
Node modules through `modules` and aliases such as `fs` and `path`, plus the
Browser Control helpers documented here. Single expressions auto-return;
multi-statement scripts need `return`. Use `--file` for longer scripts:

```bash
browser-control execute --session github --file ./perform-flow.js
```

Human CLI output includes logs, warnings, and a concise aftermath. Use `--json`
when another command needs to branch on `ok`, `value`, `error`, `warnings`, or
`aftermath`:

```bash
browser-control execute --json --session github '({ url: page.url() })' | jq .value.url
```

Playwright downloads are unavailable through extension-backed tabs because
Chromium blocks download artifact control through `chrome.debugger`. If the
page exposes the payload through fetch or an API response, read the bytes in the
page and write them with `fs`. Do not retry `page.waitForEvent("download")`.

## Safety

Browser Control blocks CDP commands that would destroy shared browser state,
including browser close and cookie/cache clearing. Never work around those
guardrails.

For inspect-only work, use a read-only session:

```bash
browser-control session new inspect-prod --read-only
browser-control execute --session inspect-prod 'await page.goto("https://example.com"); return page.title()'
```

Read-only sessions reject `Input.*`, so they cannot click or type through
Playwright. `page.evaluate` can still mutate the DOM; read-only prevents trusted
mistakes, not malicious code.

For destructive UI work, use a two-phase **read, confirm, verify** flow:

1. Read candidates and return exact stable identifiers or row text.
2. Obtain user approval for those exact items.
3. Re-select only approved items and assert the selected count.
4. Read the confirmation dialog and throw unless it matches the approved action.
5. Confirm, then verify through a fresh page read or independent CLI/API path.

Do not discover and confirm destructive candidates in one script unless the
user already approved exact stable identifiers. Never globally auto-accept
native dialogs; wait for the expected dialog and assert its type and message
before accepting it.

## TypeScript Client

Applications can import `BrowserControlClient` for schema-decoded,
same-origin requests authenticated by a session page. Use `sensitive: true`
for token-bearing responses and reveal them through Browser Control's API, not
the application's own Effect `Redacted` import; package-manager layouts may
resolve separate Effect runtimes.

```ts
import { BrowserControlClient } from "@opencode-ai/browser-control"

const sensitive = yield* origin.json({
  path: "/api/session",
  method: "POST",
  body: {},
  response: SessionResponse,
  sensitive: true,
})
const session = BrowserControlClient.reveal(sensitive)
```

## Authenticated Network Capture

Use network capture when the browser is needed to authenticate or discover a
workflow, but repeated direct HTTP calls would be faster and more reliable.
Capture each flow at least twice with different inputs so constants and
parameters can be distinguished.

```bash
browser-control network start --session github --url /api/ \
  --resource-type fetch --resource-type xhr
browser-control execute --session github --file ./perform-flow.js
browser-control network status --session github
browser-control network stop --session github \
  --output ./github.har --secrets github
```

Written artifacts replace credential-bearing headers, cookies, query fields,
and structured body fields with stable references such as `${BC_SECRET_1}`.
`--secrets github` stores lossless values separately in a mode-`0600` Secret
Profile. Never copy profile values into source, output, diagnostics, or journals,
and never deliberately return or log credentials.

Inspect the redacted artifact offline, generate one typed function per observed
flow, then verify each function with a harmless live request. Run generated
clients without exposing values:

```bash
browser-control secrets status github
browser-control secrets run github -- ./github-cli repositories
```

Refresh credentials normally renewed by a page reload with:

```bash
browser-control secrets refresh github --session github --url /api/
```

If refresh requires login or a human prompt, reauthenticate in the adopted tab
and repeat capture with the same profile. MCP exposes equivalent `network_*`
and `secrets_*` tools.

Completion: the artifact contains references rather than credential values, the
generated operation passes a harmless live check, and no secret value appears
in source or output.

## Recording

Record an attached or session-owned tab with:

```bash
browser-control recording start ./tmp/demo.mp4 --session github --mode cdp
browser-control recording status --session github
browser-control recording stop --session github
```

`--mode auto` uses tab capture for user-owned tabs and CDP for relay-owned tabs.
Tab capture can include audio; CDP requires `ffmpeg` and has no audio. Use the
command's `--help` for format and cursor options.

Completion: stop the recorder, inspect the resulting media rather than only its
existence, and report the viewport, state, and interaction path actually tested.

## Troubleshooting

1. Run `browser-control doctor`; it checks package metadata, CLI/relay build
   identity, extension connection/version, sessions, targets, and artifacts.
2. Use `status --json` to inspect exact sessions and target ownership.
3. Reproduce once with the smallest execute before changing code.

Common diagnoses:

- `connected:false`: run a relay-backed command, then reload the unpacked
  extension only if its reconnect loop does not recover.
- Stale relay build: operational commands reject it with restart guidance;
  rebuild the CLI and restart the relay.
- `Target not found`: attach the intended tab, then select or adopt it using a
  unique URL substring or explicit index.
- All targets disappeared: dismissing Chromium's debugging banner detaches every
  tab. Reattach through the toolbar.
- Relay restarted: named sessions reclaim exact targets, but JavaScript `state`
  and snapshot refs reset. Continue after the warning.
- Repeated execution-context errors: run one short follow-up so Browser Control
  can health-check the page. It may recreate a relay-owned page, but it never
  replaces an unhealthy adopted user tab; reset or re-adopt that tab.
- Fill timeout on login fields: inspect first, then try `fillInput` after
  confirming the selector or locator resolves.
- Download wait fails: use fetch plus `fs`; extension-backed Playwright cannot
  retain a native download artifact.

For deeper relay diagnosis, restart with `BROWSER_CONTROL_DEBUG=1`. Debug traces
must never include expressions, arguments, results, headers, cookies, or form
values.

Whenever Browser Control fails, wedges, replaces a page/session, or behaves
unexpectedly, create or update a `browser-control` project todo with the Browser
Control version, safe session/page context, exact error, deterministic
reproduction, expected versus actual behavior, and recovery attempted. Never
include credentials, form values, or private account data.
