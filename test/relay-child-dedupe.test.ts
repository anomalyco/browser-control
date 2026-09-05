import net from "node:net"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it } from "vitest"
import { startRelay } from "../src/relay.ts"
import type { CdpEvent, CdpRequest, ExtensionCommand, JsonObject, TargetInfo } from "../src/protocol.ts"

type CdpReply = { readonly id: number; readonly result?: JsonObject; readonly error?: { readonly message: string } }

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

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin: "chrome-extension://browser-control-test" })
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
  it.each(["detach", "same-target", "same-session", "held-page"] as const)("removes the whole child subtree on %s without leaking to hidden clients", async (transition) => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.tryPromise(async () => {
        const endpoint = relay.url.replace("http://", "ws://")
        const extension = await openSocket(`${endpoint}/extension`)
        const extensionCommands: ExtensionCommand[] = []
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as ExtensionCommand
          extensionCommands.push(command)
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
        const hidden = await openSocket(`${endpoint}/devtools/browser/test?browserControlSessionId=hidden`)
        const events: CdpEvent[] = []
        const hiddenEvents: CdpEvent[] = []
        for (const [socket, received] of [[owner, events], [hidden, hiddenEvents]] as const) {
          socket.on("message", (data) => {
            const message = JSON.parse(data.toString()) as CdpEvent | CdpReply
            if ("method" in message) received.push(message)
          })
        }
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
          // The root event shares the extension and owner sockets with all preceding events.
          const delivered = nextMessage(owner, (message) => "method" in message && message.method === "Runtime.consoleAPICalled" && message.params?.timestamp === timestamp)
          emit("Runtime.consoleAPICalled", { type: "log", args: [], executionContextId: 1, timestamp })
          await delivered
        }
        try {
          expect((await send(owner, { method: "Target.createTarget", params: { url: "about:blank" } })).result).toEqual({ targetId: "root-target" })
          await send(hidden, { method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false } })
          const parentInfo = targetInfo("child-target", "iframe")
          emit("Target.attachedToTarget", { sessionId: "child", targetInfo: parentInfo, waitingForDebugger: false })
          emit("Target.attachedToTarget", { sessionId: "grandchild", targetInfo: targetInfo("grandchild-target", "worker"), waitingForDebugger: false }, "child")
          await flush()
          const aliases: string[] = []
          for (const targetId of ["child-target", "grandchild-target"]) {
            const reply = await send(owner, { method: "Target.attachToTarget", params: { targetId, flatten: true } })
            const alias = reply.result?.sessionId
            if (typeof alias !== "string") throw new Error("Expected target alias")
            aliases.push(alias)
          }
          events.length = 0
          const replacementSessionId = transition === "same-session" ? "child" : "child-new"
          const replacementInfo = transition === "held-page"
            ? { ...parentInfo, type: "page" as const, url: "" }
            : { ...parentInfo, targetId: transition === "same-session" ? "child-new-target" : parentInfo.targetId }
          if (transition === "detach") {
            emit("Target.detachedFromTarget", { sessionId: "child", targetId: parentInfo.targetId })
          } else {
            emit("Target.attachedToTarget", { sessionId: replacementSessionId, targetInfo: replacementInfo, waitingForDebugger: false })
          }
          await flush()
          expect(events.filter((event) => event.method.startsWith("Target.")).map((event) => [event.method, event.params?.sessionId])).toEqual([
            ["Target.detachedFromTarget", "grandchild"],
            ["Target.detachedFromTarget", "child"],
            ...(transition === "detach" || transition === "held-page" ? [] : [["Target.attachedToTarget", replacementSessionId]]),
          ])

          const beforeCommands = extensionCommands.length
          expect((await send(owner, { method: "Target.attachToTarget", params: { targetId: "grandchild-target" } })).error?.message).toBe("Target not found: grandchild-target")
          for (const sessionId of ["grandchild", ...aliases]) {
            expect((await send(owner, { method: "Page.getFrameTree", sessionId })).error?.message).toBe(`Unknown CDP session ${sessionId} for Page.getFrameTree`)
          }
          expect(extensionCommands).toHaveLength(beforeCommands)

          emit("Runtime.consoleAPICalled", { type: "log", args: [], executionContextId: 9, timestamp: 999 }, "grandchild")
          emit("Target.attachedToTarget", { sessionId: "late-child", targetInfo: targetInfo("late-target", "worker"), waitingForDebugger: false }, "grandchild")
          await flush()
          expect(events.some((event) => event.method === "Runtime.consoleAPICalled" && event.sessionId === "grandchild")).toBe(false)
          expect(events.some((event) => event.method === "Target.attachedToTarget" && event.params?.sessionId === "late-child")).toBe(false)
          const listed = await send(owner, { method: "Target.getTargets" })
          expect(listed.error).toBeUndefined()
          expect(listed.result?.targetInfos).toEqual([
            expect.objectContaining({ targetId: "root-target" }),
            ...(transition === "detach" || transition === "held-page" ? [] : [expect.objectContaining({ targetId: replacementInfo.targetId })]),
          ])

          if (transition === "held-page") {
            emit("Target.targetInfoChanged", { targetInfo: { ...replacementInfo, url: "https://example.com/visible" } })
            await flush()
            expect(events.filter((event) => event.method === "Target.attachedToTarget").map((event) => event.params?.sessionId)).toEqual([replacementSessionId])
          }
          await send(hidden, { method: "Browser.getVersion" })
          expect(hiddenEvents).toEqual([])
        } finally {
          owner.close()
          hidden.close()
          extension.close()
        }
      })
    })))
  })

  it("keeps an extension-owned child from replacing the tab root", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.tryPromise(async () => {
        const extension = await openSocket(`${relay.url.replace("http://", "ws://")}/extension`)
        const extensionCommands: Array<{ readonly method: string; readonly params?: JsonObject }> = []
        let targetInfoFailures = 0
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: JsonObject }
          extensionCommands.push(command)
          if (command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo" && targetInfoFailures > 0) {
            targetInfoFailures -= 1
            extension.send(JSON.stringify({ id: command.id, error: "transient target probe failure" }))
            return
          }
          const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo("root-target") }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
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
        targetInfoFailures = 2
        extension.send(JSON.stringify({
          method: "debugger.detached",
          params: { tabId: 1, reason: "target_closed" },
        }))
        await waitFor(() => targetInfoFailures === 0)

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
        expect(extensionCommands.some((command) => {
          return command.method === "action.setAttached" && command.params?.attached === false
        })).toBe(false)

        client.close()
        extension.close()
      })
    })))
  })

  it("commits one replacement generation after setup retries", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.tryPromise(async () => {
        const extension = await openSocket(`${relay.url.replace("http://", "ws://")}/extension`)
        let currentTargetId = "root-old"
        let autoAttachFailures = 0
        const extensionCommands: Array<{ readonly method: string; readonly params?: JsonObject }> = []
        extension.on("message", (data) => {
          const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: JsonObject }
          extensionCommands.push(command)
          if (command.method === "debugger.sendCommand" && command.params?.method === "Target.setAutoAttach" && autoAttachFailures > 0) {
            autoAttachFailures -= 1
            currentTargetId = "root-final"
            extension.send(JSON.stringify({ id: command.id, error: "transient auto-attach failure" }))
            extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 1 } }))
            return
          }
          const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
            ? { targetInfo: targetInfo(currentTargetId) }
            : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
        extension.send(JSON.stringify({ method: "toolbar.clicked", params: { tabId: 1 } }))
        await waitFor(() => extensionCommands.some((command) => command.method === "action.setAttached"))

        const client = await openSocket(`${relay.url.replace("http://", "ws://")}/devtools/browser/test`)
        const messages: CdpEvent[] = []
        client.on("message", (data) => {
          const message = JSON.parse(data.toString()) as CdpEvent | { readonly id: number }
          if ("method" in message) messages.push(message)
        })
        client.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
        await waitFor(() => messages.some((message) => message.method === "Target.attachedToTarget"))
        const oldAttach = messages.find((message) => message.method === "Target.attachedToTarget")
        const oldSessionId = typeof oldAttach?.params?.sessionId === "string" ? oldAttach.params.sessionId : undefined
        expect(oldSessionId).toBeDefined()

        currentTargetId = "root-new"
        autoAttachFailures = 1
        extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 1 } }))
        extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 1 } }))

        await waitFor(() => messages.some((message) => {
          return message.method === "Target.attachedToTarget" && message.params?.targetInfo &&
            typeof message.params.targetInfo === "object" && !Array.isArray(message.params.targetInfo) &&
            message.params.targetInfo.targetId === "root-final"
        }))
        const detachIndex = messages.findIndex((message) => message.method === "Target.detachedFromTarget" && message.params?.sessionId === oldSessionId)
        const replacementAttachIndexes = messages.flatMap((message, index) => {
          const info = message.method === "Target.attachedToTarget" ? message.params?.targetInfo : undefined
          return info && typeof info === "object" && !Array.isArray(info) && info.targetId === "root-final" ? [index] : []
        })
        expect(detachIndex).toBeGreaterThanOrEqual(0)
        expect(replacementAttachIndexes).toHaveLength(1)
        expect(detachIndex).toBeLessThan(replacementAttachIndexes[0]!)
        expect(messages.some((message) => {
          const info = message.method === "Target.attachedToTarget" ? message.params?.targetInfo : undefined
          return info && typeof info === "object" && !Array.isArray(info) && info.targetId === "root-new"
        })).toBe(false)
        expect(extensionCommands.filter((command) => {
          return command.method === "debugger.sendCommand" && command.params?.method === "Target.setAutoAttach"
        }).length).toBeGreaterThanOrEqual(3)

        client.close()
        extension.close()
      })
    })))
  })

  it("suppresses service workers while preserving dedicated worker routing", async () => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* startRelay({ port, sessionCatalogPath: null })
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
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
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

        client.send(JSON.stringify({
          id: 3,
          sessionId: "worker-session",
          method: "Target.setAutoAttach",
          params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        }))
        await waitFor(() => extensionCommands.some((command) => {
          return command.method === "debugger.sendCommand" &&
            command.params?.method === "Target.setAutoAttach" &&
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
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
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
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
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

        const rootAttach = messages.find((message): message is CdpEvent => {
          const info = "method" in message && message.method === "Target.attachedToTarget" ? message.params?.targetInfo : undefined
          return info !== undefined && info !== null && typeof info === "object" && !Array.isArray(info) && info.targetId === "root-target"
        })
        const rootSessionId = typeof rootAttach?.params?.sessionId === "string" ? rootAttach.params.sessionId : undefined
        expect(rootSessionId).toBeDefined()
        extension.send(JSON.stringify({ method: "tabs.removed", params: { tabId: 1 } }))
        await waitFor(() => messages.some((message) => {
          return "method" in message && message.method === "Target.detachedFromTarget" && message.params?.sessionId === rootSessionId
        }))

        const detachEvents = messages.filter((message): message is CdpEvent => {
          return "method" in message && message.method === "Target.detachedFromTarget"
        })
        const childDetachIndex = detachEvents.findIndex((event) => event.params?.sessionId === "child-session-2")
        const rootDetachIndex = detachEvents.findIndex((event) => event.params?.sessionId === rootSessionId)
        expect(childDetachIndex).toBeGreaterThanOrEqual(0)
        expect(rootDetachIndex).toBeGreaterThan(childDetachIndex)

        client.close()
        extension.close()
      })
    })))
  })
})
