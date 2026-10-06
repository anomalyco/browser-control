---
name: gauntlet
description: Run a real-world navigation and capability gauntlet on Browser Control across live websites, fix general DOM/ARIA/CDP root causes, benchmark speed and token efficiency, and finish with a mandatory simplify pass. Use when asked to run a gauntlet, dogfood Browser Control on real sites, or do an improvement pass.
---

# Gauntlet

Run Browser Control against uncurated live websites, fix general root causes as
you hit them, lock each fix in with a minimal offline regression test, and
always finish with a **Simplify** pass so new capabilities never accumulate
site-specific hacks or bloated files.

```ts
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  ▼                                                                     │
[1. Gauntlet] ──► [2. Autoresearch] ──► [3. Simplify] ──► [4. Harvest] ─┘
 Real-site         Latency, token &      Compress code,    Promote recurring
 field tasks       round-trip profile    remove hacks      UI flows to CLIs
```

## Workflow

### 1. Gauntlet — Adversarial Real-Site Field Pass

1. Create a dedicated session (`browser-control session new "🧭 gauntlet"`) and
   pick 4–6 diverse live sites that stress different web patterns (never
   perform destructive/irreversible actions like placing an order):
   - **Portal UI libraries**: `https://ui.shadcn.com/docs/components/radix/select`
     (Radix `<button role="combobox">`, body-portaled `[role="listbox"]` / `[role="option"]`)
   - **Complex web apps**: `https://github.com/Effect-TS/effect/issues`
     (Primer `[role="menu"]` / `[role="menuitemradio"]`, filter dialogs, `snapshot({ delta: true })`)
   - **Dense SPAs & e-commerce / booking**: `https://resy.com`, `https://www.ubereats.com`
     (top-level `<header>` search bars, carousels, focus-locked modals, deep card lists)
   - **Layout tables & prose**: `https://news.ycombinator.com`, `https://en.wikipedia.org`, `https://www.npmjs.com`
   - **Web Components & Shadow DOM**: `https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot`, `https://www.reddit.com/r/typescript/`
2. Drive each task through the public agent interface (`snapshot()`, `ref("eN")`,
   `screenshotWithLabels()`, `network`).
3. Whenever a step fails, times out, misses an interactive control, emits
   duplicate lines, or forces a blind `waitForTimeout` sleep:
   - Inspect the live DOM in the session to find the **general DOM, W3C ARIA, or
     CDP root cause**.
   - **Never** hardcode site-specific domain names or CSS class names. Express
     every rule in terms of standard HTML tags, ARIA roles/attributes, computed
     styles, or DOM structure.
   - Fix the root cause in `src/` (or `extension/src/`), add a minimal offline
     HTML regression check to `scripts/check-snapshot.ts` or `test/`, deploy to
     `/Users/kit/.browser-control/current-runtime` (`pnpm runtime:prepare` +
     `pnpm runtime:select` + `browser-control relay restart`), and re-verify on
     the live site.

### 2. Autoresearch — Speed, Token & Round-Trip Check

Measure across the gauntlet sites:
- **Wall-clock latency (`ms`)** per `snapshot()` call (target: `15–40 ms` on
  standard pages, `< 180 ms` on 9,000-node Shadow DOM pages).
- **Token footprint (`chars` / `lines`)**: eliminate duplicate `heading` + `link`
  pairs, redundant `listitem` / `p` wrappers, and layout-table noise.
- **Avoidable round-trips & sleeps**: prefer event-driven settle (`MutationObserver`,
  `Emulation.setFocusEmulationEnabled`) over manual `waitForTimeout` padding.

### 3. Simplify — Mandatory Coherence & Compression Pass

After fixing gauntlet findings, always run a `simplify` pass before finishing:
- Remove any ad-hoc branches, dead flags, or overlapping helpers introduced
  during debugging.
- Keep module boundaries clean (`src/snapshot.ts` owns DOM inspection and input
  helpers; `src/execute.ts` owns `ExecuteSandbox` and page recovery).
- Run the full verification gate:
  ```bash
  pnpm exec tsx scripts/check-snapshot.ts
  pnpm check:locals && pnpm check:unused && pnpm audit:duplicates
  pnpm test
  ```

### 4. Harvest — UI-to-API Promotion (Optional)

When testing a multi-step workflow (like Uber Eats or Resy), verify that
`network.start()` + `network.stop()` produces a clean `.endpoints` digest and
that `BrowserControlClient.origin(url, { session, headers, handoffOnAuthFailure: true })`
can drive the JSON API directly in one turn.

Always delete temporary gauntlet sessions (`browser-control session delete "🧭 gauntlet"`)
when finished.
