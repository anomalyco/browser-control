import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { ExtensionRpc } from "../src/extension-rpc.ts"

type SentMessage = { readonly id: number; readonly method: string }

type FakeSocket = WebSocket & {
  readonly sent: SentMessage[]
  readonly closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }>
  readonly pings: () => number
  emitPong: () => void
}

const makeFakeSocket = (): FakeSocket => {
  const sent: SentMessage[] = []
  const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
  const pongListeners = new Set<() => void>()
  let pings = 0
  const socket = {
    readyState: WebSocket.OPEN,
    sent,
    closes,
    pings: () => pings,
    send(data: string, callback?: (error?: Error) => void) {
      sent.push(JSON.parse(data) as SentMessage)
      callback?.()
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason })
    },
    ping() {
      pings += 1
    },
    on(event: string, listener: () => void) {
      if (event === "pong") {
        pongListeners.add(listener)
      }
      return socket
    },
    off(event: string, listener: () => void) {
      if (event === "pong") {
        pongListeners.delete(listener)
      }
      return socket
    },
    emitPong() {
      for (const listener of Array.from(pongListeners)) {
        listener()
      }
    },
  }
  return socket as unknown as FakeSocket
}

const connect = (rpc: ExtensionRpc): FakeSocket => {
  const socket = makeFakeSocket()
  rpc.replaceSocket(socket)
  rpc.markReady("0.0.5")
  return socket
}

describe("ExtensionRpc", () => {
  it("resolves responses", async () => {
    const rpc = new ExtensionRpc()
    const socket = connect(rpc)
    const pending = Effect.runPromise(rpc.send({ method: "tabs.create", params: {} }))
    const request = socket.sent[0]
    expect(request?.method).toBe("tabs.create")
    rpc.handleResponse({ id: request?.id ?? 0, result: { tabId: 7 } })
    await expect(pending).resolves.toEqual({ tabId: 7 })
  })

  it("fails without a connected socket", async () => {
    const rpc = new ExtensionRpc()
    await expect(Effect.runPromise(rpc.send({ method: "tabs.create", params: {} }))).rejects.toThrow(
      "extension is not connected",
    )
  })

  it("a command timeout fails only that command and leaves the socket open", async () => {
    const rpc = new ExtensionRpc({ commandTimeoutMs: 20, livenessProbeTimeoutMs: 1_000 })
    const socket = connect(rpc)
    await expect(Effect.runPromise(rpc.send({ method: "tabs.create", params: {} }))).rejects.toThrow("timed out")
    expect(socket.closes).toHaveLength(0)
    expect(socket.pings()).toBe(1)
    // A healthy socket answers the liveness probe and stays open.
    socket.emitPong()
    const pending = Effect.runPromise(rpc.send({ method: "tabs.remove", params: {} }))
    const request = socket.sent[1]
    rpc.handleResponse({ id: request?.id ?? 0, result: {} })
    await expect(pending).resolves.toEqual({})
    expect(socket.closes).toHaveLength(0)
  })

  it("closes the socket when the liveness probe gets no pong", async () => {
    const rpc = new ExtensionRpc({ commandTimeoutMs: 10, livenessProbeTimeoutMs: 20 })
    const socket = connect(rpc)
    await expect(Effect.runPromise(rpc.send({ method: "tabs.create", params: {} }))).rejects.toThrow("timed out")
    expect(socket.closes).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(socket.closes).toHaveLength(1)
    expect(socket.closes[0]?.code).toBe(4002)
  })

  it("rejects only debugger commands for a crashed tab", async () => {
    const rpc = new ExtensionRpc()
    const socket = connect(rpc)
    const crashed = Effect.runPromise(rpc.send({ method: "debugger.sendCommand", params: { tabId: 7, method: "Page.crash" } }))
    const healthy = Effect.runPromise(rpc.send({ method: "debugger.sendCommand", params: { tabId: 8, method: "Runtime.evaluate" } }))

    rpc.rejectDebuggerCommandsForTab(7, new Error("Target crashed"))
    await expect(crashed).rejects.toThrow("Target crashed")
    const healthyRequest = socket.sent[1]
    rpc.handleResponse({ id: healthyRequest?.id ?? 0, result: {} })
    await expect(healthy).resolves.toEqual({})
  })

  it("rejects pending commands when the socket is replaced", async () => {
    const rpc = new ExtensionRpc()
    const first = connect(rpc)
    const pending = Effect.runPromise(rpc.send({ method: "tabs.create", params: {} }))
    connect(rpc)
    await expect(pending).rejects.toThrow("Extension replaced")
    expect(first.closes[0]?.code).toBe(4001)
  })

  it("rejects pending commands on disconnect", async () => {
    const rpc = new ExtensionRpc()
    const socket = connect(rpc)
    const pending = Effect.runPromise(rpc.send({ method: "tabs.create", params: {} }))
    expect(rpc.disconnectIfCurrent(socket)).toBe(true)
    await expect(pending).rejects.toThrow("Extension disconnected")
    expect(rpc.connected).toBe(false)
  })
})
