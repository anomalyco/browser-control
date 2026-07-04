import net from "node:net"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it } from "vitest"
import { startRelay } from "../src/relay.ts"
import type { CdpEvent, JsonObject, TargetInfo } from "../src/protocol.ts"

function targetInfo(targetId: string, type: "page" | "iframe" = "page"): TargetInfo {
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

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  return socket
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for relay test condition")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("relay child target announce dedupe", () => {
  it("resumes unsupported child targets without exposing them to Playwright", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* startRelay({ port })
      yield* Effect.tryPromise(async () => {
        const extension = await openSocket(`ws://127.0.0.1:${port}/extension`)
        const extensionCommands: Array<{ readonly method: string; readonly params?: JsonObject }> = []
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: JsonObject }
          extensionCommands.push(command)
          const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo("root-target") }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.10" } }))
        extension.send(JSON.stringify({ method: "toolbar.clicked", params: { tabId: 1 } }))
        await waitFor(() => extensionCommands.some((command) => command.method === "action.setAttached"))

        const client = await openSocket(`ws://127.0.0.1:${port}/devtools/browser/test`)
        const messages: Array<CdpEvent | { readonly id: number }> = []
        client.on("message", (data) => {
          messages.push(JSON.parse(data.toString()) as CdpEvent | { readonly id: number })
        })
        client.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }))
        await waitFor(() => messages.some((message) => "method" in message && message.method === "Target.attachedToTarget"))

        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.attachedToTarget",
            params: {
              sessionId: "service-worker-session",
              targetInfo: {
                targetId: "service-worker-target",
                type: "service_worker",
                title: "Service Worker",
                url: "https://example.com/service-worker.js",
                attached: true,
                canAccessOpener: false,
              },
              waitingForDebugger: true,
            },
          },
        }))

        await waitFor(() => extensionCommands.some((command) => {
          return command.method === "debugger.sendCommand" &&
            command.params?.method === "Runtime.runIfWaitingForDebugger" &&
            command.params?.sessionId === "service-worker-session"
        }))
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(messages.some((message) => {
          return "method" in message &&
            message.method === "Target.attachedToTarget" &&
            message.params?.sessionId === "service-worker-session"
        })).toBe(false)

        client.close()
        extension.close()
      })
    })))
  })

  it("detaches the old child session before broadcasting a live re-attach for the same child target id", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port })
      yield* Effect.tryPromise(async () => {
        const extension = await openSocket(`${relay.url.replace("http://", "ws://")}/extension`)
        const extensionCommands: string[] = []
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: JsonObject }
          extensionCommands.push(command.method)
          const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo("root-target") }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.7" } }))
        extension.send(JSON.stringify({ method: "toolbar.clicked", params: { tabId: 1 } }))
        await waitFor(() => extensionCommands.includes("action.setAttached"))

        const client = await openSocket(`${relay.url.replace("http://", "ws://")}/devtools/browser/test`)
        const messages: Array<CdpEvent | { readonly id: number }> = []
        client.on("message", (data) => {
          messages.push(JSON.parse(data.toString()) as CdpEvent | { readonly id: number })
        })
        client.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
        await waitFor(() => messages.some((message) => "method" in message && message.method === "Target.attachedToTarget"))

        const childTargetInfo = targetInfo("child-target", "iframe")
        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.attachedToTarget",
            params: { sessionId: "child-session-1", targetInfo: childTargetInfo, waitingForDebugger: false },
          },
        }))
        await waitFor(() => messages.filter((message) => "method" in message && message.method === "Target.attachedToTarget").length >= 2)

        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.attachedToTarget",
            params: { sessionId: "child-session-2", targetInfo: childTargetInfo, waitingForDebugger: false },
          },
        }))
        await waitFor(() => messages.some((message) => "method" in message && message.method === "Target.detachedFromTarget"))

        const childEvents = messages.filter((message): message is CdpEvent => {
          return "method" in message && (message.method === "Target.attachedToTarget" || message.method === "Target.detachedFromTarget")
        }).filter((message) => {
          const params = message.params
          return params && (params.sessionId === "child-session-1" || params.sessionId === "child-session-2")
        })

        expect(childEvents.map((event) => [event.method, event.params?.sessionId])).toEqual([
          ["Target.attachedToTarget", "child-session-1"],
          ["Target.detachedFromTarget", "child-session-1"],
          ["Target.attachedToTarget", "child-session-2"],
        ])

        client.close()
        extension.close()
      })
    })))
  })
})
