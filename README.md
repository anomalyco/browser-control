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

## Setup

Requirements: Node 20+ and a Chromium-family browser.

### 1. Install the CLI

Install both CLI entrypoints globally from npm:

```bash
npm install --global @opencode-ai/browser-control
```

### 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, ...).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the installed package's `extension/dist`
   directory. Print its location with:

   ```bash
   printf '%s\n' "$(npm root --global)/@opencode-ai/browser-control/extension/dist"
   ```

4. Pin the Browser Control toolbar button.

The current extension shim version is `0.0.17`; reload the unpacked extension
after rebuilding when its source changes.

### 3. Run it

```bash
browser-control execute 'await page.goto("https://example.com"); return await page.title()'
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
npx skills add anomalyco/browser-control -g
```

Pick the agents you use when prompted (`-g` installs to your user-level agent
config so it works across projects).

Alternatively, `browser-control skill` prints the skill text so you can paste
it wherever your agent reads instructions.

### Source installation

For development, clone the repository and build both artifacts locally:

```bash
git clone git@github.com:anomalyco/browser-control.git
cd browser-control
pnpm install
pnpm build
bun link
```

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

The skill-driven CLI workflow and MCP expose the same relay sessions. MCP reuses
the detached relay or starts it through the same lifecycle as the CLI; the relay
does not belong to the MCP process, so restarting MCP does not interrupt a CLI
execute or pending handoff. MCP `execute` extracts returned screenshot buffers,
including buffers nested in objects and arrays, as native image attachments
without writing temporary files. This allows one result to return metadata and
multiple images. Screenshots that are saved to a path but not returned remain
file-only.

### Explicit sessions

```bash
browser-control session new demo
browser-control execute -s demo 'await page.goto("https://example.com"); return await page.title()'
browser-control execute -s demo --json 'page.url()'
browser-control journal -s demo
browser-control session delete demo
```

A visible tab opens in your browser with a subtle in-page status. The toolbar
badge shows `ON` when attached, `RUN` while a mutable session
executes, and `WAIT` when a script is paused for human handoff. Read-only
execution stays quietly `ON`.

## Usage Notes

Execute code receives `browser`, `context`, `page`, persistent session `state`,
selected Node built-ins, `fillInput(selectorOrLocator, value)`,
`fillInputs(page, fields)`, `snapshot(options?)`, `ref(id)`,
`screenshotWithLabels({ page, path })`, `ariaSnapshot(target?, { timeout })`, and
`handoff(message, { timeoutMs })`, plus `showGhostCursor()` /
`hideGhostCursor()` cursor controls. Bare execute creates a fresh readable session and
prints `Session: <id>. Continue with --session <id>.` Pass that id through `--session` or
`BROWSER_CONTROL_SESSION` to reuse its page and `state`; those explicit ids must
already exist. Each session owns one default page so concurrent agents do not
collide, and other clients are never told about a session's tabs.

Use `browser-control session new <id> --read-only` for inspect-only sessions:
the relay rejects input-dispatching CDP so scripts can navigate, read, and
screenshot but not click or type.

Single-expression snippets such as `page.url()` or `await page.title()` return
their value automatically. Longer scripts can be passed with `--file <path>`
instead of positional code. Prefer single-quoted shell arguments with
double-quoted JavaScript strings so shell expansion cannot corrupt `$`,
backticks, or `!`; use `--file` when the script itself needs single quotes. Each
execute response includes console messages,
page errors, warnings, and an aftermath summary (URL movement, navigations,
error counts, handoffs); `--json` prints a structured envelope
(`{ ok, value | error, logs, warnings, aftermath, session }`) for scripting.
Repeated permissions-policy warnings and blocked analytics resources are folded
into representative entries; application errors remain distinct, and aftermath
error counts still include every event.

Prefer normal Playwright actions; use `fillInput` only when installed
extensions in the user's browser make login/password-field `locator.fill()`
calls hang after the locator resolves. Prefer selector-based `fillInput` or
`fillInputs` for forms that hang on locator-level DOM evaluation.

Use `screenshotWithLabels` to capture a screenshot annotated with simple `e1`,
`e2`, ... DOM labels for visible likely-interactive elements. Omit `path` and
return the result through MCP to attach the image in memory, or pass an absolute
path to save it:

```bash
browser-control execute 'return await screenshotWithLabels({ page, path: path.resolve("tmp/page-labels.png") })'
```

The result includes an in-memory `image` or saved `path`, plus screenshot `size`,
`labelCount`, `labels`, and `refs`.

Use `snapshot()` as the compact read-before-act default. It prefers the page's
single `main` region, collapses navigation, and spends its bounded item budget
on alerts, semantic groups, lists, tables, block code, headings, primary links,
and controls before repeated metadata. Select values and option counts are
summarized, and table rows pair column headers with cell values. Text input and
textarea values are omitted. Its timeout defaults to 10 seconds to accommodate a
cold first browser evaluation:

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
while the execute call is active. The extension preserves this UI across
ambiguous child-target closure events until the relay confirms the tab detached.
The default timeout is 10 minutes and remains an explicit script failure.

Human acknowledgment is not proof that the requested step succeeded. Assert the
expected URL or element immediately after every handoff:

```js
await handoff("Complete 2FA, then use the in-page continue control")
if (!page.url().startsWith("https://app.example.com/")) {
  throw new Error(`2FA did not reach the app: ${page.url()}`)
}
await page.getByRole("heading", { name: "Dashboard" }).waitFor()
```

Allowed Playwright mouse actions automatically show an arrow cursor whose tip
tracks the action point with spring motion and fades after idle time. Read-only
sessions reject input before cursor rendering.
Call `showGhostCursor(options)` to keep it visible or customize it, and
`hideGhostCursor()` to disable it for the current document, including while
recording.

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
`--mode auto` uses WebM `tab-capture` for user-owned tabs and timestamped CDP
screencasting for relay-owned tabs. CDP recording writes `.webm` or `.mp4`
directly at a constant 25 fps, fits the active viewport within 1280×720, and
requires `ffmpeg` on `PATH`. CDP mode activates the recorded tab because
Chromium throttles compositor frames for background tabs. It timestamps each
distinct frame and lets ffmpeg synthesize the constant-rate stream instead of
feeding duplicate JPEGs through Node. `tab-capture` output must end in `.webm`;
pass `--mode cdp` for `.mp4`. The `--session` flag accepts either the
Browser Control session id used with `execute` or the lower-level `bc-tab-*`
session id from `browser-control status --json`.
Recording and the ghost cursor are independent; recording does not change its
automatic, persistent, or disabled mode.

Run `pnpm bench:recording` with the extension connected to measure distinct
encoded source FPS and queue-drop ratio over a controlled compositor animation.

```bash
browser-control recording start ./tmp/demo.mp4 --session amazon --mode cdp
browser-control recording status --session amazon
browser-control recording stop --session amazon
```

Playwright download artifacts are not available in extension-backed tabs.
Chromium blocks the download-behavior commands that Playwright needs through
`chrome.debugger`, so `page.waitForEvent("download")` fails immediately with a
capability error instead of timing out. If the page exposes the payload through
fetch or an API response, read those bytes in the page and write them with the
execute sandbox's `fs` module.

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
and evaluate, explicit target URL selection, crashed and detached session-page
recovery, execute fill helpers (including Locator targets), the explicit
download capability boundary, OOPIF reconnect, session isolation, and concurrent
multi-client sessions. Run the
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
