import net from "node:net"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { parseExtensionCommand, parseJsonObject, type CdpRequest, type ExtensionCommand, type JsonObject } from "../src/protocol.ts"
import { getObject } from "../src/relay-helpers.ts"
import { startRelay } from "../src/relay.ts"

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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

function nextMessage(socket: WebSocket, matches: (message: JsonObject) => boolean): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage)
      reject(new Error("Timed out waiting for runtime relay response"))
    }, 2_000)
    const onMessage = (data: WebSocket.RawData) => {
      const message = parseJsonObject(data.toString())
      if (!matches(message)) return
      clearTimeout(timeout)
      socket.off("message", onMessage)
      resolve(message)
    }
    socket.on("message", onMessage)
  })
}

describe("relay runtime forwarding", () => {
  it.each(["root", "root-alias", "child", "child-alias"])("forwards enable and ordinary commands through %s with the correct Chrome address", async (kind) => {
    const port = await freePort()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.tryPromise(async () => {
        const endpoint = relay.url.replace("http://", "ws://")
        const extension = await openSocket(`${endpoint}/extension`)
        const commands: ExtensionCommand[] = []
        const rootInfo = { targetId: "root-target", type: "page", title: "Runtime fixture", url: "https://example.test/", attached: true, canAccessOpener: false }
        extension.on("message", (data) => {
          const command = parseExtensionCommand(data.toString())
          commands.push(command)
          const isEnable = command.method === "debugger.sendCommand" && command.params?.method === "Runtime.enable"
          if (isEnable) {
            // Emit before the reply: the actual relay must already be observing.
            extension.send(JSON.stringify({
              method: "debugger.event",
              params: {
                tabId: 1, method: "Runtime.executionContextCreated",
                params: { context: { id: 1, auxData: { isDefault: true } } },
                ...(command.params?.sessionId === undefined ? {} : { sessionId: command.params.sessionId }),
              },
            }))
          }
          const result = command.method === "tabs.create" ? { tabId: 1 }
            : command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo" ? { targetInfo: rootInfo }
            : isEnable ? { enabled: true } : {}
          extension.send(JSON.stringify({ id: command.id, result }))
        })
        extension.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2 } }))
        extension.send(JSON.stringify({ method: "ready" }))
        const client = await openSocket(`${endpoint}/devtools/browser/test?browserControlSessionId=runtime-owner`)
        let requestId = 0
        const send = (request: Omit<CdpRequest, "id">) => {
          const id = ++requestId
          const reply = nextMessage(client, (message) => message.id === id)
          client.send(JSON.stringify({ ...request, id }))
          return reply
        }
        try {
          const rootAttached = nextMessage(client, (message) => message.method === "Target.attachedToTarget")
          expect(getObject((await send({ method: "Target.createTarget", params: { url: "about:blank" } })).result)).toEqual({ targetId: rootInfo.targetId })
          const rootSessionId = getObject((await rootAttached).params)?.sessionId
          if (typeof rootSessionId !== "string") throw new Error("Expected root session")
          const childAttached = nextMessage(client, (message) => message.method === "Target.attachedToTarget" && getObject(message.params)?.sessionId === "child-session")
          extension.send(JSON.stringify({
            method: "debugger.event",
            params: {
              tabId: 1, method: "Target.attachedToTarget",
              params: { sessionId: "child-session", targetInfo: { ...rootInfo, targetId: "child-target", type: "iframe" }, waitingForDebugger: false },
            },
          }))
          await childAttached
          const child = kind.startsWith("child")
          let sessionId = child ? "child-session" : rootSessionId
          if (kind.endsWith("alias")) {
            const attached = await send({ method: "Target.attachToTarget", params: { targetId: child ? "child-target" : rootInfo.targetId, flatten: true } })
            const alias = getObject(attached.result)?.sessionId
            if (typeof alias !== "string") throw new Error("Expected target alias")
            expect(alias).not.toBe(sessionId)
            sessionId = alias
          }
          commands.length = 0
          expect(await send({ method: "Runtime.enable", sessionId })).toMatchObject({ sessionId, result: { enabled: true } })
          expect(await send({ method: "Page.getFrameTree", sessionId, params: {} })).toMatchObject({ sessionId, result: {} })
          expect(commands).toEqual([
            { id: expect.any(Number), method: "debugger.sendCommand", params: { tabId: 1, method: "Runtime.enable", params: {}, ...(child ? { sessionId: "child-session" } : {}) } },
            { id: expect.any(Number), method: "debugger.sendCommand", params: { tabId: 1, method: "Page.getFrameTree", params: {}, ...(child ? { sessionId: "child-session" } : {}) } },
          ])
        } finally {
          client.close()
          extension.close()
        }
      })
    })))
  })
})
