# Browser Control

Browser Control lets trusted coding agents run Playwright against your existing
Chromium-family browser. It uses your real browser profile, including logged-in
sessions and installed extensions, instead of launching a separate headless
browser.

```text
Agent or CLI -> local relay -> browser extension -> your browser
```

The driver runs locally and does not contain an LLM or make planning decisions.
Its primary interface is code: an agent sends a Playwright snippet and receives
the result, logs, warnings, and a summary of what changed.

## Quick Start

Browser Control requires Node.js 20 or newer and a Chromium-family browser such
as Chrome, Brave, Edge, Arc, or Chromium.

Setup has three parts: install the npm package, install the agent skill, and
load the included browser extension. Add MCP only when your agent prefers MCP
tools over shell commands.

### 1. Install the CLI

```bash
npm install --global @opencode-ai/browser-control
```

This installs two commands:

- `browser-control` for CLI and skill-driven agents
- `browser-control-mcp` for MCP clients

### 2. Connect your agent

The packaged skill teaches coding agents how to inspect before acting, preserve
session identity, handle human-only steps, and recover from browser failures.
Install it with the [skills CLI](https://skills.sh):

```bash
npx skills add anomalyco/browser-control -g
```

Choose the agents you use when prompted. The global `-g` installation makes the
skill available across projects.

Browser Control does not edit agent configuration itself. To inspect or install
the skill manually, print the exact bundled text:

```bash
browser-control skill
```

#### Optional MCP server

The skill and MCP server do different jobs. The skill teaches the workflow; MCP
exposes Browser Control as tools. Agents that can run shell commands need only
the skill. Add MCP when your client prefers MCP tools.

For OpenCode:

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

For Claude Code:

```bash
claude mcp add browser-control -- browser-control-mcp
```

CLI and MCP clients share the detached relay, but each execute session keeps its
own default page and persistent JavaScript `state`. Restarting an MCP process
does not stop the relay or interrupt an active CLI session.

### 3. Load the extension

Browser Control currently ships its extension as an unpacked extension inside
the npm package.

1. Print the extension directory:

   ```bash
   printf '%s\n' "$(npm root --global)/@opencode-ai/browser-control/extension/dist"
   ```

2. Open `chrome://extensions` or your browser's equivalent, such as
   `brave://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the printed directory.
5. Pin the Browser Control toolbar button.

### 4. Run your first browser command

Ask the configured agent to use Browser Control, or verify the installation
directly:

```bash
browser-control execute 'await page.goto("https://example.com"); return { title: await page.title(), url: page.url() }'
```

The command starts a detached local relay when needed, opens a browser tab, and
prints a readable session ID with the exact `--session` command needed to
continue. The relay listens on `127.0.0.1:19989` and stays running between CLI
calls.

Check the installation at any time with:

```bash
browser-control doctor
browser-control status
```

`doctor` and `status` are read-only. They report a stopped relay but never start
one. Use `browser-control serve` only for foreground debugging.

## Work in Sessions

A bare `execute` creates a fresh session. Pass its ID to continue with the same
page and `state`:

```bash
browser-control session new docs
browser-control execute --session docs 'await page.goto("https://example.com/docs"); state.visits = (state.visits ?? 0) + 1; return state.visits'
browser-control execute --session docs 'return { url: page.url(), visits: state.visits }'
browser-control journal --session docs
```

Single expressions return automatically, so this shorter form also works:

```bash
browser-control execute --session docs 'await page.title()'
```

Use `--file script.js` for longer programs and `--json` for a machine-readable
result envelope. Delete the session when you finish:

```bash
browser-control session delete docs
```

## Control an Existing Tab

Relay-created pages are isolated from other Browser Control sessions. To use a
tab that is already logged in:

1. Open the tab in your browser.
2. Click the Browser Control toolbar button to attach it.
3. Adopt it into a session using a unique URL substring:

```bash
browser-control session new github
browser-control session adopt --session github --target-url github.com
browser-control execute --session github 'return { title: await page.title(), url: page.url() }'
```

Adoption is exclusive to one Browser Control session. Resetting or deleting the
session releases an adopted user tab without closing it.

## Inspect Before Acting

Execute code receives normal Playwright `browser`, `context`, and `page`
objects, plus Browser Control helpers. `snapshot()` is the compact default for
reading a page before interaction:

```bash
browser-control execute --session github 'return await snapshot()'
```

Snapshot controls include refs such as `[ref=e12]`. Use a ref in the next call:

```bash
browser-control execute --session github 'await ref("e12").click(); return await snapshot({ diff: true })'
```

Refs belong to the latest snapshot and become stale after navigation. They
combine structural and accessible identity so DOM drift fails closed instead
of silently targeting a different control.

Other inspection helpers include:

- `ariaSnapshot()` for a deeper accessibility-tree view
- `screenshotWithLabels()` for an annotated screenshot and element metadata
- `fillInput()` and `fillInputs()` when browser extensions interfere with
  Playwright's normal `locator.fill()`

The agent skill documents these helpers and their options in detail.

## Pause for Human-Only Steps

Use `handoff()` for CAPTCHA, 2FA, payment confirmation, or another step that a
person must complete:

```js
await handoff("Complete 2FA, then use the in-page continue control")
await page.getByRole("heading", { name: "Dashboard" }).waitFor()
return page.url()
```

The page displays an accessible completion control and the script waits. Always
verify the expected URL or element after the handoff; human acknowledgment does
not prove that the requested step succeeded.

## Use Read-Only Sessions

Read-only sessions reject mouse and keyboard CDP commands while allowing
navigation, inspection, and screenshots:

```bash
browser-control session new inspect --read-only
browser-control execute --session inspect 'await page.goto("https://example.com"); return await snapshot()'
```

Read-only mode prevents accidental Playwright input. It is not a security
sandbox: trusted code can still mutate a page with `page.evaluate()`.

## Record a Session

```bash
browser-control recording start ./demo.webm --session github
browser-control recording status --session github
browser-control recording stop --session github
```

Automatic mode uses browser tab capture for user-owned tabs and CDP screencast
for relay-created tabs. Tab capture writes WebM and can include audio. CDP mode
writes WebM or MP4, requires `ffmpeg` on `PATH`, and does not capture audio.

## Safety Boundaries

Browser Control trusts the local agent code it executes. It is a driver, not an
untrusted-code sandbox.

The relay blocks destructive browser-wide CDP commands that clear cookies,
clear cache, or close the browser. It also keeps session-owned tabs private from
other Browser Control sessions. These guardrails reduce accidents, but scripts
still have access to the selected page and a limited set of Node.js built-ins.

Current limitations:

- The extension is installed unpacked; Chrome Web Store distribution is not
  available yet.
- Playwright download artifacts are unavailable because Chromium blocks the
  required download commands through `chrome.debugger`. Fetch exposed response
  bytes and write them with the provided `fs` module instead.
- CDP recording requires `ffmpeg`, activates the recorded tab, and has no audio.
- Browser Control is intended for trusted local use. It does not provide an
  authenticated remote relay.

## Development

```bash
git clone git@github.com:anomalyco/browser-control.git
cd browser-control
pnpm install
pnpm build
bun link

pnpm typecheck
pnpm test
pnpm build
SMOKE_CASE=oopif-reconnect pnpm smoke
```

Extension source changes require `pnpm build:extension` and reloading the
unpacked extension. Relay-only changes require rebuilding or restarting the
relay, not reloading the extension.

See [`PLAN.md`](./PLAN.md) for architecture and roadmap decisions,
[`AGENTS.md`](./AGENTS.md) for contributor invariants, and
[`skills/browser-control/SKILL.md`](./skills/browser-control/SKILL.md) for the
complete agent workflow.
