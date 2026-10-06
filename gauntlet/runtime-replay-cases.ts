import { Effect } from "effect"
import { chromium } from "playwright-core"
import type { GauntletCase } from "./cases.ts"
import { assert, boundedCleanup, endpointUrl, playwright } from "./harness.ts"

/** The first raw client stays connected while a second canonical client reconnects; prefer the isolated runner, where no unrelated CDP clients share the relay. */
export const runtimeReplayCases: readonly GauntletCase[] = [{
  name: "runtime-context-replay",
  summary: "Canonical reconnect reuses live contexts without replacing the first client's worlds",
  fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/runtime-replay.html`,
  budgetMs: 15_000,
  run: (first, ctx) => Effect.scoped(Effect.gen(function* () {
    const url = `${ctx.fixtures.primaryOrigin}/runtime-replay.html`
    yield* playwright("load replay fixture", () => first.goto(url))
    const marker = "runtime-replay-original-document"
    yield* playwright("seed document identity", () => first.evaluate((value) => { document.documentElement.dataset.replay = value }, marker))
    const started = performance.now()
    const second = yield* Effect.acquireRelease(
      playwright("connect second canonical client", () => chromium.connectOverCDP(endpointUrl, { timeout: 10_000 })),
      (browser) => boundedCleanup("close second canonical client", () => browser.close()),
    )
    const connectMs = performance.now() - started
    const page = second.contexts().flatMap((context) => context.pages()).find((page) => page.url() === url)
    assert(page, "Second client did not find exact fixture")
    const actual = yield* playwright("evaluate reconnected main world", () => page.evaluate(() => document.documentElement.dataset.replay))
    assert(actual === marker, "Reconnected context does not refer to original document", { actual })
    const evaluateMs = performance.now() - started
    yield* playwright("fill through reconnected utility world", () => page.getByLabel("Message").fill("Before navigation", { timeout: 3_000 }))
    assert((yield* playwright("first client reads native fill", () => first.getByLabel("Message").inputValue())) === "Before navigation", "Second client's utility world did not update the original document")
    assert((yield* playwright("first client remains usable", () => first.evaluate(() => document.documentElement.dataset.replay))) === marker,
      "Reconnect disturbed first client")
    yield* playwright("navigate to a new document", () => page.goto(`${url}?next=1`))
    assert((yield* playwright("new document has no stale marker", () => page.evaluate(() => document.documentElement.dataset.replay))) === undefined,
      "Reconnected client retained stale document")
    assert((yield* playwright("first client sees new document", () => first.evaluate(() => document.documentElement.dataset.replay))) === undefined,
      "First client retained stale context after navigation")
    yield* playwright("fill utility world after navigation", () => page.getByLabel("Message").fill("After navigation", { timeout: 3_000 }))
    assert((yield* playwright("first client reads navigated fill", () => first.getByLabel("Message").inputValue())) === "After navigation", "Utility world remained stale after navigation")
    ctx.note(`connectMs=${connectMs.toFixed(3)} connectAndEvaluateMs=${evaluateMs.toFixed(3)}`)
    return { connectMs, connectAndEvaluateMs: evaluateMs, evaluationVerified: true, nativeFillVerified: true }
  })),
}]
