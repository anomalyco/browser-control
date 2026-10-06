import net from "node:net"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { expect, it } from "vitest"
import { startRelay } from "../src/relay.ts"
import type { ExtensionCommand, JsonObject } from "../src/protocol.ts"

type CdpReply = { readonly id: number; readonly result?: JsonObject; readonly error?: { readonly message: string } }

it.each(["move", "down", "detached"])("preserves concurrent mouse wire order with %s cursor delivery", async (scenario) => {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const relay = yield* startRelay({ port, sessionCatalogPath: null })
    yield* Effect.tryPromise(async () => {
      const endpoint = relay.url.replace("http://", "ws://")
      const connect = async (url: string) => {
        const socket = new WebSocket(url, { origin: "chrome-extension://browser-control-test" })
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
        return socket
      }
      const extension = await connect(`${endpoint}/extension`)
      const input: unknown[] = []
      extension.on("message", (data) => {
        const command = JSON.parse(data.toString()) as ExtensionCommand
        const params = command.params?.params as Record<string, unknown> | undefined
        if (command.params?.method === "Input.dispatchMouseEvent") input.push(params?.type)
        const result = command.params?.method === "Target.getTargetInfo" ? {
          targetInfo: { targetId: "input-target", type: "page", title: "Fixture", url: "https://example.test/", attached: true, canAccessOpener: false },
        } : command.method === "tabs.create" ? { tabId: 1 } : {}
        const reply = () => extension.send(JSON.stringify({ id: command.id, result }))
        // This is an injected transport latency, not a readiness sleep: only
        // one overlay ACK is delayed, exactly as a busy renderer can do.
        const slowAction = scenario === "detached" ? "down" : scenario
        if (command.params?.method === "Runtime.evaluate" && String(params?.expression).includes(`"type":"${slowAction}"`)) {
          if (scenario === "detached") extension.send(JSON.stringify({ method: "debugger.detached", params: { tabId: 1, reason: "canceled_by_user" } }))
          setTimeout(reply, 100)
        } else reply()
      })
      extension.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2 } }))
      extension.send(JSON.stringify({ method: "ready" }))
      const client = await connect(`${endpoint}/devtools/browser/test`)
      let requestId = 0
      const send = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<CdpReply> => {
        const id = ++requestId
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`No reply for ${method}`)), 2_000)
          const onMessage = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as CdpReply
            if (message.id !== id) return
            clearTimeout(timeout)
            client.off("message", onMessage)
            resolve(message)
          }
          client.on("message", onMessage)
          client.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        })
      }
      try {
        await send("Target.createTarget", { url: "about:blank" })
        const sessionId = (await send("Target.attachToTarget", { targetId: "input-target", flatten: true })).result?.sessionId
        if (typeof sessionId !== "string") throw new Error("No target session")
        const replies = await Promise.all(["mouseMoved", "mousePressed", "mouseReleased"].map((type) => send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", clickCount: 1 }, sessionId)))
        if (scenario === "detached") {
          expect(replies[2]?.error?.message).toMatch(/target.*changed|not found|not attached|session/i)
          expect(input).toEqual(["mouseMoved"])
        } else {
          expect(replies.every((reply) => !reply.error)).toBe(true)
          expect(input).toEqual(["mouseMoved", "mousePressed", "mouseReleased"])
        }
      } finally {
        client.close()
        extension.close()
      }
    })
  })))
})
