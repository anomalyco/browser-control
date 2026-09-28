import { Effect, Fiber, Option } from "effect"
import type { Page } from "playwright-core"
import { snapshotCases } from "./snapshot-cases.ts"
import { runtimeReplayCases } from "./runtime-replay-cases.ts"
import type { ExpectedFailure } from "./report.ts"
import {
  assert,
  assertTabPreserved,
  playwright,
  sleep,
  withSession,
  type ExecuteEnvelope,
  type GauntletContext,
  type OwnerCdpPage,
} from "./harness.ts"

/**
 * One hostile fixture per case. `run` drives Browser Control the way an agent
 * would (through the CLI) and asserts both the outcome and the tab-preservation
 * invariants. `expectedFailure` marks cases that document behaviour Browser
 * Control does not deliver yet; the runner treats an expected failure as
 * neutral and an unexpected pass as a signal to flip the flag.
 */
export type GauntletCase = {
  readonly name: string
  readonly summary: string
  readonly fixtureUrl: (origins: { readonly primaryOrigin: string; readonly secondaryOrigin: string }) => string
  readonly budgetMs: number
  readonly expectedFailure?: ExpectedFailure
  /** Extra time the runner may spend closing the case's user tab when a hostile fixture keeps its renderer busy. */
  readonly userTabCleanupGraceMs?: number
  readonly run: (page: Page, ctx: GauntletContext) => Effect.Effect<unknown, Error>
}

const marker = (name: string) => `gauntlet-${name}-${Date.now().toString(36)}`

/**
 * The stalled fixture blocks its main thread in 20s slices for 25s. Every
 * automation read inside that window must fail in a bounded way; cleanup waits
 * for the release so closing the tab never hits a hung renderer (which would
 * show the browser's "page unresponsive" dialog and can leave the tab open).
 */
const stallQuery = "hostile=1&block=20000&stall=25000"
const stallReleasedExpression = "new Promise((resolve) => { const check = () => document.getElementById('stall-state')?.dataset.stall === 'released' ? resolve('released') : setTimeout(check, 100); check() })"

function valueObject(envelope: ExecuteEnvelope): Record<string, unknown> {
  return envelope.value && typeof envelope.value === "object" && !Array.isArray(envelope.value) ? envelope.value as Record<string, unknown> : {}
}

export const cases: readonly GauntletCase[] = [
  ...snapshotCases,
  ...runtimeReplayCases,
  {
    name: "stalled-main-world",
    summary: "Relay-owned page whose main world stalls for automation while the DOM stays painted",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/stalled-main-world.html?${stallQuery}`,
    budgetMs: 50_000,
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const tag = marker("stall")
      const url = `${ctx.fixtures.primaryOrigin}/stalled-main-world.html?${stallQuery}&marker=${tag}`
      // Run the healthy negative control before navigation starts the stall clock.
      const missing = yield* ctx.execute({
        sessionId,
        code: "await page.locator('#missing-diagnostic-control').click({ timeout: 100 })",
      })
      assert(missing.isError && /Timeout 100ms exceeded/.test(missing.text), "healthy missing locator did not time out as expected", missing)
      assert(missing.diagnostic === undefined, "healthy missing locator was misdiagnosed as a context failure", missing)
      const healthy = yield* ctx.execute({ sessionId, code: "return { title: await page.title(), ready: await page.evaluate(() => true) }" })
      assert(healthy.ok && valueObject(healthy).ready === true, "healthy page did not answer after the missing locator", healthy)
      const commit = yield* ctx.execute({
        sessionId,
        code: `await page.goto(${JSON.stringify(url)}, { waitUntil: 'commit', timeout: 15000 }); return page.url()`,
      })
      assert(commit.ok && commit.value === url, "goto with waitUntil:'commit' should succeed on the stalled page", commit)
      yield* sleep(600)

      const read = yield* ctx.execute({
        sessionId,
        code: "return { title: await page.title(), ready: await page.evaluate(() => document.readyState) }",
        timeoutMs: 30_000,
      })
      assert(read.isError, "reading title/readyState from the stalled main world should not succeed", read)
      assert(read.durationMs < 12_000, `stalled read took ${read.durationMs}ms; expected a bounded failure within 12s`, read)

      const snapshot = yield* ctx.execute({ sessionId, code: "return await snapshot({ maxItems: 20 })", timeoutMs: 30_000 })
      assert(snapshot.isError, "snapshot() on the stalled main world should not succeed", snapshot)
      assert(snapshot.durationMs < 16_000, `snapshot took ${snapshot.durationMs}ms; expected a bounded failure within 16s`, snapshot)

      const after = yield* ctx.execute({ sessionId, code: "return { url: page.url() }" })
      assert(after.ok, "page.url() after the stalled reads should succeed without touching the main world", after)
      assert(valueObject(after).url === url, "session page URL changed after stalled reads", after)
      ctx.note(`read failed in ${read.durationMs}ms, snapshot in ${snapshot.durationMs}ms`)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [read, snapshot, after] })
      ctx.note("tab kept on the fixture URL")

      const released = yield* ctx.execute({ sessionId, code: `return await page.evaluate(() => ${stallReleasedExpression})`, timeoutMs: 45_000 })
      assert(released.ok && released.value === "released", "stalled fixture did not release its main thread before cleanup", released)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [released], label: "tab preserved after release" })
      assert(read.diagnostic === "session-page/context-read-timeout; operation=page.title; timeoutMs=5000", "stalled read did not report the exact bounded context-read diagnostic", {
        diagnostic: read.diagnostic,
        text: read.text.split("\n")[0],
      })
      return { readMs: read.durationMs, snapshotMs: snapshot.durationMs, diagnostic: read.diagnostic }
    })),
  },
  {
    name: "typing-freezes-page",
    summary: "First trusted keystroke freezes the main thread; the tab and typed input must survive",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/typing-freezes-page.html?freeze=40000&chunk=6000`,
    budgetMs: 75_000,
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const tag = marker("typing")
      const url = `${ctx.fixtures.primaryOrigin}/typing-freezes-page.html?freeze=40000&chunk=6000&marker=${tag}`
      const open = yield* ctx.execute({ sessionId, code: `await page.goto(${JSON.stringify(url)}); return page.url()` })
      assert(open.ok, "goto typing fixture", open)

      const typingStarted = Date.now()
      const typing = yield* ctx.execute({
        sessionId,
        code: "await page.locator('#pnr').pressSequentially('ABC123'); await page.locator('#last-name').fill('Smith'); return 'typed'",
        timeoutMs: 70_000,
      })
      assert(typing.durationMs >= 5_000, "the freeze did not engage: typing completed too quickly", typing)
      assert(!typing.cliTimedOut, "typing execute did not return before the gauntlet CLI timeout", typing)
      if (typing.isError) {
        assert(/timeout|timed out/i.test(typing.text), "typing failed with something other than a clear timeout", typing)
      }

      const probe = yield* ctx.execute({ sessionId, code: "return { url: page.url(), title: await page.title() }", timeoutMs: 30_000 })
      assert(valueObject(probe).url === undefined || valueObject(probe).url === url, "probe saw a different URL during the freeze", probe)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [typing, probe], label: "tab preserved during freeze" })

      const releaseAt = typingStarted + 42_000
      const remaining = releaseAt - Date.now()
      if (remaining > 0) yield* sleep(remaining)

      const final = yield* ctx.execute({
        sessionId,
        code: "return { url: page.url(), pnr: await page.locator('#pnr').inputValue(), state: await page.locator('#freeze-state').getAttribute('data-freeze') }",
        timeoutMs: 30_000,
      })
      assert(final.ok, "reading the form after the freeze released should succeed", final)
      const value = valueObject(final)
      assert(value.url === url, "URL changed after the freeze", final)
      assert(value.state === "released", "fixture did not report the freeze as released", final)
      assert(typeof value.pnr === "string" && value.pnr.length > 0, "in-progress form input was lost", final)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [typing, probe, final], label: "tab preserved after freeze" })
      ctx.note(`typing ${typing.isError ? "timed out" : "succeeded"} after ${typing.durationMs}ms; pnr="${value.pnr}" survived`)
      return { typingMs: typing.durationMs, typingError: typing.isError ? typing.text.split("\n")[0] : null, probeError: probe.isError ? probe.text.split("\n")[0] : null, pnr: value.pnr }
    })),
  },
  {
    name: "cross-origin-payment-iframe",
    summary: "Card input in a cross-origin iframe ignores fill/autofill; parent validation must stay readable",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/cross-origin-payment-iframe.html`,
    budgetMs: 40_000,
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const tag = marker("pay")
      const url = `${ctx.fixtures.primaryOrigin}/cross-origin-payment-iframe.html?marker=${tag}`
      const result = yield* ctx.execute({
        sessionId,
        timeoutMs: 60_000,
        code: `
await page.goto(${JSON.stringify(url)})
const card = page.frameLocator('#payment').locator('#card')
await card.waitFor({ timeout: 10000 })
const validation = page.locator('#validation')
const pay = async (attempt) => {
  await page.click('#pay')
  await page.waitForFunction((n) => window.__gauntlet.payResponses >= n, attempt, { timeout: 5000 })
  return (await validation.textContent()).trim()
}
const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
const frameOrigin = frame ? new URL(frame.url()).origin : null
const pageOrigin = new URL(page.url()).origin
const inspector = await context.newCDPSession(page)
let oopif
try {
  const { targetInfos } = await inspector.send('Target.getTargets')
  oopif = targetInfos.some((target) => target.type === 'iframe' && target.url === frame?.url())
} finally {
  await inspector.detach()
}
const initial = (await validation.textContent()).trim()

await card.fill('4242424242424242')
const visibleAfterFill = await card.inputValue()
const afterFill = await pay(1)

await card.evaluate((element) => { element.value = '4242424242424242' })
const visibleAfterAutofill = await card.inputValue()
const afterAutofill = await pay(2)

await card.click()
await card.pressSequentially('4242424242424242')
const visibleAfterTyping = await card.inputValue()
const afterTyping = await pay(3)
return { frameOrigin, pageOrigin, oopif, crossOrigin: frameOrigin !== pageOrigin, initial, visibleAfterFill, afterFill, visibleAfterAutofill, afterAutofill, visibleAfterTyping, afterTyping }
`,
      })
      assert(result.ok, "payment iframe flow failed", result)
      const value = valueObject(result)
      assert(value.crossOrigin === true && value.frameOrigin === ctx.fixtures.secondaryOrigin, "payment frame was not served cross-origin", value)
      assert(value.oopif === true, "payment frame did not produce a real iframe target; origin inequality alone is not OOPIF coverage", value)
      assert(typeof value.initial === "string" && /required/i.test(value.initial), "parent validation text was not readable before input", value)
      assert(/required/i.test(String(value.afterFill)), "fill() was accepted by the hostile frame; expected validation to remain 'required'", value)
      assert(value.visibleAfterAutofill === "4242424242424242" && /required/i.test(String(value.afterAutofill)), "autofill-style value assignment should be visible yet rejected", value)
      assert(/submitted for card ending 4242/i.test(String(value.afterTyping)), "trusted keyboard input was not accepted by the frame", value)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [result] })
      ctx.note(`fill rejected, autofill rejected, pressSequentially accepted (${result.durationMs}ms)`)
      return value
    })),
  },
  {
    name: "auth-redirect-handoff",
    summary: "handoff() registered on a sign-in page that replaces its own document and then redirects to /app",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/auth/app`,
    budgetMs: 70_000,
    // Relay 0.7.0 failed this with execution-context/context-destroyed when the
    // sign-in document replaced itself (todo 5c0b3fb3 repro 1, ask 5); relay
    // 0.8.1 keeps the handoff alive across both document replacements.
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const tag = marker("auth")
      const appUrl = `${ctx.fixtures.primaryOrigin}/auth/app`
      const reset = yield* ctx.execute({ sessionId, code: `await page.goto(${JSON.stringify(`${ctx.fixtures.primaryOrigin}/auth/reset?marker=${tag}`)}); return page.url()` })
      assert(reset.ok, "resetting fixture auth cookies failed", reset)

      return yield* Effect.scoped(Effect.gen(function* () {
        const forkedAt = Date.now()
        const executeFiber = yield* ctx.execute({
          sessionId,
          timeoutMs: 80_000,
          code: `await page.goto(${JSON.stringify(appUrl)}); await handoff('Sign in to continue', { timeoutMs: 45000 }); return { url: page.url(), welcome: await page.locator('#welcome').textContent({ timeout: 10000 }) }`,
        }).pipe(Effect.forkChild)

        let owner: OwnerCdpPage | undefined
        for (let attempt = 0; attempt < 60 && !owner; attempt++) {
          const targets = yield* ctx.sessionTargets(sessionId)
          if (targets.some((target) => target.url.includes("/auth/"))) {
            const connected = yield* Effect.result(ctx.ownerCdpPage({ sessionId, urlIncludes: "/auth/" }))
            if (connected._tag === "Success") owner = connected.success
          }
          if (!owner) yield* sleep(250)
        }
        assert(owner, "session page never reached the /auth/ fixture", yield* ctx.sessionTargets(sessionId))

        const human = { sawBootstrap: false, sawStatusUi: false, signedIn: false, completed: false, finishedEarly: false, phases: [] as string[] }
        const deadline = Date.now() + 50_000
        while (Date.now() < deadline && !human.completed) {
          if (executeFiber.pollUnsafe() !== undefined) {
            human.finishedEarly = true
            break
          }
          const observed = yield* Effect.result(owner.evaluate<{ href: string; phase: string | null; form: boolean; welcome: boolean; statusUi: boolean; completion: boolean }>(
            "({ href: location.href, phase: window.__gauntlet ? window.__gauntlet.phase : null, form: window.__gauntlet?.phase === 'form' && document.querySelector('#sign-in-form')?.hidden === false && document.querySelector('#sign-in')?.disabled === false, welcome: !!document.querySelector('#welcome'), statusUi: !!document.getElementById('__browser_control_page_status__'), completion: !!(document.getElementById('__browser_control_page_status__')?.shadowRoot?.querySelector('button')) })",
          ))
          if (observed._tag === "Failure") {
            yield* sleep(200)
            continue
          }
          const state = observed.success
          if (state.phase && human.phases.at(-1) !== state.phase) human.phases.push(state.phase)
          if (state.phase === "bootstrapping") human.sawBootstrap = true
          if (state.statusUi) human.sawStatusUi = true
          // Navigation can destroy the click's evaluation before its response.
          if (state.phase === "signing-in" || state.welcome) human.signedIn = true
          if (state.form && !human.signedIn) {
            // The hidden bootstrap form already contains #sign-in. Recheck the
            // ready barrier in the click's own task, not only the preceding read.
            const clicked = yield* Effect.result(owner.evaluate<boolean>("(() => { const button = document.getElementById('sign-in'); const form = document.getElementById('sign-in-form'); if (window.__gauntlet?.phase !== 'form' || !form || form.hidden || !button || button.disabled) return false; button.click(); return window.__gauntlet.phase === 'signing-in' })()"))
            human.signedIn = clicked._tag === "Success" && clicked.success
          } else if (state.welcome && state.completion && !human.completed) {
            const clicked = yield* Effect.result(owner.evaluate<boolean>("(() => { const button = document.getElementById('__browser_control_page_status__')?.shadowRoot?.querySelector('button'); if (!document.getElementById('welcome') || !button || button.disabled) return false; button.click(); return true })()"))
            human.completed = clicked._tag === "Success" && clicked.success
          }
          yield* sleep(200)
        }

        const joined = yield* Fiber.join(executeFiber).pipe(Effect.timeoutOption("70 seconds"))
        assert(Option.isSome(joined), "handoff execute did not return after the human completed", human)
        const outcome = joined.value
        const follow = yield* ctx.execute({ sessionId, code: "return { url: page.url() }" })
        yield* assertTabPreserved(ctx, { sessionId, urlIncludes: "/auth/", envelopes: [outcome, follow] })
        assert(human.signedIn, "the sign-in form never appeared for the human", human)
        ctx.note(`human: ${human.phases.join(" → ")}${human.completed ? " → completed" : ""}; handoff execute ${outcome.ok ? "resolved" : "failed"} after ${Date.now() - forkedAt}ms`)
        assert(outcome.ok, "handoff did not survive the sign-in document replacement and redirect", { diagnostic: outcome.diagnostic, text: outcome.text.split("\n")[0], human })
        assert(!human.finishedEarly && human.completed, "handoff resolved before the human pressed the completion control", human)
        assert(outcome.aftermath?.handoffs === 1, "aftermath did not record exactly one handoff", outcome.aftermath)
        const value = valueObject(outcome)
        assert(typeof value.url === "string" && value.url.endsWith("/auth/app"), "handoff resolved on the wrong page", value)
        assert(/signed in/i.test(String(value.welcome)), "post-login content was not readable after the handoff", value)
        return { ...value, human }
      }))
    })),
  },
  {
    name: "sentinel-overlay-click",
    summary: "Checkbox under a stretched anchor and a fixed click-through sentinel",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/sentinel-overlay-click.html`,
    budgetMs: 30_000,
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const tag = marker("sentinel")
      const url = `${ctx.fixtures.primaryOrigin}/sentinel-overlay-click.html?marker=${tag}`
      const result = yield* ctx.execute({
        sessionId,
        timeoutMs: 45_000,
        code: `
await page.goto(${JSON.stringify(url)})
const checkbox = page.getByLabel('Accept the travel policy')
let naiveError = null
const naiveStarted = Date.now()
try {
  await checkbox.check({ timeout: 4000 })
} catch (error) {
  naiveError = error.message
}
const naiveMs = Date.now() - naiveStarted
const checkedAfterNaive = await checkbox.isChecked()
await checkbox.check({ force: true })
const checkedAfterForce = await checkbox.isChecked()
const continueEnabled = await page.locator('#continue').isEnabled()
const forwarded = await page.evaluate(() => window.__gauntlet.forwardedTo)
return { naiveError, naiveMs, checkedAfterNaive, checkedAfterForce, continueEnabled, forwarded }
`,
      })
      assert(result.ok, "sentinel overlay flow failed", result)
      const value = valueObject(result)
      assert(typeof value.naiveError === "string" && /intercepts pointer events/i.test(value.naiveError) && /modal-sentinel/.test(value.naiveError), "naive check() did not report the intercepting sentinel", value)
      assert(value.checkedAfterNaive === false, "naive check() unexpectedly toggled the checkbox", value)
      assert(value.checkedAfterForce === true && value.continueEnabled === true, "forced check did not reach the checkbox through the sentinel", value)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [result] })
      ctx.note(`naive check failed in ${String(value.naiveMs)}ms naming the sentinel; force:true clicked through`)
      return value
    })),
  },
  {
    name: "heavy-spa-slow-context",
    summary: "Client-side navigation into a SPA that blocks its main thread for 5s right after a context-destroyed diagnostic",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/heavy-spa-slow-context.html?block=5000`,
    budgetMs: 50_000,
    // Relay 0.7.0 closed the relay-owned page after the 3s health check and
    // recreated about:blank (todo 5c0b3fb3, repro 1); relay 0.8.1 waits for the
    // bootstrapping document instead and keeps the tab.
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const tag = marker("spa")
      const url = `${ctx.fixtures.primaryOrigin}/heavy-spa-slow-context.html?block=5000&marker=${tag}`
      const boot = yield* ctx.execute({ sessionId, code: `await page.goto(${JSON.stringify(url)}, { timeout: 20000 }); return await page.locator('#ready').textContent()`, timeoutMs: 40_000 })
      assert(boot.ok && boot.value === "SPA ready", "initial SPA load failed", boot)

      const destroyed = yield* ctx.execute({
        sessionId,
        code: "await page.evaluate(() => { document.getElementById('rehydrate').click(); return new Promise(() => {}) }); return 'unexpected'",
        timeoutMs: 30_000,
      })
      assert(destroyed.isError, "the rehydrate navigation should reject the pending evaluate", destroyed)
      assert(destroyed.diagnostic?.startsWith("execution-context/") === true, "rehydrate navigation did not produce an execution-context diagnostic", destroyed)

      const immediate = yield* ctx.execute({
        sessionId,
        code: "return { url: page.url(), ready: await page.locator('#ready').textContent({ timeout: 15000 }) }",
        timeoutMs: 40_000,
      })
      yield* sleep(Math.max(0, 7_000 - immediate.durationMs))
      const settled = yield* ctx.execute({
        sessionId,
        code: "return { url: page.url(), ready: await page.locator('#ready').textContent({ timeout: 5000 }), version: await page.locator('#version').textContent() }",
        timeoutMs: 30_000,
      })
      ctx.note(`immediate execute ${immediate.ok ? "succeeded" : "failed"} in ${immediate.durationMs}ms${immediate.diagnostic ? ` (${immediate.diagnostic.split(";")[0]})` : ""}`)
      yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [destroyed, immediate, settled] })
      assert(settled.ok, "SPA was not readable after its bootstrap finished", settled)
      const value = valueObject(settled)
      assert(typeof value.url === "string" && value.url.includes("v=2"), "session page is not on the rehydrated SPA URL", value)
      assert(value.version === "version 2", "SPA did not render the rehydrated version", value)
      return { immediateMs: immediate.durationMs, immediateOk: immediate.ok, immediateDiagnostic: immediate.diagnostic, ...value }
    })),
  },
  {
    name: "adopt-stalled-user-tab",
    summary: "One-command adopt of a user tab whose main world is stalled, then bounded reads that keep the tab",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/stalled-main-world.html?${stallQuery}`,
    budgetMs: 50_000,
    userTabCleanupGraceMs: 40_000,
    run: (page, ctx) => Effect.gen(function* () {
      const tag = marker("adopt")
      const url = `${ctx.fixtures.primaryOrigin}/stalled-main-world.html?${stallQuery}&marker=${tag}`
      yield* playwright("open stalled fixture in user tab", () => page.goto(url, { waitUntil: "commit", timeout: 15_000 }))
      const original = (yield* ctx.status()).targets.find((target) => target.url === url)
      assert(original, "user fixture target must exist before adoption")
      yield* sleep(600)

      const sessionId = `gauntlet-adopt-${Date.now().toString(36)}`
      const adopt = yield* ctx.run(["session", "adopt", "--session", sessionId, "--target-url", tag], { timeoutMs: 30_000 })
      assert(adopt.exitCode === 0, "one-command adoption of the stalled user tab failed", adopt.stderr || adopt.stdout)
      ctx.trackSession(sessionId)
      return yield* Effect.gen(function* () {
        const adopted = yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag })
        // withUserTab creates an unowned raw-CDP tab: registry `owner` records
        // its relay creation provenance. Adoption's user ownership is instead
        // proved by exclusive binding here and release-without-close below.
        assert(adopted.id === original.id && adopted.tabId === original.tabId && adopted.owner === original.owner && adopted.browserControlSessionId === sessionId, "adoption did not preserve exact target and exclusive binding", { original, adopted })
        const read = yield* ctx.execute({ sessionId, code: "state.setupRan = true; return { title: await page.title() }", timeoutMs: 30_000 })
        assert(read.isError, "reading the stalled adopted tab should not succeed", read)
        assert(read.durationMs < 12_000, `stalled adopted read took ${read.durationMs}ms; expected a bounded failure within 12s`, read)
        assert(read.diagnostic === "session-page/adopted-initialization-timeout" && read.text.includes("user code did not run"), "stalled adoption setup must name its initialization timeout truthfully", read)
        ctx.note(`read failed in ${read.durationMs}ms`)
        const target = yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [read] })
        assert(target.id === original.id && target.tabId === original.tabId, "adoption replaced the original user tab", { original, target })
        assert(target.browserControlSessionId === sessionId, "adopted tab lost its exclusive session binding", target)
        // Observe fixture release independently; this does not retry or hide a
        // failed Browser Control execute, and evaluates only a read-only marker.
        yield* Effect.scoped(Effect.gen(function* () {
          const owner = yield* ctx.ownerCdpPage({ sessionId, urlIncludes: tag })
          assert(owner.targetId === original.id, "release observer selected a different target")
          yield* owner.waitFor("document.getElementById('stall-state')?.dataset.stall === 'released'").pipe(Effect.timeout("30 seconds"))
        }))
        const recovered = yield* ctx.execute({ sessionId, code: "return { url: page.url(), title: await page.title(), setupRan: Boolean(state.setupRan) }", timeoutMs: 30_000 })
        assert(recovered.ok && valueObject(recovered).url === url && valueObject(recovered).title === "Seat selection · Gauntlet Air" && valueObject(recovered).setupRan === false, "same-tab recovery failed or timed-out setup ran user code later", recovered)
        const finalTarget = yield* assertTabPreserved(ctx, { sessionId, urlIncludes: tag, envelopes: [recovered] })
        assert(finalTarget.id === original.id && finalTarget.tabId === original.tabId && finalTarget.browserControlSessionId === sessionId, "recovery changed adopted target identity", finalTarget)
        yield* ctx.deleteSession(sessionId)
        const released = (yield* ctx.status()).targets.find((candidate) => candidate.id === original.id)
        assert(released && released.tabId === original.tabId && released.url === url && released.browserControlSessionId === undefined, "deleting the session must release, never close, the adopted user tab", released)
        ctx.note("one-command adopt: yes; exact user tab recovered; failed setup never ran code")
        return { sessionId, oneCommandAdopt: true, readMs: read.durationMs, recoveryMs: recovered.durationMs }
      }).pipe(Effect.ensuring(ctx.deleteSession(sessionId)))
    }),
  },
]
