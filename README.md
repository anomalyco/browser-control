# Browser Control

Browser Control is a local driver that lets trusted agents control **your
existing Chromium-family browser** (Chrome, Brave, Edge, Arc, ...) through a
small extension and a local relay. Agents run Playwright code against your real
browser profile — logged-in sessions, extensions, and all — instead of a
sterile headless instance.

What you get:

- **Code-first execute**: agents run Playwright snippets in a persistent
  per-session sandbox (`browser`, `context`, `page`, `state`).
- **Sessions**: each agent session owns its own page, isolated from other
  concurrently running agents. Read-only sessions for inspect-only tasks.
- **Guardrails**: the relay blocks CDP commands that would nuke your browser
  state (clear cookies/cache, close browser) no matter what a script asks for.
- **Human handoff**: scripts can pause for you to complete 2FA/CAPTCHA/payment
  steps, then resume from an explicit in-page completion control.
- **Audit journal**: every execute is journaled per session, so you can see
  exactly what an agent did to your browser.
- **Recording**: capture attached tabs to WebM or CDP frame directories.

## Source Setup

Requirements: Node 20+, [pnpm](https://pnpm.io), [bun](https://bun.sh) (for
`bun link`), and a Chromium-family browser.

### 1. Install the CLI

The package is currently private, so install it from a source checkout:

```bash
git clone git@github.com:anomalyco/browser-control.git
cd browser-control
pnpm install
pnpm build
bun link          # installs `browser-control` and `browser-control-mcp` globally
```

### 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, ...).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the repo's `extension/dist` directory.
4. Pin the Browser Control toolbar button.

The current extension shim version is `0.0.10`; reload the unpacked extension
after rebuilding when its source changes.

### 3. Run it

```bash
browser-control execute "await page.goto('https://example.com'); return await page.title()"
browser-control status
```

The first relay-backed CLI command starts a background relay on
`127.0.0.1:19989`; the extension reconnects automatically. `status` is
observational and reports a stopped relay without starting it. Use
`browser-control serve` only when you want the relay in the foreground for
debugging. Bare execute prints the new session id and exact `--session`
continuation command. `browser-control doctor` performs a read-only
setup/runtime check.

### 4. Install the agent skill

The skill teaches your coding agent (OpenCode, Claude Code, Cursor, ...) how to
drive Browser Control. Install it with the [skills CLI](https://skills.sh):

```bash
npx skills add git@github.com:anomalyco/browser-control.git -g
```

Pick the agents you use when prompted (`-g` installs to your user-level agent
config so it works across projects). Since the repo is private, the git SSH
URL form is required and your existing GitHub SSH access is used.

Alternatively, `browser-control skill` prints the skill text so you can paste
it wherever your agent reads instructions.

### 5. (Optional) MCP server

Agents that prefer MCP over shell commands can use `browser-control-mcp`:

```jsonc
// opencode.json
{
  "mcp": {
    "browser-control": {
      "type": "local",
      "command": ["browser-control-mcp"]
    }
  }
}
```

```bash
# Claude Code
claude mcp add browser-control -- browser-control-mcp
```

The skill-driven CLI workflow and MCP expose the same relay sessions.

### Explicit sessions

```bash
browser-control session new demo
browser-control execute -s demo "await page.goto('https://example.com'); return await page.title()"
browser-control execute -s demo --json "page.url()"
browser-control journal -s demo
browser-control session delete demo
```

A visible tab opens in your browser, grouped under a purple `bc:demo` tab
group. The toolbar badge shows `ON` when attached, `RUN` while a script
executes, and `WAIT` when a script is paused for human handoff.

## Usage Notes

Execute code receives `browser`, `context`, `page`, persistent session `state`,
selected Node built-ins, `fillInput(selectorOrLocator, value)`,
`fillInputs(page, fields)`, `snapshot(options?)`, `ref(id)`,
`screenshotWithLabels({ page, path })`, `ariaSnapshot(target?, { timeout })`, and
`handoff(message, { timeoutMs })`, plus opt-in `showGhostCursor()` /
`hideGhostCursor()` helpers. Bare execute creates a fresh readable session and
prints `Session: <id>. Continue with --session <id>.` Pass that id through `--session` or
`BROWSER_CONTROL_SESSION` to reuse its page and `state`; those explicit ids must
already exist. Each session owns one default page so concurrent agents do not
collide, and other clients are never told about a session's tabs.

Use `browser-control session new <id> --read-only` for inspect-only sessions:
the relay rejects input-dispatching CDP so scripts can navigate, read, and
screenshot but not click or type.

Single-expression snippets such as `page.url()` or `await page.title()` return
their value automatically. Longer scripts can be passed with `--file <path>`
instead of positional code. Each execute response includes console messages,
page errors, warnings, and an aftermath summary (URL movement, navigations,
error counts, handoffs); `--json` prints a structured envelope
(`{ ok, value | error, logs, warnings, aftermath, session }`) for scripting.

Prefer normal Playwright actions; use `fillInput` only when installed
extensions in the user's browser make login/password-field `locator.fill()`
calls hang after the locator resolves. Prefer selector-based `fillInput` or
`fillInputs` for forms that hang on locator-level DOM evaluation.

Use `screenshotWithLabels` with an absolute path to save a screenshot annotated
with simple `e1`, `e2`, ... DOM labels for visible likely-interactive elements:

```bash
browser-control execute "return await screenshotWithLabels({ page, path: path.resolve('tmp/page-labels.png') })"
```

The result includes `path`, screenshot `size`, `labelCount`, `labels`, and `refs`.

Use `snapshot()` as the compact read-before-act default. It prefers the page's
single `main` region, collapses navigation, and spends its bounded item budget
on alerts, semantic groups, lists, tables, block code, headings, primary links,
and controls before repeated metadata. Select values and option counts are
summarized; text input and textarea values are omitted. Its timeout defaults to
10 seconds to accommodate a cold first browser evaluation:

```js
return await snapshot()
```

On the next execute call in that same named session, resolve a current ref to a
Playwright locator with `ref("e12")`. Refs belong to the latest snapshot and become stale after
main-frame navigation. Ref locators combine structural position with captured
accessible identity so DOM drift fails closed rather than silently retargeting
a different named control. Use `snapshot({ within, interactive, compact, depth,
maxItems, timeout })` to drill into omitted context.

After a full snapshot establishes a baseline, use `snapshot({ diff: true })` with
the same page and shape options to return only semantic additions and removals
plus an unchanged count. Each successful diff becomes the next baseline. A diff
invalidates earlier refs and assigns current refs only to added or changed lines;
take another full snapshot before acting on an unchanged element:

```js
await ref("e12").click()
return await snapshot({ diff: true })
```

Use `ariaSnapshot(target?, { timeout })` for a cheap YAML accessibility-tree
read of a selector, locator, or the default `body`. It defaults to a bounded
5-second timeout; override it for deliberately slow regions:

```js
return await ariaSnapshot("main", { timeout: 10_000 })
```

For a human-only step, `handoff` shows the message and an accessible **I'm done,
continue** button in the selected page. The same WAIT UI is restored after a
top-level navigation. Toolbar clicks do not complete a handoff or detach its tab
while the execute call is active. The default timeout is 10 minutes and remains
an explicit script failure.

Human acknowledgment is not proof that the requested step succeeded. Assert the
expected URL or element immediately after every handoff:

```js
await handoff("Complete 2FA, then use the in-page continue control")
if (!page.url().startsWith("https://app.example.com/")) {
  throw new Error(`2FA did not reach the app: ${page.url()}`)
}
await page.getByRole("heading", { name: "Dashboard" }).waitFor()
```

The ghost cursor is off by default. For a visible demo, call
`showGhostCursor()` after navigation and before visible mouse actions, then call
`hideGhostCursor()` during cleanup if desired. Starting a recording never
enables the ghost cursor.

Use `browser-control doctor` for a read-only install/runtime diagnosis,
including relay reachability, extension connection/version, sessions, active
targets, built artifacts, and whether the long-running relay matches the current
CLI build. `status` warns and relay-backed commands reject a stale build; stop
the process that owns the old relay before starting the current build. Use
`browser-control session list` and `browser-control status` to inspect
session-owned pages and attached targets.
`--target-url` and `--target-index` are manual recovery selectors; explicit
session executes use that session's page. Scripts can use
`BROWSER_CONTROL_SESSION`, `BROWSER_CONTROL_TARGET_URL`, or
`BROWSER_CONTROL_TARGET_INDEX`. URL selection must match exactly one page, and
URL/index selectors cannot be combined.

For an authenticated flow that is already open in the user browser, prefer a
one-command `execute --target-url <unique-url-part>` or make that tab sticky with
`browser-control session adopt --target-url <unique-url-part>` instead of
recreating authentication in a fresh relay-owned tab. After every navigation or
human handoff, verify the expected URL or a stable page element before entering
data or continuing the workflow.

Relay-created tabs stay attached after a short-lived `browser-control execute`
command exits, so repeated shell commands reuse the same visible tab. Close the
tab, call `await page.close()`, or detach with the toolbar when finished.

Use `browser-control recording start <output-path>` to record an attached tab.
`--mode auto` uses WebM `tab-capture` for user-owned tabs and CDP JPEG frame
directories for relay-owned tabs. The `--session` flag accepts either the
Browser Control session id used with `execute` or the lower-level `bc-tab-*`
session id from `browser-control status --json`.
Recording and the ghost cursor are independent; recording does not enable the
cursor overlay.

```bash
browser-control recording start ./tmp/demo-frames --session amazon --mode cdp
browser-control recording status --session amazon
browser-control recording stop --session amazon
```

For destructive UI work, use a two-phase approval flow. First inspect and
return the exact candidate rows/IDs. After explicit approval, run a second
script that selects by stable row text/ID, reads the confirmation dialog,
confirms only after validating dialog text, then verifies through an
independent read path such as a CLI/API command or a fresh page reload.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build            # CLI + extension
browser-control serve
SMOKE_CASE=oopif-reconnect pnpm smoke
```

The current smoke set covers local action/form fixtures, local cart and
checkout flows, reconnect/evaluate, a local HTTP redirect followed by reconnect
and evaluate, explicit target URL selection, execute fill helpers, OOPIF
reconnect, session isolation, and concurrent multi-client sessions. Run the
focused redirect/context regression with:

```bash
SMOKE_CASE=redirect-reconnect-evaluate pnpm smoke
```

Run the relay with `BROWSER_CONTROL_DEBUG=1` to log per-client CDP traffic and
metadata-only `[bc:ctx]` diagnostics for target ownership/browser-context IDs,
main-frame loaders, Runtime context lifecycle, Runtime reset attempts, and
failed evaluates. Diagnostic lines never include expressions, arguments,
results, headers, cookies, or form values; URLs are reduced to origin, shape,
and a short fingerprint. See `AGENTS.md` for contributor conventions and
`PLAN.md` for architecture decisions and roadmap.
