import { EventEmitter } from "node:events"
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ terminated: false, attachCount: 0, failAt: 1 }))
vi.mock("ws", () => ({
  WebSocket: class extends EventEmitter {
    constructor() {
      super()
      queueMicrotask(() => this.emit("open"))
    }
    send(raw: string) {
      const message = JSON.parse(raw)
      state.attachCount++
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: message.id, ...(state.attachCount === state.failAt ? { error: { message: "synthetic attach rejection" } } : { result: { sessionId: "alias" } }) }))))
    }
    terminate() { state.terminated = true }
  },
}))

import { fetchStatus, scopedOwnerCdpPage } from "../gauntlet/harness.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([1, 2])("terminates its socket when owner CDP attach %i fails during acquisition", async (failAt) => {
  Object.assign(state, { terminated: false, attachCount: 0, failAt })
  vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
    expect(options.signal).toBeInstanceOf(AbortSignal)
    return new Response(JSON.stringify(url.pathname === "/json/version"
      ? { webSocketDebuggerUrl: "ws://127.0.0.1:1/cdp" }
      : [{ id: "target", url: "http://fixture/auth/", browserControlSessionId: "owner" }]))
  }))
  await expect(Effect.runPromise(Effect.scoped(scopedOwnerCdpPage({ sessionId: "owner", urlIncludes: "/auth/" })))).rejects.toThrow("synthetic attach rejection")
  expect(state.terminated).toBe(true)
  expect(state.attachCount).toBe(failAt)
})

it("bounds the status probe and rejects HTTP failures before parsing", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => {
    expect(options.signal).toBeInstanceOf(AbortSignal)
    return new Response("not JSON", { status: 503 })
  }))
  await expect(Effect.runPromise(fetchStatus())).rejects.toThrow("fetch extension status")
})
