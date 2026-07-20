# @opencode-ai/browser-control

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
