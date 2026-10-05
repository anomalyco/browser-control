import assert from "node:assert/strict"
import { Effect } from "effect"
import { chromium } from "playwright-core"
import { recoverSessionPage } from "../src/execute.ts"

// Disposable Chromium process: never connects to the user's browser or relay.
const browser = await chromium.launch({ channel: "chromium", headless: true })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const unrelated = await context.newPage()
  await page.setContent('<label>Draft<input aria-label="Draft"></label>')
  await page.getByLabel("Draft").fill("synthetic unsaved draft")
  await unrelated.setContent("<h1>Unrelated tab</h1>")
  assert.equal(page.url(), "about:blank")

  const result = await Effect.runPromise(recoverSessionPage({
    ownsPage: true,
    get url() { return page.url() },
    timeoutMs: 100,
    // Deterministic fault injection at the page-health boundary.
    healthCheck: async () => { throw new Error("Execution context was destroyed") },
    close: () => page.close(),
  }))
  assert.equal(result, "repair")
  assert.equal(page.isClosed(), false)
  assert.equal(await page.getByLabel("Draft").inputValue(), "synthetic unsaved draft")
  assert.equal(await unrelated.locator("h1").innerText(), "Unrelated tab")
  assert.equal(context.pages().length, 2)
  console.log("PASS: failed page health check preserves an about:blank draft and unrelated tab")
} finally {
  await browser.close()
}
