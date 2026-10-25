import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Effect, Exit, Fiber, Scope } from "effect"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startRelay } from "../src/relay.ts"
import { SessionCatalog } from "../src/session-catalog.ts"

const temporaryDirectories: string[] = []
const extensionOrigin = "chrome-extension://browser-control-test"

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("relay drain", () => {
  it("restarts while an idle named session is connected and reattaches it afterwards", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const { port, sessionCatalogPath } = await relayFixture()

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath, additionalExtensionOrigins: [extensionOrigin] }).pipe(withRelayConfig({ BROWSER_CONTROL_MANAGED_RELAY: "1" }))
      yield* Effect.promise(async () => {
        const extension = await openFakeExtension(relay.url)
        await connectIdleSession(relay.url, "instant-hover")

        const version = await fetch(new URL("/version", relay.url)).then((response) => response.json()) as { instanceId: string; buildId: string; drain?: unknown }
        expect(version.drain).toBeUndefined()
        const shutdown = await postJson(relay.url, "/shutdown", {
          instanceId: version.instanceId,
          requestId: "restart-idle-session",
          reason: "explicit-restart",
          client: { kind: "cli", instanceId: "drain-test-client", buildId: version.buildId },
        })
        expect(shutdown.status).toBe(200)
        expect(await shutdown.json()).toEqual({ stopping: true })
        await waitFor(() => kill.mock.calls.some(([pid, signal]) => pid === process.pid && signal === "SIGTERM"))
        const draining = await fetch(new URL("/version", relay.url)).then((response) => response.json()) as { drain?: { phase: string } }
        expect(draining.drain?.phase).toBe("stopping")
        extension.close()
      })
    })).pipe(Effect.timeout("5 seconds")))

    expect(await restoredSessionIds(port, sessionCatalogPath)).toEqual(["instant-hover"])
  })

  it("forces shutdown past its deadline when accepted work never settles, and keeps sessions for reattach", async () => {
    const { port, sessionCatalogPath } = await relayFixture()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})

    const scope = await Effect.runPromise(Scope.make())
    const relay = await Effect.runPromise(startRelay({ port, sessionCatalogPath, additionalExtensionOrigins: [extensionOrigin] }).pipe(
      withRelayConfig({ BROWSER_CONTROL_SHUTDOWN_TIMEOUT_MS: "300" }),
      Scope.provide(scope),
    ))
    const extension = await openFakeExtension(relay.url)
    await connectIdleSession(relay.url, "instant-hover")
    void postJson(relay.url, "/cli/execute", { sessionId: "stuck", code: "await new Promise(() => {})", createIfMissing: true }).catch(() => {})
    await waitFor(async () => {
      const sessions = await fetch(new URL("/cli/sessions", relay.url)).then((response) => response.json()) as { sessions: { id: string; connected: boolean }[] }
      return sessions.sessions.some((session) => session.id === "stuck" && session.connected)
    })

    const startedAt = Date.now()
    const closing = Effect.runFork(Scope.close(scope, Exit.void))
    let drain: { phase: string; holders: string[] } | undefined
    await waitFor(async () => {
      const version = await fetch(new URL("/version", relay.url)).then((response) => response.json()) as { drain?: { phase: string; holders: string[] } }
      drain = version.drain
      return drain !== undefined
    })
    expect(drain?.phase).toBe("closing")
    expect(drain?.holders).toContain("session stuck executing")
    expect(drain?.holders.some((holder) => holder.includes("instant-hover"))).toBe(false)

    await Effect.runPromise(Fiber.join(closing).pipe(Effect.timeout("3 seconds")))
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(errors.mock.calls.some(([message]) => String(message).includes("shutdown deadline (300ms) passed"))).toBe(true)
    extension.close()
    expect(await restoredSessionIds(port, sessionCatalogPath)).toEqual(["instant-hover", "stuck"])
  })
})

/** The default provider snapshots the environment once per process, so tests pass relay config explicitly. */
function withRelayConfig(env: Record<string, string>) {
  return Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
}

async function relayFixture(): Promise<{ readonly port: number; readonly sessionCatalogPath: string }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-drain-"))
  temporaryDirectories.push(directory)
  return { port: await freePort(), sessionCatalogPath: path.join(directory, "sessions.json") }
}

async function restoredSessionIds(port: number, sessionCatalogPath: string): Promise<readonly string[]> {
  const catalogIds = (await new SessionCatalog(sessionCatalogPath).load()).map((entry) => entry.id).sort()
  const relayIds = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const relay = yield* startRelay({ port, sessionCatalogPath }).pipe(withRelayConfig({}))
    return yield* Effect.promise(async () => {
      const response = await fetch(new URL("/cli/sessions", relay.url)).then((result) => result.json()) as { sessions: { id: string }[] }
      return response.sessions.map((session) => session.id).sort()
    })
  })))
  expect(relayIds).toEqual(catalogIds)
  return relayIds
}

/** Leaves `id` idle with a live sandbox connection to a relay-owned page, like a finished proof page. */
async function connectIdleSession(relayUrl: string, id: string): Promise<void> {
  expect((await postJson(relayUrl, "/cli/session/new", { id })).status).toBe(200)
  const execute = await postJson(relayUrl, "/cli/execute", { sessionId: id, code: "return 1", createIfMissing: false })
  expect(await execute.json()).toMatchObject({ value: 1, isError: false })
  const sessions = await fetch(new URL("/cli/sessions", relayUrl)).then((response) => response.json()) as { sessions: { id: string; connected: boolean }[] }
  expect(sessions.sessions.find((session) => session.id === id)?.connected).toBe(true)
}

type ExtensionCommand = {
  readonly id: number
  readonly method: string
  readonly params?: { readonly method?: string; readonly tabId?: number; readonly sessionId?: string }
}

/** Answers just enough of the extension protocol for Playwright to open and use a relay-owned page. */
async function openFakeExtension(relayUrl: string): Promise<WebSocket> {
  const extension = await openSocket(`${relayUrl.replace("http://", "ws://")}/extension`)
  let nextTabId = 100
  const url = "http://palette-selection.localhost:1355/"
  extension.on("message", (data) => {
    const command = JSON.parse(data.toString()) as ExtensionCommand
    const tabId = command.params?.tabId
    const cdp = command.method === "debugger.sendCommand" ? command.params?.method : undefined
    let result: unknown = {}
    if (command.method === "tabs.create") {
      const created = ++nextTabId
      result = { tabId: created }
      setTimeout(() => extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: created } })), 5)
    } else if (cdp === "Target.getTargetInfo") {
      result = { targetInfo: { targetId: `target-${tabId}`, type: "page", title: "Idle proof", url, attached: true, canAccessOpener: false, browserContextId: "default" } }
    } else if (cdp === "Page.getFrameTree") {
      result = { frameTree: { frame: { id: `target-${tabId}`, loaderId: "loader", url, securityOrigin: "http://palette-selection.localhost:1355", mimeType: "text/html", domainAndRegistry: "", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } }
    } else if (cdp === "Runtime.evaluate") {
      result = { result: { type: "boolean", value: true } }
    }
    extension.send(JSON.stringify({ id: command.id, result }))
    if (cdp === "Runtime.enable") {
      extension.send(JSON.stringify({
        method: "debugger.event",
        params: {
          tabId,
          method: "Runtime.executionContextCreated",
          params: { context: { id: 1, origin: "http://palette-selection.localhost:1355", name: "", uniqueId: `context-${tabId}`, auxData: { isDefault: true, type: "default", frameId: `target-${tabId}` } } },
          ...(command.params?.sessionId ? { sessionId: command.params.sessionId } : {}),
        },
      }))
    }
  })
  extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.25", protocolVersion: 2 } }))
  extension.send(JSON.stringify({ method: "ready" }))
  return extension
}

function postJson(relayUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(new URL(pathname, relayUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin: extensionOrigin })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  return socket
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for relay drain condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
