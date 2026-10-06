import { Effect } from "effect"
import type { GauntletCase } from "./cases.ts"
import { getObject } from "../src/relay-helpers.ts"
import { assert, assertTabPreserved, withSession } from "./harness.ts"

/** Driver transport success is not a receipt. These outcomes share the same redirect and empty form. */
export const formCases: readonly GauntletCase[] = ["accepted", "rejected", "empty"].map((outcome) => ({
  name: `contact-form-${outcome}`,
  summary: `Native ref fill/click with iframe churn, redirect, and explicit ${outcome} outcome verification`,
  fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/contact-form.html?outcome=${outcome}`,
  budgetMs: 20_000,
  run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
    const url = `${ctx.fixtures.primaryOrigin}/contact-form.html?outcome=${outcome}`
    const opened = yield* ctx.execute({ sessionId, code: `await page.goto(${JSON.stringify(url)}); return await snapshot()` })
    assert(opened.ok && typeof opened.value === "string", "contact form snapshot failed", opened)
    const formSnapshot = opened.value
    const refs = Object.fromEntries(["Name", "Email", "Message", "Send"].map((name) => {
      const line = formSnapshot.split("\n").find((line) => line.includes(`"${name}"`))
      const id = line?.match(/ref=(e\d+)/)?.[1]
      assert(id, `Missing ${name} ref`, opened.value)
      return [name, id]
    }))
    const entered = yield* ctx.execute({ sessionId, code: `
const started = performance.now()
await ref(${JSON.stringify(refs.Name)}).fill('Example Person', { timeout: 3000 })
await ref(${JSON.stringify(refs.Email)}).fill('person@example.test', { timeout: 3000 })
await ref(${JSON.stringify(refs.Message)}).fill('Local fixture inquiry', { timeout: 3000 })
return { fillMs: performance.now() - started, valid: await page.evaluate(() => document.querySelector('form').checkValidity()) }
` })
    if (!entered.ok) {
      // Read-only differential probe; never repeat input after an uncertain act.
      const probe = yield* ctx.execute({ sessionId, timeoutMs: 5000, code: `
const main = await page.evaluate(() => ({ ready: document.readyState, form: !!document.querySelector('form') }))
let utility = false
try { utility = (await page.locator('body').innerText({ timeout: 1000 })).includes('Contact') } catch {}
return { main, utility }
` })
      ctx.note(`failed fill follow-up: ${JSON.stringify({ ok: probe.ok, value: probe.value, diagnostic: probe.diagnostic })}`)
    }
    assert(entered.ok, "native ref fill stalled", entered)
    assert(entered.value && typeof entered.value === "object" && "valid" in entered.value && entered.value.valid === true, "native fill returned without a valid form", entered)
    const sent = yield* ctx.execute({ sessionId, code: `
// Register the expected navigation before a single outward mutation.
await Promise.all([
  page.waitForURL(url => url.searchParams.has('result'), { waitUntil: 'domcontentloaded', timeout: 5000 }),
  ref(${JSON.stringify(refs.Send)}).click({ timeout: 5000 }),
])
return { url: page.url(), snapshot: await snapshot(), body: await page.locator('body').innerText({ timeout: 3000 }), empty: await page.evaluate(() => document.querySelector('textarea').value === '') }
` })
    if (!sent.ok) {
      const probe = yield* ctx.execute({ sessionId, timeoutMs: 5000, code: `return await page.evaluate(() => ({ ready: document.readyState, valid: document.querySelector('form')?.checkValidity(), input: window.__gauntlet }))` })
      ctx.note(`failed click follow-up: ${JSON.stringify({ ok: probe.ok, value: probe.value, diagnostic: probe.diagnostic })}`)
    }
    assert(sent.ok && sent.value && typeof sent.value === "object", "native click/navigation/fresh reads failed", sent)
    const result = getObject(sent.value)
    assert(result && typeof result.url === "string" && typeof result.snapshot === "string" && typeof result.body === "string", "invalid form result", sent)
    assert(result.empty && result.url.includes("result=1"), "fixture did not redirect and clear the form", result)
    const receipt = result.body.includes("Receipt LOCAL-001.")
    const rejection = result.body.includes("Submission blocked.")
    assert(receipt === (outcome === "accepted") && rejection === (outcome === "rejected"), "read the wrong document or inferred success from navigation", result)
    if (outcome !== "empty") assert(result.snapshot.includes(outcome === "accepted" ? "Receipt LOCAL-001." : "Submission blocked."), "snapshot omitted outcome evidence", result)
    const stale = yield* ctx.execute({ sessionId, code: `return ref(${JSON.stringify(refs.Send)})` })
    assert(stale.isError && /Unknown snapshot ref|stale/.test(stale.text), "old ref survived document navigation", stale)
    const reloaded = yield* ctx.execute({ sessionId, code: `
const before = await snapshot()
const id = before.split('\\n').find(line => line.includes('button "Send"')).match(/ref=(e\\d+)/)[1]
const url = page.url()
await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 })
let stale = false
try { ref(id) } catch (error) { stale = /Unknown snapshot ref|stale/.test(error.message) }
return { sameUrl: page.url() === url, stale, observed: await snapshot() }
` })
    assert(reloaded.ok && reloaded.value && typeof reloaded.value === "object" && "stale" in reloaded.value && reloaded.value.stale === true && "sameUrl" in reloaded.value && reloaded.value.sameUrl === true, "same-URL navigation retained stale refs", reloaded)
    yield* assertTabPreserved(ctx, { sessionId, urlIncludes: "/contact-form.html", envelopes: [opened, entered, sent, stale] })
    ctx.note(`fill=${entered.durationMs}ms submit+verify=${sent.durationMs}ms; outcome=${receipt ? "receipt" : rejection ? "rejected" : "unverified"}`)
    return { fillMs: entered.durationMs, submitVerifyMs: sent.durationMs, outcome: receipt ? "receipt" : rejection ? "rejected" : "unverified" }
  })),
}))
