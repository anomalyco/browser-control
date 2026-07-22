# @opencode-ai/browser-control

## 0.4.0

### Minor Changes

- 05b068d: Stream tab-capture recordings to disk with intrinsically framed, sequenced binary messages instead of buffering complete recordings in relay memory.

### Patch Changes

- 05b068d: Isolate CDP client state so concurrent clients retain their own auto-attach
  settings, invalidate target aliases when ownership hides a tab, reject hidden
  session routing, avoid arbitrary target fallback, and detach child targets when
  their root disappears. Centralize target and alias routing so stale root and
  child sessions fail closed.
- 05b068d: Accept `--session`, `-s`, and `BROWSER_CONTROL_SESSION` for session reset and
  delete while retaining positional and current-session selection.
- 05b068d: Prepare an unlisted Chrome Web Store extension with protocol-based relay
  compatibility, deterministic packaging, and more reliable cold-start target
  creation. Session reset and delete now recover relay-owned targets whose
  debugger attachment was permanently lost during an extension update.
- 05b068d: Search recursively through open shadow roots in `fillInput` and `fillInputs`,
  and report the closed-root boundary when a selector has no match.
- 05b068d: Preserve page focus while `fillInput` and `fillInputs` update controlled fields,
  preventing focus-sensitive extensions from making the target unresponsive.
- 05b068d: Keep the Chrome extension connected across idle service-worker suspension, repair missing reconnect alarms whenever the worker starts, start the managed relay correctly when MCP runs through a package-manager bin symlink, and make Doctor compare the runtime extension with the manifest shipped in the npm package.

## 0.3.2

### Patch Changes

- 4699f7d: Pin production WebSocket access to the assigned Chrome Web Store extension ID
  while retaining an explicit source-development path for unpacked extensions.

## 0.3.1

### Patch Changes

- abfcabb: Prepare an unlisted Chrome Web Store extension with protocol-based relay
  compatibility, deterministic packaging, and more reliable cold-start target
  creation. Session reset and delete now recover relay-owned targets whose
  debugger attachment was permanently lost during an extension update.

## 0.3.0

### Minor Changes

- 7aee5fd: Add a public Effect client with atomic named sessions and schema-decoded, same-origin JSON requests authenticated by the live browser page. Sensitive responses are returned as `Redacted` values and bypass execute journals and active network captures.

### Patch Changes

- 7aee5fd: Add `BrowserControlClient.reveal` for consuming sensitive authenticated responses across package-manager layouts with separate Effect runtime instances, plus `resetSession` for recovering disconnected named sessions without invoking the CLI.
- 7aee5fd: Reorganize the Browser Control agent skill around an inspect-act-verify golden
  path, explicit completion criteria, and concise optional workflows.
- 4427f40: Allow cold managed relays up to ten seconds to restore persisted sessions and
  become ready before reporting startup failure.

## 0.2.0

### Minor Changes

- 8ffa89c: Add session-scoped authenticated network capture, credential-redacted HAR
  exports, stable reusable secret profiles, credential refresh, and redacted
  command execution across CLI, MCP, and the execute sandbox.

### Patch Changes

- 3ba9951: Persist named session identity and exact target ownership across relay process
  restarts while clearly resetting process-local JavaScript state and snapshot
  references. Allow handoffs to register before starting actions that may block on
  native WebAuthn or payment prompts.
- edf33c2: Reject stale relays before operational CLI and MCP calls, preserve sessions
  across same-tab target and execution-context replacement, retain bounded relay
  fault diagnostics, and safely escape snapshot attribute selectors.

## 0.1.3

### Patch Changes

- 3729b6c: Rewrite the README around npm installation, agent skill and MCP setup, first-run workflows, and safety boundaries.

## 0.1.2

### Patch Changes

- 161e420: Keep snapshot references stable across safe rerenders when a control has a unique class and accessible identity.
