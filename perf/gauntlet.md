# Gauntlet feedback latency

## Canonical Runtime replay

An isolated comparison of warm reconnect plus successful main-world evaluation
used one warmup and seven measured samples per build. Baseline median was
3013.025 ms; validated canonical replay median was 7.693 ms. Including warmup,
the baseline sent eight Runtime disable/reset cycles; the candidate sent zero.
Both clients evaluated successfully before and after navigation.

Baseline samples (ms): 3011.801, 3013.742, 3014.023, 3012.110, 3014.095,
3012.412, 3013.025. Candidate: 7.448, 9.404, 7.693, 8.581, 6.940, 6.383,
7.914. This measures a warm live-target reconnect, not cold startup or adoption
across ownership changes. Both builds emitted target-generation reconciliation
errors during intentional fixture closure; those remain separately tracked.

Reproduce the correctness workflow with
`GAUNTLET_CASE=runtime-context-replay pnpm gauntlet:isolated`. The case records
connection/evaluation timing and verifies both clients after document navigation.

## Workflow latency experiments

Primary metric: measured per-case wall time for the real-extension payment
workflow, including CLI startup and normal cleanup. Setup/build time is separate.

```bash
GAUNTLET_CASE=cross-origin-payment-iframe GAUNTLET_WARMUP=1 GAUNTLET_REPEAT=7 pnpm gauntlet:isolated
```

## 2026-09-22 experiment: immediate cleanup inventory probe

Environment: macOS arm64, Node 26.8.1, Chromium 151.0.7922.34, candidate based on
main `868a883`. One warmup and seven measured attempts per run. Ordinary local
development load; this is not a dedicated benchmark host.

Hypothesis: avoid the fixed 1.5-second lingering-tab grace when inventory already
proves the tab closed. Keep the existing grace and reconnection path otherwise.

| | Median | Nearest-rank p95 | Samples (ms) |
| --- | ---: | ---: | --- |
| Before | 5437 | 5505 | 5261, 5318, 5437, 5365, 5467, 5505, 5467 |
| Candidate | 5273 | 5351 | 5224, 5289, 5328, 5351, 5246, 5230, 5273 |

**Discarded.** The expected 1.5-second improvement did not appear. The payment
case leaves its auxiliary user tab at `about:blank`, so that cleanup path is
already skipped. The ~3% timing difference does not demonstrate this hypothesis;
the extra HTTP probe only adds complexity. No speedup is claimed.

All measured workflow attempts passed. The baseline outer run additionally
exposed a transient macOS `EPERM` during process-group liveness probing after
Chromium shutdown. That independent cleanup bug was fixed: signal-zero EPERM
means the group still exists, so bounded shutdown continues checking instead
of treating it as disappearance or an immediate fatal error. The candidate
outer run completed cleanup successfully. These receipts must remain distinct
from the case-latency samples.

Next hypotheses: measure phase-level CLI startup and unnecessary fixture setup
before changing the runner. If raw-client coexistence is isolated into its own
explicit regression, ordinary session-only cases may avoid creating an unused
raw-client page. Preserve that coverage rather than deleting it for a faster
number. Do not relax correctness deadlines or retry failures into green.
