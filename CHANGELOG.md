# @opencode-ai/browser-control

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
