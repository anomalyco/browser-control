await page.bringToFront()
await showGhostCursor({ size: 24 })
await page.goto("https://en.wikipedia.org/wiki/Main_Page", { waitUntil: "domcontentloaded" })
await page.waitForTimeout(900)

const search = page.locator("#searchInput").first()
await search.hover()
await page.waitForTimeout(500)
await search.click()
await handoff("Search for a Wikipedia topic. Once the page is ready, click Continue.")
const currentUrl = new URL(page.url())
const topic = currentUrl.searchParams.get("search") ?? await page.locator("#searchInput").first().inputValue()
if (!topic.trim()) throw new Error("The Wikipedia search field was left empty")
if (currentUrl.pathname === "/wiki/Main_Page") {
  await page.keyboard.press("Enter")
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1200)
}

const links = page.locator("#mw-content-text a")
for (const name of ["user interface", "computer", "interaction"]) {
  const link = links.filter({ hasText: name }).first()
  if (await link.count()) {
    await link.scrollIntoViewIfNeeded()
    await link.hover()
    await page.waitForTimeout(700)
  }
}

const next = links.filter({ hasText: "user interface" }).first()
if (await next.count()) {
  await next.scrollIntoViewIfNeeded()
  await next.hover()
  await page.waitForTimeout(700)
  await next.click()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1800)
}

const cursor = await page.evaluate(() => {
  const element = document.getElementById("__browser_control_ghost_cursor__")
  return element
    ? {
        targetX: element.dataset.targetX,
        targetY: element.dataset.targetY,
        transform: element.style.transform,
        opacity: element.style.opacity,
      }
    : null
})

return { topic, url: page.url(), title: await page.title(), cursor }
