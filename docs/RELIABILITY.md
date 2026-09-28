# Reliability loop

Browser Control must preserve the user's tab, execute the intended operation,
and remain usable after failure. A quick successful command is not enough.

## The loop

```ts
real incident
└─ smallest local reproducer             // preserve the causal boundary
   ├─ unit regression                    // deterministic race, no browser
   └─ gauntlet fixture                    // real CLI → relay → MV3 → Chromium
      ├─ assert fault actually engaged
      ├─ assert result and target identity
      ├─ assert next operation works
      └─ assert owned resources were released
         └─ fix → same regression → repeated samples → CI
```

The unit suite remains browser-free. In-memory concurrency tests synchronize
contenders at persistence or lifecycle barriers rather than hoping a sleep
produces the race. The gauntlet uses stock Playwright and the real unpacked
extension against synthetic local pages. It does not need accounts, model API
keys, an installed Browser Control runtime, or the user's browser.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm exec playwright-core install chromium

# Fast, deterministic state-machine feedback:
pnpm test test/session-manager.test.ts test/target-registry.test.ts

# One real-extension case against this checkout:
GAUNTLET_CASE=cross-origin-payment-iframe pnpm gauntlet:isolated

# All hostile fixtures in an owned browser:
pnpm gauntlet:isolated

# Warm-path measurement: one warmup, nine measured attempts; no retries:
GAUNTLET_CASE=cross-origin-payment-iframe GAUNTLET_WARMUP=1 GAUNTLET_REPEAT=9 pnpm gauntlet:isolated

# Explicit compatibility / headed run:
GAUNTLET_HEADED=true pnpm gauntlet:isolated
```

`GAUNTLET_BROWSER_PATH` optionally selects a browser executable. The default is
the full Chromium channel installed for the lockfile's Playwright version;
branded browsers may reject extension sideload flags. `GAUNTLET_ARTIFACT_DIR`
selects the parent of a fresh `run-*` evidence directory. `GAUNTLET_TIMEOUT_MS`
sets the outer case-process deadline (default ten minutes). The temporary
profile and HOME are removed only after verified browser and relay cleanup;
they are retained for inspection when process cleanup fails.

The launcher builds the CLI and shim outside the checkout, allocates private
ports, uses a temporary HOME/catalog and Chromium profile, and selects the
candidate CLI explicitly. Only the copied test shim's fixed relay port is
changed, with a checked build-text match. The production shim and live runtime
are untouched. On macOS/Linux the launcher owns browser, runner and relay
process groups, including surviving descendants after a leader exits. Teardown
uses bounded TERM/KILL escalation before deleting the temporary profile and HOME.
Windows currently has direct-child cleanup only and is not a browser CI lane.
`BROWSER_CONTROL_AUTOSTART=false` prevents a case CLI from spawning an unowned
successor if the test relay crashes; relay and browser exit also fail the run.

`pnpm gauntlet` remains the explicit already-running-browser path. Use it when
investigating browser/profile-specific interactions, with deliberate selection
of `GAUNTLET_CLI` and `BROWSER_CONTROL_ENDPOINT`. It is not the CI default.

## Honest receipts

- `run.json`: outer build/startup/case/cleanup outcome, elapsed time and error,
  including setup failures before any case ran.
- `report.json`: candidate and runner metadata, each attempt's status, timing,
  notes and failure; measured median and nearest-rank p95 per case.
- `environment.json`: browser/Node/platform identity and isolated endpoint.
- `*.log`: candidate builds, relay, and gauntlet output.

Keep every measured attempt, including failures. Warmups are excluded from
latency summaries, but a warmup failure still fails the run. Small samples have
poor tail precision: a p95 of one or three samples is effectively the maximum,
not an established production latency estimate. Setup is reported separately
from case durations; CLI launch, workflow and ordinary teardown are included
in case wall time.

Expected failures match a specific assertion. Different errors, cleanup leaks,
fatal process errors and budget overruns cannot turn into expected failures.
An unexpected pass fails so the obsolete expectation gets removed. There are
no automatic correctness retries to hide intermittent failures.

Only synthetic fixture data belongs in these artifacts. Do not upload profiles,
Secret Profiles, session journals from personal browsing, or account state.
The workflow uploads only result metadata and logs, never the temporary HOME or
profile. These are driver receipts, not a claim of complete Playwright traces
of another process's Execute Sandbox.

## CI layers

1. **Every PR:** existing type/unused/unit/package validation, plus a short real
   extension lane for native snapshot refs, document baselines, canonical context
   replay with two live clients, iframe input,
   auth handoff and overlay behavior.
2. **Nightly / manual:** all hostile cases repeated three times, keeping failures
   from every attempt and enforcing an outer deadline.
3. **Compatibility follow-up:** headed Brave/macOS and other Chromium versions;
   explicit fixtures for restricted extension UI. These are not implied by a
   headless Chromium pass.

The isolated launcher currently reuses one owned browser/relay for the selected
suite. Each case has a process watchdog outside its Effect fiber: its correctness
budget plus teardown grace and ten seconds. A stuck case fails the run and the
parent retires the owned environment; the outer suite deadline is a second bound.
Per-case worker replacement and parallel sharding are
future work; do not parallelize cases inside one shared browser just for speed.

## What to add next

- Named fixture barriers for navigation, WAIT acknowledgment, worker attach and
  server responses; remove wall-clock phase guesses as cases are revisited.
- Relay restart, MV3 suspension and nested OOPIF cases. Keep using cross-site
  hosts with site isolation and assert child target attachment; different ports
  alone do not prove OOPIF coverage.
- Same-browser multi-session/stale-client scenarios with exact ownership and
  event visibility assertions before and after failure.
- Mutation cancellation/outcome checks: a timeout alone must not be mistaken
  for cancellation. Prove no delayed mutation or explicitly retain ownership
  and report an unknown outcome.
- Separate cold start, warm execute/snapshot, detection and recovery benchmarks;
  retain raw samples and compare like-for-like builds/browser/machine settings.
- Long-run leak trends for owned targets, sessions, sockets and relay RSS.

## Research informing the design

Inspected September 22, 2026; source evidence, not claims that we ran their suites.

- **agent-browser:** [native E2E fixtures](https://github.com/vercel-labs/agent-browser/blob/d01253d9db28d75080e36da3c1c31ef89454731e/cli/src/native/e2e_tests.rs)
  and [warmup/sample benchmarks](https://github.com/vercel-labs/agent-browser/blob/d01253d9db28d75080e36da3c1c31ef89454731e/benchmarks/bench.ts).
  Useful command-level fixtures and workflow timing. Its inspected main browser
  E2E job skips PR events; we want a real-browser PR gate.
- **Stagehand:** [local fixture and headless helpers](https://github.com/browserbase/stagehand/blob/fbcdf6169e61431fc9be2ef0849c16424bc6d3bc/packages/sdk-ts/tests/integration/_support.ts)
  and [real extension smoke](https://github.com/browserbase/stagehand/blob/fbcdf6169e61431fc9be2ef0849c16424bc6d3bc/packages/sdk-ts/tests/browser-runtime/rpcClientExtensionSmoke.test.ts).
  Adopt real-extension/local-fixture coverage; distinguish mocked heartbeat
  tests from actual MV3 suspension proof.
- **Playwright:** [crash aftermath regressions](https://github.com/microsoft/playwright/blob/4afcfb174caf27b066abd0b56221a5e80295595f/tests/library/page-event-crash.spec.ts)
  and [owned process shutdown](https://github.com/microsoft/playwright/blob/4afcfb174caf27b066abd0b56221a5e80295595f/packages/utils/processLauncher.ts).
  Test recovery and pending-work rejection, not only error messages.
- **Puppeteer:** [OOPIF/reconnect suite](https://github.com/puppeteer/puppeteer/blob/17b535124f27b9f0c9f6c68e7deea3801b4534d0/test/src/oopif.test.ts)
  and [request-gated navigation tests](https://github.com/puppeteer/puppeteer/blob/17b535124f27b9f0c9f6c68e7deea3801b4534d0/test/src/navigation.test.ts).
  Prove renderer boundaries and coordinate races with events.

Keep the current runner for this increment rather than migrating frameworks at
the same time as fixing lifecycle bugs. If scheduling/sharding becomes sizeable,
Playwright Test's fixtures, process workers and artifact reporting are the next
component to reuse; the existing fixture pages and driver assertions can stay.
