import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type BrowserContext, type Worker } from "playwright-core"
import { WebSocketServer } from "ws"

// An isolated profile and relay keep this proof away from the user's browser.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-ownership-"))
const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
await new Promise<void>((resolve) => server.once("listening", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
const inventories: number[][] = []
server.on("connection", (socket) => {
  const tabs: number[] = []
  socket.on("message", (data) => {
    const message = JSON.parse(String(data))
    if (message.method === "debugger.attached") tabs.push(message.params.tabId)
    if (message.method === "ready") inventories.push(tabs)
  })
})
const shim = path.join(root, "shim")
const foreign = path.join(root, "foreign")
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
try {
  await fs.cp("extension/dist", shim, { recursive: true })
  const background = path.join(shim, "background.js")
  const source = await fs.readFile(background, "utf8")
  assert.ok(source.includes("19989"))
  await fs.writeFile(background, source.replace("19989", String(address.port)))
  await fs.mkdir(foreign)
  await fs.writeFile(path.join(foreign, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Foreign debugger fixture", version: "1.0.0",
    permissions: ["debugger"], background: { service_worker: "foreign.js" },
  }))
  await fs.writeFile(path.join(foreign, "foreign.js"), "chrome.runtime.onInstalled.addListener(() => {})")
  context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${shim},${foreign}`, `--load-extension=${shim},${foreign}`],
  })
  const [owner, other] = await Promise.all([
    extensionWorker(context, "/background.js"),
    extensionWorker(context, "/foreign.js"),
  ])
  const ownedId = await owner.evaluate(attachTab)
  const foreignId = await other.evaluate(attachTab)
  const globalIds = await owner.evaluate(async () => (await chrome.debugger.getTargets()).filter((target) => target.attached).map((target) => target.tabId))
  assert.ok(globalIds.includes(ownedId) && globalIds.includes(foreignId), "Reproduce the ambiguous global attached flag")
  inventories.length = 0
  for (const client of server.clients) client.close()
  const deadline = Date.now() + 10_000
  while (!inventories.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(inventories.at(-1), [ownedId], "Reconnect must announce only the extension-owned tab")
  console.log("PASS native foreign debugger attachment is excluded from the reconnect inventory")
} finally {
  await context?.close()
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
}

async function extensionWorker(context: BrowserContext, suffix: string): Promise<Worker> {
  const predicate = (worker: Worker) => worker.url().endsWith(suffix)
  return context.serviceWorkers().find(predicate)
    ?? context.waitForEvent("serviceworker", { predicate, timeout: 10_000 })
}

async function attachTab(): Promise<number> {
  const tab = await chrome.tabs.create({ url: "about:blank" })
  if (tab.id === undefined) throw new Error("Fixture tab has no id")
  await chrome.debugger.attach({ tabId: tab.id }, "1.3")
  return tab.id
}
