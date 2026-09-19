import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright-core"
import { PNG } from "pngjs"

// Standalone upstream reproduction. This intentionally fails while the bug
// exists; it is not part of the browser-free test suite or release gates.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-zoom-"))
await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "Local zoom fixture", version: "1.0", permissions: ["tabs"],
  background: { service_worker: "background.js" },
}))
await fs.writeFile(path.join(directory, "background.js"), "chrome.runtime.onInstalled.addListener(() => {})")
try {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    viewport: { width: 1440, height: 1100 },
  })
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    await page.route("http://zoom.test/", (route) => route.fulfill({ contentType: "text/html", body: '<style>html,body{margin:0}body{height:1600px;background:white}.edge{position:absolute;right:0;top:0;width:40px;height:1600px;background:rgb(0,255,0)}</style><div class="edge"></div>' }))
    await page.goto("http://zoom.test/")
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: "http://zoom.test/" })
      await chrome.tabs.setZoom(tabs[0]!.id!, 1.1)
    })
    const image = PNG.sync.read(await page.screenshot({ fullPage: true, scale: "css" }))
    const offset = (Math.floor(image.height / 4) * image.width + image.width - 10) * 4
    const pixel = [...image.data.subarray(offset, offset + 3)]
    console.log({ width: image.width, height: image.height, rightEdge: pixel })
    assert.deepEqual(pixel, [0, 255, 0], "Full-page screenshot lost the right edge at browser zoom 110%")
  } finally {
    await context.close()
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
