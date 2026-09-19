import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { createSnapshotHelpers } from "../src/execute.ts"

// Real DOM and Playwright locators: deliberately separate from browser-free unit tests.
const browser = await chromium.launch()
const page = await browser.newPage()
const failures: string[] = []
const check = async (name: string, run: () => Promise<void>) => {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}
try {
  for (const [type, role] of [["number", "spinbutton"], ["search", "searchbox"]] as const) {
    await check(`${type} input refs`, async () => {
      await page.setContent(`<main><label>Amount<input type="${type}" name="amount"></label></main>`)
      const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
      const outline = await snapshot()
      assert.match(outline, new RegExp(`${role} "Amount"`))
      const id = outline.match(/ref=(e\d+)/)?.[1]
      assert.ok(id)
      await ref(id).fill("12", { timeout: 1_000 })
      assert.equal(await page.getByRole(role, { name: "Amount" }).inputValue(), "12")
    })
  }
  await check("native summary ref", async () => {
    await page.setContent('<main><details><summary>Show details</summary><p>Revealed</p></details></main>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    const id = outline.match(/(?:button|summary) "Show details" \[ref=(e\d+)/)?.[1]
    assert.ok(id, outline)
    await ref(id).click({ timeout: 1_000 })
    assert.equal(await page.locator("details").getAttribute("open"), "")
  })
  await check("portal dialog outside main", async () => {
    await page.setContent('<main><h1>Background</h1><button>Open account</button></main><div role="dialog" aria-modal="true" aria-label="New account"><label>Name<input></label><button>Save account</button></div>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /dialog "New account"/)
    const id = outline.match(/button "Save account" \[ref=(e\d+)/)?.[1]
    assert.ok(id, outline)
    assert.equal(await ref(id).count(), 1)
    assert.match(await snapshot({ within: "main" }), /heading "Background"/)
  })
  await check("nested product list budget", async () => {
    await page.setContent(`<main><h1>Products</h1>${Array.from({ length: 100 }, (_, i) => `<ul><li><ul><li><a href="#product-${i}">Strawberry product ${i}</a><button>Add product ${i}</button></li></ul></li></ul>`).join("")}</main>`)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot({ maxItems: 30 })
    assert.match(outline, /link "Strawberry product 0"/)
    assert.match(outline, /list "List"/)
    const id = outline.match(/link "Strawberry product 0" \[ref=(e\d+)/)?.[1]
    assert.ok(id, outline)
    assert.equal(await ref(id).count(), 1)
    assert.ok(outline.split("\n").length <= 31)
  })
  await check("explicit summary role is preserved", async () => {
    await page.setContent('<main><details><summary role="button">Explicit button</summary><p>Details</p></details></main>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    assert.match(await snapshot(), /button "Explicit button" \[ref=e1/)
    await ref("e1").click({ timeout: 1_000 })
    assert.equal(await page.locator("details").getAttribute("open"), "")
  })
  await check("non-modal portal and background remain visible", async () => {
    await page.setContent('<main><h1>Background</h1></main><div role="dialog" aria-label="Help"><button>Close help</button></div>')
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /heading "Background"/)
    assert.match(outline, /button "Close help"/)
  })
  await check("hidden modal does not hide main", async () => {
    await page.setContent('<main><h1>Background</h1></main><div role="dialog" aria-modal="true" hidden><button>Invisible</button></div>')
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /heading "Background"/)
    assert.doesNotMatch(outline, /Invisible/)
  })
} finally {
  await browser.close()
}
assert.deepEqual(failures, [], "Snapshot regressions failed")
