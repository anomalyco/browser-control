import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Latch } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import type { CdpEvent, CdpRequest, CdpResponse, ExtensionCommand } from "../src/protocol.ts"
import { startRelay } from "../src/relay.ts"
import { SessionCatalog } from "../src/session-catalog.ts"
import { BrowserControlSessions } from "../src/session-manager.ts"
import { RecordingRelay } from "../src/recording-relay.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("relay extension handshake", () => {
  it.each(["complete", "cancel", "timeout"] as const)("%s restart drains every profile and restores admission only on cancellation", async (outcome) => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-profile-restart-"))
    temporaryDirectories.push(directory)
    vi.spyOn(os, "homedir").mockReturnValue(directory)
    vi.stubEnv("BROWSER_CONTROL_MANAGED_RELAY", "true")
    vi.stubEnv("BROWSER_CONTROL_RESTART_TIMEOUT_MS", outcome === "timeout" ? "1000" : "3000")
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    const profileIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
    const gates = new Map(profileIds.map((id) => [id, Latch.makeUnsafe()]))
    const entered = new Set<string>()
    const resumed = new Set<string>()
    const beginDrain = BrowserControlSessions.prototype.beginDrain
    const resume = BrowserControlSessions.prototype.resume
    vi.spyOn(BrowserControlSessions.prototype, "beginDrain").mockImplementation(function (this: BrowserControlSessions) {
      const sessions = this
      return beginDrain.call(this).pipe(Effect.andThen(Effect.suspend(() => {
        const id = sessions.listSummaries()[0]?.profileId
        if (!id || !gates.has(id)) return Effect.void
        entered.add(id)
        return gates.get(id)!.await
      })))
    })
    vi.spyOn(BrowserControlSessions.prototype, "resume").mockImplementation(function (this: BrowserControlSessions) {
      const id = this.listSummaries()[0]?.profileId
      if (id) resumed.add(id)
      return resume.call(this)
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.promise(async () => {
        const extensions: WebSocket[] = []
        const abort = new AbortController()
        try {
          for (const [index, profileId] of profileIds.entries()) {
            const extension = await connectExtension(relay.url)
            extensions.push(extension)
            extension.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2, profileId } }))
            extension.send(JSON.stringify({ method: "ready" }))
            await waitForStatus(relay.url, (status) => status.profiles?.some((profile) => profile.id === profileId && profile.connected) === true)
            const created = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: `profile-${index}`, profileId }) })
            expect(created.status).toBe(200)
          }
          const version = await fetch(`${relay.url}/version`).then((response) => response.json())
          const restart = fetch(`${relay.url}/shutdown`, {
            method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
            body: JSON.stringify({ instanceId: version.instanceId, requestId: `profile-${outcome}`, reason: "explicit-restart", client: { kind: "cli", instanceId: "test-client", buildId: "test-build" } }),
          }).catch(() => undefined)
          await waitFor(() => entered.has(profileIds[0]!))
          expect(kill).not.toHaveBeenCalled()
          for (const [index, profileId] of profileIds.entries()) {
            const blocked = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: `blocked-${index}`, profileId }) })
            expect(blocked.status).toBe(409)
            expect(await blocked.json()).toMatchObject({ code: "relay-busy" })
          }
          gates.get(profileIds[0]!)!.openUnsafe()
          await waitFor(() => entered.has(profileIds[1]!))
          await new Promise((resolve) => setTimeout(resolve, 10))
          expect(kill).not.toHaveBeenCalled()
          if (outcome === "complete") {
            gates.get(profileIds[1]!)!.openUnsafe()
            expect((await restart)?.status).toBe(200)
            await waitFor(() => kill.mock.calls.length === 1)
            expect(resumed.size).toBe(0)
          } else {
            if (outcome === "cancel") abort.abort()
            const response = await restart
            if (outcome === "timeout") {
              expect(response?.status).toBe(409)
              expect(await response?.json()).toMatchObject({ code: "relay-busy", error: expect.stringContaining("timed out") })
            }
            await waitFor(() => resumed.size === 2)
            for (const [index, profileId] of profileIds.entries()) {
              const allowed = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: `resumed-${index}`, profileId }) })
              expect(allowed.status).toBe(200)
            }
            gates.get(profileIds[1]!)!.openUnsafe()
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(kill).not.toHaveBeenCalled()
          }
        } finally {
          abort.abort()
          for (const gate of gates.values()) gate.openUnsafe()
          for (const extension of extensions) extension.close()
        }
      })
    })))
  })

  it("refuses restart for raw clients and recordings in either profile without closing the other", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-profile-restart-"))
    temporaryDirectories.push(directory)
    vi.spyOn(os, "homedir").mockReturnValue(directory)
    vi.stubEnv("BROWSER_CONTROL_MANAGED_RELAY", "true")
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    let activeRecording: RecordingRelay | undefined
    let inspectedRecording: RecordingRelay | undefined
    vi.spyOn(RecordingRelay.prototype, "statusRecording").mockImplementation(async function (this: RecordingRelay) {
      inspectedRecording = this
      return { isRecording: false }
    })
    vi.spyOn(RecordingRelay.prototype, "hasActiveRecordings").mockImplementation(function (this: RecordingRelay) { return this === activeRecording })
    const profileIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      yield* Effect.promise(async () => {
        const extensions: WebSocket[] = []
        let client: WebSocket | undefined
        try {
          for (const profileId of profileIds) {
            const extension = await connectExtension(relay.url)
            extensions.push(extension)
            extension.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2, profileId } }))
            extension.send(JSON.stringify({ method: "ready" }))
          }
          await waitForStatus(relay.url, (status) => status.profiles?.filter((profile) => profile.connected).length === 2)
          const version = await fetch(`${relay.url}/version`).then((response) => response.json())
          for (const profileId of profileIds) {
            for (const blocker of ["raw-clients", "named-clients", "recordings"] as const) {
              if (blocker !== "recordings") client = await connectCdpClient(relay.url, profileId, blocker === "named-clients" ? "external-client" : undefined)
              else {
                expect((await fetch(`${relay.url}/recording/status?profileId=${profileId}`)).status).toBe(200)
                expect(inspectedRecording).toBeDefined()
                activeRecording = inspectedRecording
              }
              const response = await fetch(`${relay.url}/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: version.instanceId, requestId: `${blocker}-${profileId}`, reason: "explicit-restart", client: { kind: "cli", instanceId: "test-client", buildId: "test-build" } }) })
              expect(response.status).toBe(409)
              expect(await response.json()).toMatchObject({ code: "relay-busy", error: expect.stringContaining(blocker === "recordings" ? "recordings" : "raw CDP") })
              expect(kill).not.toHaveBeenCalled()
              expect(extensions.every((extension) => extension.readyState === WebSocket.OPEN)).toBe(true)
              if (client) {
                const closed = waitForClose(client)
                client.close()
                await closed
                client = undefined
              }
              activeRecording = undefined
            }
          }
        } finally {
          client?.close()
          activeRecording = undefined
          for (const extension of extensions) extension.close()
        }
      })
    })))
  })

  it("routes browser-context work through a healthy owned root without using another profile", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const profileA = "11111111-1111-4111-8111-111111111111"
    const profileB = "22222222-2222-4222-8222-222222222222"
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const first = yield* Effect.promise(() => connectRespondingExtension(relay.url, { targetIdForTab: (tabId) => `root-${tabId}` }))
      const second = yield* Effect.promise(() => connectRespondingExtension(relay.url, { targetId: "root-1" }))
      let client: Awaited<ReturnType<typeof connectCdpClient>> | undefined
      try {
        for (const [socket, profileId] of [[first, profileA], [second, profileB]] as const) {
          socket.send(JSON.stringify({ method: "hello", params: { version: "test", protocolVersion: 2, profileId } }))
          if (socket === second) socket.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 1 } }))
          socket.send(JSON.stringify({ method: "ready" }))
        }
        yield* Effect.promise(() => waitForStatus(relay.url, (status) => status.profiles?.filter((profile) => profile.connected).length === 2))
        client = yield* Effect.promise(() => connectCdpClient(relay.url, profileA, "healthy-owner"))
        yield* Effect.promise(() => sendCdp(client!, { id: 1, method: "Target.createTarget", params: { url: "about:blank" } }))
        yield* Effect.promise(() => sendCdp(client!, { id: 2, method: "Target.createTarget", params: { url: "about:blank" } }))
        first.send(JSON.stringify({ method: "debugger.event", params: { tabId: 1, method: "Inspector.targetCrashed", params: {} } }))
        yield* Effect.promise(() => waitFor(() => client!.events.some((event) => event.method === "Inspector.targetCrashed")))
        yield* Effect.promise(() => sendCdp(client!, { id: 3, method: "Browser.resetPermissions", params: {} }))
        expect(first.commands).toContainEqual(expect.objectContaining({ method: "debugger.sendCommand", params: expect.objectContaining({ method: "Browser.resetPermissions", tabId: 2 }) }))
        expect(second.commands.some((command) => command.params?.method === "Browser.resetPermissions")).toBe(false)
        first.send(JSON.stringify({ method: "debugger.event", params: { tabId: 2, method: "Inspector.targetCrashed", params: {} } }))
        yield* Effect.promise(() => waitFor(() => client!.events.filter((event) => event.method === "Inspector.targetCrashed").length === 2))
        yield* Effect.promise(async () => {
          await expect(sendCdp(client!, { id: 4, method: "Browser.resetPermissions", params: {} })).rejects.toThrow()
        })
        expect(first.commands.filter((command) => command.params?.method === "Browser.resetPermissions")).toHaveLength(1)
        expect(second.commands.some((command) => command.params?.method === "Browser.resetPermissions")).toBe(false)
      } finally {
        client?.close()
        first.close()
        second.close()
      }
    })))
  })

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
      profileId: "11111111-1111-4111-8111-111111111111",
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
      extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2, profileId: "11111111-1111-4111-8111-111111111111" } }))
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

  it("keeps an active browser's targets and CDP connection when another browser connects", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const firstOptions: { targetId: string; suspendedMethod?: ExtensionCommand["method"] } = { targetId: "active-target" }
      const first = yield* Effect.promise(() => connectRespondingExtension(relay.url, firstOptions))
      let second: WebSocket | undefined
      let client: Awaited<ReturnType<typeof connectCdpClient>> | undefined
      try {
        first.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
        first.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
        first.send(JSON.stringify({ method: "ready" }))
        yield* Effect.promise(() => waitForStatus(relay.url, (status) => status.connected && status.activeTargets === 1))
        client = yield* Effect.promise(() => connectCdpClient(relay.url))
        yield* Effect.promise(() => sendCdp(client!, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
        const attached = client.events.find((event) => event.method === "Target.attachedToTarget")
        const sessionId = attached?.params?.sessionId as string
        expect(sessionId).toBeTypeOf("string")

        firstOptions.suspendedMethod = "debugger.sendCommand"
        const evaluation = () => first.commands.find((command) => command.params?.method === "Runtime.evaluate"
          && (command.params.params as { expression?: string } | undefined)?.expression === "1 + 1")
        const pending = sendCdp(client, { id: 2, method: "Runtime.evaluate", sessionId, params: { expression: "1 + 1" } }).then(() => true, () => false)
        yield* Effect.promise(() => waitFor(() => evaluation() !== undefined))

        for (let attempt = 0; attempt < 3; attempt++) {
          second = yield* Effect.promise(() => connectExtension(relay.url))
          let rejectedCode: number | undefined
          second.once("close", (code) => { rejectedCode = code })
          second.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
          second.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
          second.send(JSON.stringify({ method: "ready" }))
          yield* Effect.promise(() => waitFor(() => rejectedCode !== undefined))
          expect(rejectedCode).toBe(4004)
        }

        expect(first.readyState).toBe(WebSocket.OPEN)
        expect(client.events.some((event) => event.method === "Target.detachedFromTarget")).toBe(false)
        first.respond(evaluation()!)
        expect(yield* Effect.promise(() => pending)).toBe(true)
        const status = yield* Effect.promise(() => fetch(`${relay.url}/extension/status`).then((response) => response.json()))
        expect(status).toMatchObject({ connected: true, activeTargets: 1, rejectedConnections: 3 })
      } finally {
        client?.close()
        second?.close()
        first.close()
      }
    })))
  })

  it("isolates colliding tab and target ids across simultaneous profiles and disconnects", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const profileA = "11111111-1111-4111-8111-111111111111"
    const profileB = "22222222-2222-4222-8222-222222222222"
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const first = yield* Effect.promise(() => connectRespondingExtension(relay.url, { targetId: "shared-target" }))
      const secondOptions: { targetId: string; suspendedMethod?: ExtensionCommand["method"] } = { targetId: "shared-target" }
      const second = yield* Effect.promise(() => connectRespondingExtension(relay.url, secondOptions))
      let clientA: Awaited<ReturnType<typeof connectCdpClient>> | undefined
      let clientB: Awaited<ReturnType<typeof connectCdpClient>> | undefined
      try {
        for (const [socket, profileId, profileName] of [[first, profileA, "Personal"], [second, profileB, "Work"]] as const) {
          socket.send(JSON.stringify({ method: "hello", params: { version: "0.0.24", protocolVersion: 2, profileId, profileName } }))
          socket.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
          socket.send(JSON.stringify({ method: "ready" }))
        }
        const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.profiles?.filter((profile) => profile.connected).length === 2))
        expect(status).toMatchObject({ connected: true, activeTargets: 2 })
        expect(status.profiles).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: profileA, name: "Personal", connected: true, activeTargets: 1 }),
          expect.objectContaining({ id: profileB, name: "Work", connected: true, activeTargets: 1 }),
        ]))
        clientA = yield* Effect.promise(() => connectCdpClient(relay.url, profileA))
        clientB = yield* Effect.promise(() => connectCdpClient(relay.url, profileB))
        for (const client of [clientA, clientB]) {
          yield* Effect.promise(() => sendCdp(client, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
          expect(client.events.filter((event) => event.method === "Target.attachedToTarget")).toHaveLength(1)
        }
        const sessionA = clientA.events.find((event) => event.method === "Target.attachedToTarget")?.params?.sessionId as string
        const sessionB = clientB.events.find((event) => event.method === "Target.attachedToTarget")?.params?.sessionId as string
        yield* Effect.promise(() => sendCdp(clientA!, { id: 2, method: "Runtime.evaluate", sessionId: sessionA, params: { expression: "personalOnly" } }))
        expect(first.commands.some((command) => (command.params?.params as { expression?: string } | undefined)?.expression === "personalOnly")).toBe(true)
        expect(second.commands.some((command) => (command.params?.params as { expression?: string } | undefined)?.expression === "personalOnly")).toBe(false)

        for (const socket of [first, second]) {
          socket.send(JSON.stringify({ method: "debugger.event", params: {
            tabId: 7,
            method: "Target.attachedToTarget",
            params: { sessionId: "shared-child-session", targetInfo: { targetId: "shared-worker", type: "worker", title: "Worker", url: "https://example.com/worker.js", attached: true, canAccessOpener: false }, waitingForDebugger: false },
          } }))
        }
        yield* Effect.promise(() => waitFor(() => [clientA!, clientB!].every((client) => client.events.filter((event) => event.method === "Target.attachedToTarget").length === 2)))
        const childB = clientB.events.find((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "shared-worker")?.params?.sessionId as string
        yield* Effect.promise(() => sendCdp(clientB!, { id: 3, method: "Runtime.evaluate", sessionId: childB, params: { expression: "workChildOnly" } }))
        expect(second.commands).toContainEqual(expect.objectContaining({ method: "debugger.sendCommand", params: expect.objectContaining({ tabId: 7, sessionId: "shared-child-session", params: { expression: "workChildOnly" } }) }))
        expect(first.commands.some((command) => (command.params?.params as { expression?: string } | undefined)?.expression === "workChildOnly")).toBe(false)

        secondOptions.suspendedMethod = "debugger.sendCommand"
        const evaluation = () => second.commands.find((command) => (command.params?.params as { expression?: string } | undefined)?.expression === "workOnly")
        const pending = sendCdp(clientB, { id: 2, method: "Runtime.evaluate", sessionId: sessionB, params: { expression: "workOnly" } }).then(() => true, () => false)
        yield* Effect.promise(() => waitFor(() => evaluation() !== undefined))
        const closed = waitForClose(first)
        first.close()
        yield* Effect.promise(() => closed)
        yield* Effect.promise(() => waitFor(() => clientA!.events.some((event) => event.method === "Target.detachedFromTarget")))
        const remaining = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.activeTargets === 1))
        expect(remaining.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profileB, connected: true, activeTargets: 1 })]))
        expect(clientB.events.some((event) => event.method === "Target.detachedFromTarget")).toBe(false)
        expect(second.readyState).toBe(WebSocket.OPEN)
        second.respond(evaluation()!)
        expect(yield* Effect.promise(() => pending)).toBe(true)
        expect(first.commands.some((command) => (command.params?.params as { expression?: string } | undefined)?.expression === "workOnly")).toBe(false)
      } finally {
        clientA?.close()
        clientB?.close()
        first.close()
        second.close()
      }
    })))
  })

  it("requires an explicit profile for new work and keeps named sessions pinned", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const profileA = "11111111-1111-4111-8111-111111111111"
    const profileB = "22222222-2222-4222-8222-222222222222"
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const first = yield* Effect.promise(() => connectExtension(relay.url))
      const second = yield* Effect.promise(() => connectExtension(relay.url))
      try {
        for (const [socket, profileId, profileName] of [[first, profileA, "Personal"], [second, profileB, "Work"]] as const) {
          socket.send(JSON.stringify({ method: "hello", params: { version: "0.0.24", protocolVersion: 2, profileId, profileName } }))
          socket.send(JSON.stringify({ method: "ready" }))
        }
        yield* Effect.promise(() => waitForStatus(relay.url, (status) => status.profiles?.filter((profile) => profile.connected).length === 2))
        yield* Effect.promise(async () => {
          for (const [pathname, body] of [
            ["/cli/session/new", { id: "ambiguous" }],
            ["/v1/sessions/ensure", { id: "ambiguous" }],
            ["/cli/execute", { code: "1", createIfMissing: true }],
            ["/cli/session/adopt", { createIfMissing: true, targetSelection: { urlIncludes: "example.com" } }],
            ["/recording/start", { outputPath: "/tmp/profile-ambiguity.webm" }],
          ] as const) {
            const response = await fetch(`${relay.url}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
            expect(response.status, pathname).toBe(409)
            expect(await response.json(), pathname).toMatchObject({ code: "profile-ambiguous", error: expect.stringMatching(/profile/i) })
          }
          expect(await fetch(`${relay.url}/cli/sessions`).then((response) => response.json())).toMatchObject({ sessions: [] })
          const created = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "personal", profileId: profileA }) })
          expect(created.status).toBe(200)
          expect(await created.json()).toMatchObject({ session: { id: "personal", profileId: profileA, profileName: "Personal" } })
          const ensured = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "personal" }) })
          expect(ensured.status).toBe(200)
          expect(await ensured.json()).toMatchObject({ session: { id: "personal", profileId: profileA } })
          for (const pathname of ["/cli/session/new", "/v1/sessions/ensure"]) {
            const conflict = await fetch(`${relay.url}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "personal", profileId: profileB }) })
            expect(conflict.status, pathname).toBe(409)
            expect(await conflict.json()).toMatchObject({ code: "profile-mismatch" })
          }
          const mismatch = await fetch(`${relay.url}/cli/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "personal", profileId: profileB, code: "1", createIfMissing: false }) })
          expect(mismatch.status).toBe(409)
          expect(await mismatch.json()).toMatchObject({ code: "profile-mismatch", error: expect.stringMatching(/profile/i) })
        })
        const closed = waitForClose(first)
        first.close()
        yield* Effect.promise(() => closed)
        yield* Effect.promise(() => waitForStatus(relay.url, (status) => status.profiles?.filter((profile) => profile.connected).length === 1))
        yield* Effect.promise(async () => {
          const pinned = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "personal" }) })
          expect(pinned.status).toBe(200)
          expect(await pinned.json()).toMatchObject({ session: { id: "personal", profileId: profileA, profileName: "Personal" } })
          const automatic = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "work" }) })
          expect(automatic.status).toBe(200)
          expect(await automatic.json()).toMatchObject({ session: { id: "work", profileId: profileB, profileName: "Work" } })
        })
      } finally {
        first.close()
        second.close()
      }
    })))
  })

  it("protects a compatible browser's handshake before its inventory is ready", async () => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const first = yield* Effect.promise(() => connectExtension(relay.url))
      let second: WebSocket | undefined
      try {
        first.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
        yield* Effect.promise(() => waitForStatus(relay.url, (status) => status.protocolCompatible === true))
        second = yield* Effect.promise(() => connectExtension(relay.url))
        let rejectedCode: number | undefined
        second.once("close", (code) => { rejectedCode = code })
        second.send(JSON.stringify({ method: "hello", params: { version: "0.0.24", protocolVersion: 2 } }))
        yield* Effect.promise(() => waitFor(() => rejectedCode !== undefined))
        expect(rejectedCode).toBe(4004)

        first.send(JSON.stringify({ method: "ready" }))
        const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.connected))
        expect(status).toMatchObject({ version: "0.0.23", rejectedConnections: 1 })
      } finally {
        second?.close()
        first.close()
      }
    })))
  })

  it("accepts a new browser after the previous connection closes", async () => {
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

      const closed = waitForClose(first)
      first.close()
      yield* Effect.promise(() => closed)
      yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => !candidate.connected))
      const second = yield* Effect.promise(() => connectExtension(relay.url))
      second.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2 } }))
      second.send(JSON.stringify({ method: "ready" }))
      const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.connected === true))

      expect(status.activeTargets).toBe(0)
      expect(status).toMatchObject({ rejectedConnections: 0 })
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

  it.each(["rpc", "malformed"] as const)("rejects ready and clears live roots after a committed root %s probe failure", async (failure) => {
    const port = 24_000 + Math.floor(Math.random() * 10_000)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath: null })
      const options: { targetId?: string; error?: string } = { targetId: "committed-target" }
      const extension = yield* Effect.promise(() => connectRespondingExtension(relay.url, options))
      const closed = waitForClose(extension)
      try {
        extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.24", protocolVersion: 2 } }))
        extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
        const committed = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.activeTargets === 1))
        expect(committed.connected).toBe(false)

        if (failure === "rpc") options.error = "Debugger is not attached to the tab with id: 7"
        else delete options.targetId
        extension.send(JSON.stringify({ method: "debugger.detached", params: { tabId: 7, reason: "target_closed" } }))
        extension.send(JSON.stringify({ method: "ready" }))

        const status = yield* Effect.promise(() => waitForStatus(relay.url, (candidate) => candidate.connected || candidate.activeTargets === 0))
        expect(status).toMatchObject({ connected: false, activeTargets: 0 })
        expect(yield* Effect.promise(() => closed)).toBe(1011)
        expect(error).toHaveBeenCalled()
        if (failure === "rpc") {
          expect(error.mock.calls.some((call) => call[1] instanceof Error && call[1].message === options.error)).toBe(true)
        }
        expect(extension.commands.some((command) => command.method === "tabs.remove" || command.method === "debugger.detach")).toBe(false)
      } finally {
        extension.close()
      }
    })))
  })
})

type ExtensionStatus = {
  readonly connected: boolean
  readonly activeTargets: number
  readonly protocolCompatible?: boolean
  readonly profiles?: readonly { readonly id: string; readonly name?: string; readonly connected: boolean; readonly activeTargets?: number }[]
}
type CdpMessage = CdpEvent | CdpResponse

async function connectRespondingExtension(
  relayUrl: string,
  options: {
    readonly targetId?: string
    readonly targetIdForTab?: (tabId: number) => string
    readonly error?: string
    readonly suspendedMethod?: ExtensionCommand["method"]
  } = {},
): Promise<WebSocket & {
  readonly commands: ExtensionCommand[]
  readonly respond: (command: ExtensionCommand) => void
}> {
  const socket = await connectExtension(relayUrl)
  const commands: ExtensionCommand[] = []
  let createdTabId = 0
  const respond = (command: ExtensionCommand) => {
    if (options.error) {
      socket.send(JSON.stringify({ id: command.id, error: options.error }))
      return
    }
    const targetId = options.targetIdForTab?.(Number(command.params?.tabId)) ?? options.targetId
    const result = command.method === "tabs.create" ? { tabId: ++createdTabId }
      : command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo" && targetId
      ? { targetInfo: { targetId, type: "page", title: "Test", url: "https://example.com/", attached: true, canAccessOpener: false } }
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

function connectCdpClient(relayUrl: string, profileId?: string, browserControlSessionId?: string): Promise<WebSocket & { readonly events: CdpEvent[]; readonly messages: CdpMessage[] }> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ ...(profileId ? { profileId } : {}), ...(browserControlSessionId ? { browserControlSessionId } : {}) })
    const socket = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/devtools/browser/test?${query}`)
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
