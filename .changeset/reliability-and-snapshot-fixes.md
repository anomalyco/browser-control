---
"@opencode-ai/browser-control": patch
---

- Preserve `about:blank` and newly navigated documents during session-page recovery, and clear crash evidence on target replacement and main-frame navigation.
- Use `NodeHttpClient.layerNodeHttp` in `RelayClient` and disable `httpServer.requestTimeout` so long `handoff()` and `secrets run` requests do not fail after five minutes with `HeadersTimeoutError`.
- Guard `snapshot()` when `document.body` is absent during early navigation, traverse open Shadow DOM controls, include `<input type="button|submit|reset">` values in accessible names, and prefer visible button text and native `<label>` text over `title` attributes so snapshot refs match Playwright `getByRole`.
- Allow `session adopt` and MCP `session_adopt` to omit `--target-url`/`--target-index` when adopting a single user-attached tab, register `screenshotWithLabels()` refs for `ref(id)`, bound `page.content()` with the 5-second read watchdog, and surface pointer-interception blocker warnings.
- Wait a full 30-second MV3 alarm period plus margin (`35s`) for a sleeping extension worker to reconnect, explain Node-side `window`/relative `fetch` errors in `execute`, include the file-system reason in `execute --file` errors, and stage `pnpm build:extension` outputs atomically.
