import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { startRelay } from "../src/relay.ts"
import type { CdpEvent, CdpRequest, JsonObject } from "../src/protocol.ts"

type CdpMessage = CdpEvent | { readonly id: number; readonly result?: JsonObject; readonly error?: { readonly message: string } }

describe("relay target visibility pruning", () => {
  it("detaches raw relay targets from a session client once that session gains an owned target", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectFakeExtension(relay.url))
      const rawClient = yield* Effect.promise(() => connectCdpClient(relay.url))
      const sessionClient = yield* Effect.promise(() => connectCdpClient(relay.url, "session-a"))

      try {
        yield* Effect.promise(() => sendCdp(rawClient, { id: 1, method: "Browser.getVersion" }))
        const rawCreate = yield* Effect.promise(() => sendCdp(rawClient, { id: 2, method: "Target.createTarget", params: { url: "about:blank" } }))
        expect(rawCreate.result?.targetId).toBe("target-1")

        yield* Effect.promise(() => sendCdp(sessionClient, { id: 3, method: "Browser.getVersion" }))
        yield* Effect.promise(() => sendCdp(sessionClient, { id: 4, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))

        expect(sessionClient.events.some((event) => event.method === "Target.attachedToTarget" && event.params?.sessionId === "bc-tab-1")).toBe(true)
        const alias = yield* Effect.promise(() => sendCdp(sessionClient, {
          id: 5,
          method: "Target.attachToTarget",
          params: { targetId: "target-1", flatten: true },
        }))
        const staleAliasId = typeof alias.result?.sessionId === "string" ? alias.result.sessionId : undefined
        expect(staleAliasId).toBeDefined()
        if (!staleAliasId) throw new Error("Expected target alias")

        const ownedCreate = yield* Effect.promise(() => sendCdp(sessionClient, { id: 6, method: "Target.createTarget", params: { url: "about:blank" } }))
        expect(ownedCreate.result?.targetId).toBe("target-2")

        expect(sessionClient.events).toContainEqual({
          method: "Target.detachedFromTarget",
          params: { sessionId: "bc-tab-1", targetId: "target-1" },
        })
        expect(sessionClient.events.some((event) => event.method === "Target.attachedToTarget" && event.params?.sessionId === "bc-tab-2")).toBe(true)

        extension.commands.length = 0
        yield* Effect.promise(async () => {
          await expect(sendCdp(sessionClient, {
            id: 7,
            sessionId: staleAliasId,
            method: "Runtime.evaluate",
            params: { expression: "1" },
          })).rejects.toThrow(`Unknown CDP session ${staleAliasId} for Runtime.evaluate`)
        })
        expect(extension.commands).toEqual([])

        yield* Effect.promise(async () => {
          await expect(sendCdp(rawClient, {
            id: 9,
            method: "Target.getTargetInfo",
            params: { targetId: "target-2" },
          })).rejects.toThrow("Target not found: target-2")
          await expect(sendCdp(rawClient, {
            id: 10,
            sessionId: "bc-tab-2",
            method: "Target.getTargetInfo",
            params: {},
          })).rejects.toThrow("Target not found: bc-tab-2")
          await expect(sendCdp(rawClient, {
            id: 11,
            sessionId: "bc-tab-2",
            method: "Runtime.evaluate",
            params: { expression: "1" },
          })).rejects.toThrow("Unknown CDP session bc-tab-2 for Runtime.evaluate")
        })
        const hiddenClose = yield* Effect.promise(() => sendCdp(rawClient, {
          id: 12,
          method: "Target.closeTarget",
          params: { targetId: "target-2" },
        }))
        expect(hiddenClose.result).toEqual({ success: false })
        expect(extension.commands).toEqual([])

        yield* Effect.promise(async () => {
          await expect(sendCdp(sessionClient, {
            id: 13,
            sessionId: "bc-tab-1",
            method: "Target.setAutoAttach",
            params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          })).rejects.toThrow("Target not found: bc-tab-1")
        })
        expect(extension.commands).toEqual([])

        yield* Effect.promise(() => sendCdp(sessionClient, { id: 14, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
        expect(extension.commands.filter((command) => {
          return command.method === "debugger.sendCommand" && command.params?.method === "Target.setAutoAttach"
        }).map((command) => command.params?.tabId)).toEqual([2])

        const beforeRawEventCount = sessionClient.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.sessionId === "bc-tab-1").length
        extension.send(JSON.stringify({
          method: "debugger.event",
          params: {
            tabId: 1,
            method: "Runtime.consoleAPICalled",
            params: { type: "log", args: [], executionContextId: 1, timestamp: Date.now() },
          },
        }))
        yield* Effect.sleep("50 millis")
        const afterRawEventCount = sessionClient.events.filter((event) => event.method === "Runtime.consoleAPICalled" && event.sessionId === "bc-tab-1").length
        expect(afterRawEventCount).toBe(beforeRawEventCount)
      } finally {
        rawClient.close()
        sessionClient.close()
        extension.close()
      }
    })))
  })

  it("uses the originating client's auto-attach settings for new targets", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectFakeExtension(relay.url))
      const first = yield* Effect.promise(() => connectCdpClient(relay.url))
      const second = yield* Effect.promise(() => connectCdpClient(relay.url))

      try {
        yield* Effect.promise(() => sendCdp(first, {
          id: 1,
          method: "Target.setAutoAttach",
          params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        }))
        yield* Effect.promise(() => sendCdp(second, {
          id: 2,
          method: "Target.setAutoAttach",
          params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: false },
        }))

        yield* Effect.promise(() => sendCdp(first, { id: 3, method: "Target.createTarget", params: { url: "about:blank" } }))
        yield* Effect.promise(() => sendCdp(second, { id: 4, method: "Target.createTarget", params: { url: "about:blank" } }))

        const setupCommands = extension.commands.filter((command) => {
          return command.method === "debugger.sendCommand" && command.params?.method === "Target.setAutoAttach"
        })
        expect(setupCommands.find((command) => command.params?.tabId === 1)?.params?.params).toEqual({
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
        expect(setupCommands.find((command) => command.params?.tabId === 2)?.params?.params).toEqual({
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: false,
        })

        yield* Effect.promise(async () => {
          await expect(sendCdp(first, {
            id: 5,
            method: "Runtime.evaluate",
            params: { expression: "1" },
          })).rejects.toThrow("CDP sessionId is required for Runtime.evaluate")
        })
        const targetInfo = yield* Effect.promise(() => sendCdp(first, { id: 6, method: "Target.getTargetInfo", params: {} }))
        expect(targetInfo.result).toEqual({})
      } finally {
        first.close()
        second.close()
        extension.close()
      }
    })))
  })
})

type ExtensionCommand = {
  readonly id: number
  readonly method: string
  readonly params?: { readonly tabId?: number; readonly method?: string; readonly params?: JsonObject }
}

function connectFakeExtension(relayUrl: string): Promise<WebSocket & { readonly commands: ExtensionCommand[] }> {
  return new Promise((resolve, reject) => {
    let nextTabId = 1
    const commands: ExtensionCommand[] = []
    const socket = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/extension`, { origin: "chrome-extension://browser-control-test" })
    socket.on("open", () => {
      socket.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2 } }))
      resolve(Object.assign(socket, { commands }))
    })
    socket.on("error", reject)
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString()) as ExtensionCommand
      commands.push(command)
      const params = command.params
      let result: JsonObject = {}
      if (command.method === "tabs.create") {
        result = { tabId: nextTabId++ }
      }
      if (command.method === "debugger.sendCommand" && params?.method === "Target.getTargetInfo") {
        const tabId = params.tabId ?? 0
        result = {
          targetInfo: {
            targetId: `target-${tabId}`,
            type: "page",
            title: "about:blank",
            url: "about:blank",
            attached: true,
            canAccessOpener: false,
          },
        }
      }
      socket.send(JSON.stringify({ id: command.id, result }))
    })
  })
}

function connectCdpClient(relayUrl: string, browserControlSessionId?: string): Promise<WebSocket & { readonly events: CdpEvent[]; readonly messages: CdpMessage[] }> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(`${relayUrl.replace(/^http/, "ws")}/devtools/browser/test`)
    if (browserControlSessionId) {
      endpoint.searchParams.set("browserControlSessionId", browserControlSessionId)
    }
    const socket = new WebSocket(endpoint)
    const messages: CdpMessage[] = []
    const events: CdpEvent[] = []
    socket.on("open", () => resolve(Object.assign(socket, { events, messages })))
    socket.on("error", reject)
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as CdpMessage
      messages.push(message)
      if ("method" in message) {
        events.push(message)
      }
    })
  })
}

function sendCdp(socket: WebSocket & { readonly messages: CdpMessage[] }, request: CdpRequest): Promise<Extract<CdpMessage, { readonly id: number }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for CDP response ${request.id}`)), 1_000)
    const onMessage = () => {
      const response = socket.messages.find((message): message is Extract<CdpMessage, { readonly id: number }> => {
        return "id" in message && message.id === request.id
      })
      if (!response) {
        return
      }
      clearTimeout(timeout)
      socket.off("message", onMessage)
      if (response.error) {
        reject(new Error(response.error.message))
      } else {
        resolve(response)
      }
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify(request))
  })
}
