import net from "node:net"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it } from "vitest"
import { startRelay } from "../src/relay.ts"
import type { CdpEvent, CdpRequest, ExtensionCommand, JsonObject, TargetInfo } from "../src/protocol.ts"

type CdpReply = { readonly id: number; readonly result?: JsonObject; readonly error?: { readonly message: string } }

const crossExtensionError = "Cannot access a chrome-extension:// URL of different extension"
const protectedFrameUrl = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/menu/menu.html?frameIdentifier=1"

function nextMessage(socket: WebSocket, matches: (message: CdpEvent | CdpReply) => boolean): Promise<CdpEvent | CdpReply> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage)
      reject(new Error("Timed out waiting for relay message"))
    }, 2_000)
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as CdpEvent | CdpReply
      if (!matches(message)) return
      clearTimeout(timeout)
      socket.off("message", onMessage)
      resolve(message)
    }
    socket.on("message", onMessage)
  })
}

function targetInfo(targetId: string, type: TargetInfo["type"] = "page"): TargetInfo {
  return { targetId, type, title: targetId, url: "https://example.com/", attached: true, canAccessOpener: false }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address")
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function protectedUi(relayUrl: string): Promise<boolean | undefined> {
  const response = await fetch(new URL("/extension/status", relayUrl))
  const status = await response.json() as { readonly targets: ReadonlyArray<{ readonly tabId?: number; readonly protectedUi?: boolean }> }
  const target = status.targets.find((candidate) => candidate.tabId === 1)
  if (!target) throw new Error("Expected the attached tab in extension status")
  return target.protectedUi
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin: "chrome-extension://browser-control-test" })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  return socket
}

/**
 * A password manager's inline menu is a `chrome-extension://` iframe that
 * another extension injects into the page on focus. Chrome reports it to the
 * root session as an ordinary child frame, but the relay can never expose its
 * OOPIF target, and while it exists `chrome.debugger` rejects every command for
 * the tab. Stock Playwright would otherwise keep an empty-URL phantom frame and
 * rewrite the rejection into "Execution context was destroyed".
 */
describe("relay protected frames", () => {
  it("retracts a protected child frame, suppresses its events, and tracks the debugger block", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.tryPromise(async () => {
        const endpoint = relay.url.replace("http://", "ws://")
        const extension = await openSocket(`${endpoint}/extension`)
        let rejectDebuggerCommands = false
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as ExtensionCommand
          if (command.method === "debugger.sendCommand" && command.params?.method === "Runtime.evaluate" && rejectDebuggerCommands) {
            extension.send(JSON.stringify({ id: command.id, error: crossExtensionError }))
            return
          }
          const result = command.method === "tabs.create"
            ? { tabId: 1 }
            : command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo("root-target") }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2 } }))
        extension.send(JSON.stringify({ method: "ready" }))
        const owner = await openSocket(`${endpoint}/devtools/browser/test?browserControlSessionId=owner`)
        const events: CdpEvent[] = []
        owner.on("message", (data) => {
          const message = JSON.parse(data.toString()) as CdpEvent | CdpReply
          if ("method" in message) events.push(message)
        })
        let requestId = 0
        const send = async (socket: WebSocket, request: Omit<CdpRequest, "id">): Promise<CdpReply> => {
          const id = ++requestId
          const response = nextMessage(socket, (message) => "id" in message && message.id === id)
          socket.send(JSON.stringify({ ...request, id }))
          const message = await response
          if (!("id" in message)) throw new Error("Expected CDP reply")
          return message
        }
        const emit = (method: string, params: JsonObject, sessionId?: string) => {
          extension.send(JSON.stringify({ method: "debugger.event", params: { tabId: 1, method, params, ...(sessionId ? { sessionId } : {}) } }))
        }
        let marker = 0
        const flush = async () => {
          const timestamp = ++marker
          const delivered = nextMessage(owner, (message) => "method" in message && message.method === "Runtime.consoleAPICalled" && message.params?.timestamp === timestamp)
          emit("Runtime.consoleAPICalled", { type: "log", args: [], executionContextId: 1, timestamp })
          await delivered
        }
        const pageEvents = () => events
          .filter((event) => event.method.startsWith("Page."))
          .map((event) => [event.method, event.params?.frameId ?? (event.params?.frame as JsonObject | undefined)?.id, event.params?.reason ?? event.params?.url ?? event.params?.name])
        try {
          expect((await send(owner, { method: "Target.createTarget", params: { url: "about:blank" } })).result).toEqual({ targetId: "root-target" })
          const rootSession = events.find((event) => event.method === "Target.attachedToTarget")?.params?.sessionId
          if (typeof rootSession !== "string") throw new Error("Expected the root target announcement")
          emit("Page.frameNavigated", { frame: { id: "root-target", url: "https://example.com/pay", loaderId: "main-loader", securityOrigin: "https://example.com", mimeType: "text/html" } })

          // An ordinary same-process child frame flows through untouched.
          emit("Page.frameAttached", { frameId: "payment-frame", parentFrameId: "root-target" })
          emit("Page.frameStartedNavigating", { frameId: "payment-frame", loaderId: "pay-loader", navigationType: "differentDocument", url: "https://pay.example.net/frame" })
          emit("Page.frameNavigated", { frame: { id: "payment-frame", parentId: "root-target", url: "https://pay.example.net/frame", loaderId: "pay-loader", securityOrigin: "https://pay.example.net", mimeType: "text/html" } })
          await flush()
          events.length = 0

          // Focusing the card field makes a password manager inject its inline menu.
          emit("Page.frameAttached", { frameId: "menu-frame", parentFrameId: "root-target", stack: { callFrames: [{ url: "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/injected.js", functionName: "draw", lineNumber: 39, columnNumber: 1, scriptId: "32" }] } })
          emit("Page.lifecycleEvent", { frameId: "menu-frame", loaderId: "menu-initial", name: "init", timestamp: 1 })
          emit("Page.frameRequestedNavigation", { frameId: "menu-frame", reason: "initialFrameNavigation", url: protectedFrameUrl, disposition: "currentTab" })
          emit("Page.frameStartedNavigating", { frameId: "menu-frame", loaderId: "menu-loader", navigationType: "differentDocument", url: protectedFrameUrl })
          emit("Page.frameStartedLoading", { frameId: "menu-frame" })
          emit("Page.lifecycleEvent", { frameId: "menu-frame", loaderId: "menu-loader", name: "commit", timestamp: 2 })
          await flush()
          expect(pageEvents()).toEqual([
            ["Page.frameAttached", "menu-frame", undefined],
            ["Page.lifecycleEvent", "menu-frame", "init"],
            ["Page.frameDetached", "menu-frame", "remove"],
          ])
          expect(events.filter((event) => event.method === "Page.frameDetached").map((event) => event.sessionId)).toEqual([rootSession])

          // Chrome now refuses every debugger command for the tab; the relay records the block on the root target.
          rejectDebuggerCommands = true
          const rejected = await send(owner, { method: "Runtime.evaluate", params: { expression: "1" }, sessionId: rootSession })
          expect(rejected.error?.message).toBe(crossExtensionError)
          expect(await protectedUi(relay.url)).toBe(true)

          // Events for the protected frame stay hidden, including its real removal.
          events.length = 0
          emit("Page.lifecycleEvent", { frameId: "menu-frame", loaderId: "menu-loader", name: "load", timestamp: 3 })
          emit("Page.frameStoppedLoading", { frameId: "menu-frame" })
          emit("Page.frameDetached", { frameId: "menu-frame", reason: "remove" })
          emit("Page.lifecycleEvent", { frameId: "payment-frame", loaderId: "pay-loader", name: "networkIdle", timestamp: 4 })
          await flush()
          expect(pageEvents()).toEqual([
            ["Page.lifecycleEvent", "payment-frame", "networkIdle"],
          ])
          // Dismissing the menu lifts the block before any command is retried.
          expect(await protectedUi(relay.url)).toBeUndefined()

          rejectDebuggerCommands = false
          expect((await send(owner, { method: "Runtime.evaluate", params: { expression: "1" }, sessionId: rootSession })).error).toBeUndefined()
          expect(await protectedUi(relay.url)).toBeUndefined()
        } finally {
          owner.close()
          extension.close()
        }
      })
    })))
  })

  it("clears the debugger block when a later command succeeds", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.tryPromise(async () => {
        const endpoint = relay.url.replace("http://", "ws://")
        const extension = await openSocket(`${endpoint}/extension`)
        let rejectDebuggerCommands = false
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as ExtensionCommand
          if (command.method === "debugger.sendCommand" && command.params?.method === "Runtime.evaluate" && rejectDebuggerCommands) {
            extension.send(JSON.stringify({ id: command.id, error: crossExtensionError }))
            return
          }
          const result = command.method === "tabs.create"
            ? { tabId: 1 }
            : command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo("root-target") }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2 } }))
        extension.send(JSON.stringify({ method: "ready" }))
        const owner = await openSocket(`${endpoint}/devtools/browser/test?browserControlSessionId=owner`)
        let requestId = 0
        const send = async (request: Omit<CdpRequest, "id">): Promise<CdpReply> => {
          const id = ++requestId
          const response = nextMessage(owner, (message) => "id" in message && message.id === id)
          owner.send(JSON.stringify({ ...request, id }))
          const message = await response
          if (!("id" in message)) throw new Error("Expected CDP reply")
          return message
        }
        try {
          expect((await send({ method: "Target.createTarget", params: { url: "about:blank" } })).result).toEqual({ targetId: "root-target" })
          const rootSession = (await send({ method: "Target.attachToTarget", params: { targetId: "root-target", flatten: true } })).result?.sessionId
          if (typeof rootSession !== "string") throw new Error("Expected a root session alias")
          rejectDebuggerCommands = true
          expect((await send({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: rootSession })).error?.message).toBe(crossExtensionError)
          expect(await protectedUi(relay.url)).toBe(true)
          rejectDebuggerCommands = false
          expect((await send({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: rootSession })).error).toBeUndefined()
          expect(await protectedUi(relay.url)).toBeUndefined()
        } finally {
          owner.close()
          extension.close()
        }
      })
    })))
  })
})
