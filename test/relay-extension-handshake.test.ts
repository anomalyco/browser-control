import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import type { CdpEvent, CdpRequest, CdpResponse, ExtensionCommand } from "../src/protocol.ts"
import { startRelay } from "../src/relay.ts"
import { SessionCatalog } from "../src/session-catalog.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("relay extension handshake", () => {
  it("rejects pre-hello events and keeps them from mutating target state", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectExtension(relay.url))
      const closed = waitForClose(extension)
      extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))

      expect(yield* Effect.promise(() => closed)).toBe(4002)
      const status = yield* Effect.promise(() => fetch(`${relay.url}/extension/status`).then((response) => response.json()))
      expect(status).toMatchObject({ connected: false, activeTargets: 0 })
    })))
  })

  it("reports incompatible protocol without accepting its events", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectExtension(relay.url))
      extension.send(JSON.stringify({ method: "hello", params: { version: "2.0.0", protocolVersion: 3 } }))
      extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
      yield* Effect.sleep("20 millis")

      const status = yield* Effect.promise(() => fetch(`${relay.url}/extension/status`).then((response) => response.json()))
      expect(status).toMatchObject({
        connected: false,
        version: "2.0.0",
        protocolVersion: 3,
        protocolCompatible: false,
        protocolLegacy: false,
        activeTargets: 0,
      })
      extension.close()
    })))
  })

  it("becomes connected after a compatible extension finishes re-announcement", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectExtension(relay.url))
      extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))

      const beforeReady = yield* Effect.promise(() => fetch(`${relay.url}/extension/status`).then((response) => response.json()))
      expect(beforeReady).toMatchObject({ connected: false, protocolVersion: 2, protocolCompatible: true })

      extension.send(JSON.stringify({ method: "ready" }))
      yield* Effect.sleep("10 millis")
      const ready = yield* Effect.promise(() => fetch(`${relay.url}/extension/status`).then((response) => response.json()))
      expect(ready).toMatchObject({ connected: true, protocolVersion: 2, protocolCompatible: true, protocolLegacy: false })
      extension.close()
    })))
  })

  it("does not wait for restored-tab grouping before becoming ready", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-extension-handshake-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    await new SessionCatalog(sessionCatalogPath).save([{
      id: "restored",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:01:00.000Z",
      readOnly: false,
      target: { id: "restored-target", owner: "user" },
    }])

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      const extension = yield* Effect.promise(() => connectRespondingExtension(relay.url, {
        targetId: "restored-target",
        suspendedMethod: "tabs.group",
      }))
      extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
      extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
      extension.send(JSON.stringify({ method: "ready" }))

      const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.connected === true))
      expect(status).toMatchObject({ connected: true, activeTargets: 1 })
      yield* Effect.promise(() => waitFor(() => extension.commands.some((command) => command.method === "tabs.group")))
      const group = extension.commands.find((command) => command.method === "tabs.group")
      expect(group).toBeDefined()

      extension.send(JSON.stringify({ method: "debugger.detached", params: { tabId: 7, reason: "canceled_by_user" } }))
      yield* Effect.sleep("20 millis")
      expect(extension.commands.some((command) => command.method === "tabs.ungroup")).toBe(false)

      extension.respond(group!)
      yield* Effect.promise(() => waitFor(() => extension.commands.some((command) => command.method === "tabs.ungroup")))
      expect(extension.commands.filter((command) => command.method === "tabs.group" || command.method === "tabs.ungroup").map((command) => command.method)).toEqual([
        "tabs.group",
        "tabs.ungroup",
      ])
      extension.close()
    })))
  })

  it("reports extension log events", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectExtension(relay.url))
      extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
      extension.send(JSON.stringify({ method: "log", params: { level: "error", message: "tab groups unavailable" } }))

      yield* Effect.promise(() => waitFor(() => error.mock.calls.some((call) => {
        return call[0] === "[browser-control extension] tab groups unavailable"
      })))
      extension.close()
    })))
  })

  it("does not let an incompatible extension replace a compatible socket before ready", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const compatible = yield* Effect.promise(() => connectExtension(relay.url))
      compatible.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))

      const incompatible = yield* Effect.promise(() => connectExtension(relay.url))
      const closed = waitForClose(incompatible)
      incompatible.send(JSON.stringify({ method: "hello", params: { version: "0.0.22", protocolVersion: 1 } }))
      expect(yield* Effect.promise(() => closed)).toBe(4003)

      compatible.send(JSON.stringify({ method: "ready" }))
      const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.connected === true))
      expect(status).toMatchObject({ connected: true, protocolVersion: 2, activeTargets: 0 })
      compatible.close()
    })))
  })

  it("replaces the previous socket inventory before accepting a new ready event", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const first = yield* Effect.promise(() => connectRespondingExtension(relay.url, { targetId: "stale-target" }))
      first.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
      first.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
      first.send(JSON.stringify({ method: "ready" }))
      yield* Effect.promise(() => waitForStatus(relay.url, (status) => status.connected === true && status.activeTargets === 1))
      const client = yield* Effect.promise(() => connectCdpClient(relay.url))
      yield* Effect.promise(() => sendCdp(client, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
      expect(client.events.some((event) => event.method === "Target.attachedToTarget")).toBe(true)

      const second = yield* Effect.promise(() => connectExtension(relay.url))
      second.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
      second.send(JSON.stringify({ method: "ready" }))
      const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.connected === true))

      expect(status.activeTargets).toBe(0)
      yield* Effect.promise(() => waitFor(() => client.events.some((event) => event.method === "Target.detachedFromTarget")))
      client.close()
      second.close()
    })))
  })

  it("rejects ready when an announced target cannot be reconciled", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const extension = yield* Effect.promise(() => connectRespondingExtension(relay.url, { error: "synthetic reconciliation failure" }))
      const closed = waitForClose(extension)
      extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
      extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
      extension.send(JSON.stringify({ method: "ready" }))

      expect(yield* Effect.promise(() => closed)).toBe(1011)
      const status = yield* Effect.promise(() => fetch(`${relay.url}/extension/status`).then((response) => response.json()))
      expect(status).toMatchObject({ connected: false, activeTargets: 0 })
    })))
  })
})

type ExtensionStatus = { readonly connected: boolean; readonly activeTargets: number }
type CdpMessage = CdpEvent | CdpResponse

async function connectRespondingExtension(
  relayUrl: string,
  options: {
    readonly targetId?: string
    readonly error?: string
    readonly suspendedMethod?: ExtensionCommand["method"]
  } = {},
): Promise<WebSocket & {
  readonly commands: ExtensionCommand[]
  readonly respond: (command: ExtensionCommand) => void
}> {
  const socket = await connectExtension(relayUrl)
  const commands: ExtensionCommand[] = []
  const respond = (command: ExtensionCommand) => {
    if (options.error) {
      socket.send(JSON.stringify({ id: command.id, error: options.error }))
      return
    }
    const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo" && options.targetId
      ? { targetInfo: { targetId: options.targetId, type: "page", title: "Test", url: "https://example.com/", attached: true, canAccessOpener: false } }
      : {}
    socket.send(JSON.stringify({ id: command.id, result }))
  }
  socket.on("message", (data) => {
    const command = JSON.parse(data.toString()) as ExtensionCommand
    commands.push(command)
    if (command.method !== options.suspendedMethod) respond(command)
  })
  return Object.assign(socket, { commands, respond })
}

function connectExtension(relayUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/extension`, {
      origin: "chrome-extension://browser-control-test",
    })
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code))
  })
}

async function waitForStatus(relayUrl: string, predicate: (status: ExtensionStatus) => boolean): Promise<ExtensionStatus> {
  const deadline = Date.now() + 2_000
  while (true) {
    const status = await fetch(`${relayUrl}/extension/status`).then((response) => response.json()) as ExtensionStatus
    if (predicate(status)) return status
    if (Date.now() >= deadline) throw new Error("Timed out waiting for extension status")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function connectCdpClient(relayUrl: string): Promise<WebSocket & { readonly events: CdpEvent[]; readonly messages: CdpMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/devtools/browser/test`)
    const messages: CdpMessage[] = []
    const events: CdpEvent[] = []
    socket.on("open", () => resolve(Object.assign(socket, { events, messages })))
    socket.on("error", reject)
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as CdpMessage
      messages.push(message)
      if ("method" in message) events.push(message)
    })
  })
}

function sendCdp(socket: WebSocket & { readonly messages: CdpMessage[] }, request: CdpRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for CDP response ${request.id}`)), 1_000)
    const onMessage = () => {
      const response = socket.messages.find((message): message is CdpResponse => "id" in message && message.id === request.id)
      if (!response) return
      clearTimeout(timeout)
      socket.off("message", onMessage)
      if (response.error) reject(new Error(response.error.message))
      else resolve()
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify(request))
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for relay event")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
