import net from "node:net"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it } from "vitest"
import { startRelay } from "../src/relay.ts"
import type { CdpEvent, JsonObject, TargetInfo } from "../src/protocol.ts"

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
  it("keeps an extension-owned child from replacing the tab root", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port })
      yield* Effect.tryPromise(async () => {
        const extension = await openSocket(`${relay.url.replace("http://", "ws://")}/extension`)
        const extensionCommands: Array<{ readonly method: string; readonly params?: JsonObject }> = []
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: JsonObject }
          extensionCommands.push(command)
          const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo("root-target") }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.17" } }))
        extension.send(JSON.stringify({ method: "toolbar.clicked", params: { tabId: 1 } }))
        await waitFor(() => extensionCommands.some((command) => command.method === "action.setAttached"))

        const client = await openSocket(`${relay.url.replace("http://", "ws://")}/devtools/browser/test`)
        const messages: Array<CdpEvent | { readonly id: number; readonly result?: JsonObject }> = []
        client.on("message", (data) => {
          messages.push(JSON.parse(data.toString()) as CdpEvent | { readonly id: number; readonly result?: JsonObject })
        })
        client.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
        await waitFor(() => messages.some((message) => "method" in message && message.method === "Target.attachedToTarget"))
        const rootAttach = messages.find((message): message is CdpEvent => "method" in message && message.method === "Target.attachedToTarget")
        const rootSessionId = typeof rootAttach?.params?.sessionId === "string" ? rootAttach.params.sessionId : undefined
        expect(rootSessionId).toBeDefined()

        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.targetInfoChanged",
            params: { targetInfo: { ...targetInfo("unknown-extension-child"), title: "", url: "about:blank" } },
          },
        }))
        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.attachedToTarget",
            params: {
              sessionId: "password-manager-child-session",
              targetInfo: { ...targetInfo("password-manager-child"), title: "", url: "" },
              waitingForDebugger: false,
            },
          },
        }))
        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            sessionId: "password-manager-child-session",
            method: "Runtime.executionContextCreated",
            params: { context: { id: 99, origin: "chrome-extension://password-manager", auxData: { isDefault: true } } },
          },
        }))
        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            sessionId: "password-manager-child-session",
            method: "Target.targetInfoChanged",
            params: {
              targetInfo: {
                ...targetInfo("password-manager-child"),
                title: "Password manager",
                url: "chrome-extension://password-manager/popup.html",
              },
            },
          },
        }))
        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            sessionId: "password-manager-child-session",
            method: "Runtime.executionContextCreated",
            params: { context: { id: 100, origin: "chrome-extension://password-manager", auxData: { isDefault: true } } },
          },
        }))
        extension.send(JSON.stringify({
          method: "debugger.detached",
          params: { tabId: 1, reason: "target_closed", sessionId: "password-manager-child-session" },
        }))
        extension.send(JSON.stringify({
          method: "debugger.detached",
          params: { tabId: 1, reason: "target_closed" },
        }))

        client.send(JSON.stringify({ id: 2, sessionId: rootSessionId, method: "Target.getTargetInfo", params: {} }))
        client.send(JSON.stringify({ id: 3, sessionId: rootSessionId, method: "Page.navigate", params: { url: "https://example.com/after-focus" } }))
        await waitFor(() => messages.some((message) => "id" in message && message.id === 3))

        const targetInfoResponse = messages.find((message) => "id" in message && message.id === 2)
        expect(targetInfoResponse && "result" in targetInfoResponse ? targetInfoResponse.result : undefined).toMatchObject({
          targetInfo: { targetId: "root-target", url: "https://example.com/" },
        })
        expect(messages.some((message) => {
          return "method" in message &&
            message.method === "Target.attachedToTarget" &&
            message.params?.sessionId === "password-manager-child-session"
        })).toBe(false)
        expect(messages.some((message) => {
          return "method" in message &&
            message.method === "Runtime.executionContextCreated" &&
            message.sessionId === "password-manager-child-session"
        })).toBe(false)
        expect(extensionCommands).toContainEqual(expect.objectContaining({
          method: "debugger.sendCommand",
          params: expect.objectContaining({
            method: "Page.navigate",
            tabId: 1,
          }),
        }))
        const navigateCommand = extensionCommands.find((command) => command.method === "debugger.sendCommand" && command.params?.method === "Page.navigate")
        expect(navigateCommand?.params?.sessionId).toBeUndefined()

        client.close()
        extension.close()
      })
    })))
  })

  it("suppresses service workers while preserving dedicated worker routing", async () => {
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
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.11" } }))
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

        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.targetCreated",
            params: {
              targetInfo: {
                targetId: "service-worker-created-target",
                type: "service_worker",
                title: "Service Worker",
                url: "https://example.com/created-service-worker.js",
                attached: false,
                canAccessOpener: false,
              },
            },
          },
        }))
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(messages.some((message) => {
          const targetInfo = "method" in message && message.method === "Target.targetCreated" ? message.params?.targetInfo : undefined
          return targetInfo && typeof targetInfo === "object" && !Array.isArray(targetInfo) && targetInfo.targetId === "service-worker-created-target"
        })).toBe(false)

        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Target.attachedToTarget",
            params: {
              sessionId: "worker-session",
              targetInfo: targetInfo("worker-target", "worker"),
              waitingForDebugger: true,
            },
          },
        }))
        await waitFor(() => messages.some((message) => {
          return "method" in message &&
            message.method === "Target.attachedToTarget" &&
            message.params?.sessionId === "worker-session"
        }))
        expect(extensionCommands.some((command) => {
          return command.method === "debugger.sendCommand" &&
            command.params?.method === "Runtime.runIfWaitingForDebugger" &&
            command.params?.sessionId === "worker-session"
        })).toBe(false)

        client.send(JSON.stringify({ id: 2, sessionId: "worker-session", method: "Runtime.runIfWaitingForDebugger", params: {} }))
        await waitFor(() => extensionCommands.some((command) => {
          return command.method === "debugger.sendCommand" &&
            command.params?.method === "Runtime.runIfWaitingForDebugger" &&
            command.params?.sessionId === "worker-session"
        }))

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
