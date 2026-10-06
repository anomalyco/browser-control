---
"@opencode-ai/browser-control": patch
---

- Add biomechanical pointer, scroll, and keyboard pacing (`src/human-input.ts`, `src/human-model.ts`) synchronized with `GhostCursor` (`src/ghost-cursor.ts`), plus empirical model fitting from the Cloudflare motor calibration obstacle course.
- Serialize per-tab `Input.*` and `DOM.scrollIntoViewIfNeeded` transactions with target freshness checks, and clear root `protectedUi` when restricted child frames navigate back to ordinary documents.
- Acknowledge `Page.screencastFrame` immediately inside the extension service worker and preserve unscaled backing surfaces so `ffmpeg` crops emulated `setViewportSize` regions without black compositor padding.
- Keep Browser Control tab groups expanded, format auto-generated session IDs as `🤖 <site/title>`, preserve attached tabs across `POST /extension/reload`, and reap abandoned relay-owned tabs after the idle TTL.
- Promote sibling tab bars, top-level `<nav>` fallback headers, and clickable `<tr>` cell summaries in `snapshot()` while preserving `mainRoot` when Radix/Floating UI portals are open.
