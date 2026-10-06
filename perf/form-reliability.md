# Form reliability (2026-10-06)

## Scope and safety

General native input ordering, protected-frame freshness, exact-target/context
continuation, and receipt verification. All mutation tests use loopback fixtures
in an isolated Chromium profile and private relay. Tests do not replay live
inquiries, inspect protection tokens, forge human signals, or change browser
security. The shared relay/runtime and other agents' working files are untouched.

Base: `1b272d5`, package 0.8.3, extension 0.0.25, Chromium 153.0.8010.12.

## Repeatable checks

```bash
env GAUNTLET_CASE=contact-form-accepted,contact-form-rejected,contact-form-empty,runtime-context-replay GAUNTLET_REPEAT=8 node --import tsx scripts/gauntlet-isolated.ts
bun run test test/relay-input-order.test.ts test/relay-protected-frame.test.ts
```

Primary metric: verified native form outcomes and exact-target preservation.
Secondary metric: fill and submit-plus-verification latency, measured through the
same CLI interface agents use. Rejection and missing receipts are valid observed
outcomes, never successful delivery. This is a correctness experiment, not a
claim that changing input timing makes a protected website accept automation.

## Baseline and hypotheses

- Initial six native form flows: 5 passed; one native click returned without
  navigation and the registered 5-second destination wait timed out. No replay.
- Longer baseline: 30/32 passed. One native name ref fill timed out at 3 seconds;
  one cold runtime-replay case exceeded its 15-second end-to-end budget. The
  reconnect/evaluate itself succeeded; a budget failure is not a lost target.
- Slow Ghost Cursor acknowledgment can reorder concurrently admitted native
  mouse events. A deterministic 100 ms down-overlay ACK delay produced
  `mouseReleased, mousePressed`. Playwright deliberately sends move/down/up
  concurrently on its default click path.
- A protected frame restored to an ordinary document releases the tracker entry,
  but did not clear the root's `protectedUi` flag. Regression failed with
  `expected undefined, received true` before the one-line fix.

## Changes kept

- Serialize complete input dispatch per tab, including coordinate preparation,
  overlay acknowledgment, pacing, and the final Chrome command. Revalidate target
  generation/session after waiting; never deliver queued input to a successor.
- Clear protected UI on positive ordinary-frame restoration only when no other
  protected frames remain. Preserve suppression and human permission boundaries.
- Test native ref fills and native clicks through actual extension transport,
  ordinary iframe churn, redirects, fresh snapshot/main-world/utility-world reads,
  stale refs, and same-URL document replacement.
- Extend simultaneous-client runtime replay to native utility-world fills before
  and after navigation.
- Document single-attempt mutations, explicit receipt assertions, rejection versus
  unverified outcomes, and human handoff. No generic semantic-success API added.

## Dead ends and limits

- `pnpm gauntlet:isolated` tried to purge the linked dependency directory without
  a TTY. Use the direct Node/tsx script in this worktree; do not alter the shared
  dependencies to repair a worktree convenience.
- The isolated runner strips inherited Browser Control variables intentionally.
  Explicitly forwarding only the diagnostic debug flag makes traces available;
  browser target/session/endpoint identity still comes solely from isolation.
- The native fill stall is not proven to share the mouse-order root. A failed-fill
  read-only differential probe records main-world versus utility-world health.
- Cold startup latency and live password-manager lifecycle behavior are not
  equated with the site's anti-automation decision. Real protected prompts require
  a human; these fixtures do not contain a password manager.
- No runtime is deployed until the shared-runtime owner coordinates integration.

## Verification results

- Protocol regressions: delayed move/down cursor ACK preserves move/down/up;
  queued input is rejected on detach. Protected-frame remove/restore tests pass,
  including keeping the block when another restricted frame remains.
- Latest ordinary accepted-form run: **8/8 pass** with validity asserted before
  the single click, explicit receipt, fresh reads and stale-ref rejection.
  End-to-end median 5894.5 ms; the first run was 15916 ms. Synthetic evidence:
  `artifacts/2026-10-06-browser-form-events/run-hAIoNA/report.json` in the home repo.
- Empty-result run: all 8 native flows observed **unverified** correctly; 7 met
  the 20-second budget. First case took 31351 ms. Debug trace attributes 24 seconds
  to the initial `Target.createTarget`, before root announcement; native fill and
  submit/read in that case took 1294 and 2108 ms. Keep this cold-start defect visible.
- Simultaneous-client native-fill replay: **7/8 pass**. The failing first case
  exhausted its 3-second native-fill deadline. Main evaluate succeeded; a utility
  bootstrap `Runtime.evaluate` took approximately 2 seconds, and remaining native
  calls answered. No preceding runtime reset/context error proved a lost world.
- A longer mixed run after input ordering still failed a destination wait and
  utility-fill deadline, then hit the hard cleanup deadline in a later case.
  Therefore this patch is **not an all-green gauntlet** or proof of live-site
  reliability. No budgets were increased and no uncertain mutations retried.
- Final rejection/empty-outcome check: **4/4 pass**, including validity asserted
  before input and fresh post-navigation reads. Rejection and empty form never
  became a claimed receipt. Evidence:
  `artifacts/2026-10-06-browser-form-final/run-W7APa0/report.json` in the home repo.
- Full unit suite: **986 pass**. Typecheck/unused checks, DOM snapshot checks,
  duplicate audit and whitespace checks pass. Simplification kept the fixes at
  the existing relay boundary; no generic success classifier or retry layer added.

Next experiment: independently time cold target creation and utility bootstrap,
then capture form validity plus native event traces on any remaining no-navigation
failure. Use the isolated debug flag; do not reproduce through live submissions.

## Coordinated integration gate

On 2026-10-06, the shared checkout was clean at `a5889c5`, and the selected
runtime symlink pointed to `release-0.8.4-biomech-final`. These observations do
not establish that the owner's recordings or browser work are idle.

The existing owner session `ses_ef59fce12ffe4keGEiAUWYs1GE` was sent a queued
coordination request containing both exact fixes, test proof, remaining failures,
and the scoped integration/deployment authorization. The request asks for an
explicit idle/no-conflict confirmation and selection/restart window, or for the
owner to integrate and report the deployed identity themselves. No affirmative
reply has been received at this checkpoint. Shared integration/deployment remains
blocked on that confirmation; no shared checkout, runtime, relay, or extension
was changed by this session.

Integration must retain the owner's `decorateGhostCursorAction` import and
`rawAction` decoration, including `awaitPromise: action.path === undefined` in
`applyGhostCursorMouseEvent`. The owner's relay changes between `1b272d5` and
`a5889c5` touch those two separate hunks; the isolated ordering/restore patches
must be applied around them, not by copying this older relay file wholesale.
Preserve the owner's human-input, cursor, recording, and extension code.

After coordinated integration, rerun unit/type/unused/DOM checks and the retained
four-case eight-repeat isolated command with `BROWSER_CONTROL_DEBUG=1`. Keep
native-fill/navigation/cold-start failures visible and do not enlarge budgets or
replay uncertain mutations. Only select/restart within the confirmed owner
window after validation, and report both prepared build and running relay
identity. The bank inquiry remains undelivered; do not send it again.
