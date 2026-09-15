import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { createSnapshotHelpers } from "../src/execute.ts"

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<button><img alt="Garden Bowl"> <span>Garden Bowl</span> <span>$15.00</span></button>')
  const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
  const outline = await snapshot()
  const name = outline.match(/button "([^"]+)"/)?.[1]
  assert.ok(name, outline)
  assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, `Snapshot name must locate the real button: ${outline}`)
  await page.setContent('<button><img alt="Ignore me" aria-hidden="true"> <img alt=""/> Save</button>')
  assert.match(await snapshot(), /button "Save"/)
  console.log("PASS snapshot image name matches Playwright")
} finally {
  await browser.close()
}
