import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"
import { startRelay } from "../src/relay.ts"
import { SessionCatalog } from "../src/session-catalog.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("relay session persistence", () => {
  it("restores a named session after a clean relay restart", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const response = await fetch(new URL("/cli/session/new", relay.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "restart-proof", readOnly: true }),
        })
        expect(response.status).toBe(200)
      })
    })))

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const response = await fetch(new URL("/cli/sessions", relay.url))
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({
          sessions: [{ id: "restart-proof", readOnly: true, connected: false, pageUrl: null, stateKeys: [] }],
        })
      })
    })))
  })

  it("reclaims persisted target ownership when the extension re-announces the tab", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    await new SessionCatalog(sessionCatalogPath).save([{
      id: "restored",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "restored-target", owner: "user" },
    }])

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const extension = await openFakeExtension(relay.url, "restored-target")

        let targets: unknown
        await waitFor(async () => {
          targets = await fetch(new URL("/json/list", relay.url)).then((response) => response.json())
          return Array.isArray(targets) && targets.some((target) => {
            return typeof target === "object" && target !== null &&
              "browserControlSessionId" in target && target.browserControlSessionId === "restored"
          })
        })
        expect(targets).toMatchObject([{
          id: "restored-target",
          owner: "user",
          browserControlSessionId: "restored",
        }])
        extension.close()
        await waitFor(async () => {
          const current = await fetch(new URL("/json/list", relay.url)).then((response) => response.json())
          return Array.isArray(current) && current.length === 0
        })

        const reconnected = await openFakeExtension(relay.url, "restored-target")
        await waitFor(async () => {
          const current = await fetch(new URL("/json/list", relay.url)).then((response) => response.json())
          return Array.isArray(current) && current.some((target) => {
            return typeof target === "object" && target !== null &&
              "browserControlSessionId" in target && target.browserControlSessionId === "restored"
          })
        })
        const reset = await fetch(new URL("/cli/session/reset", relay.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "restored" }),
        })
        expect(reset.status).toBe(200)
        await waitFor(async () => {
          const current = await fetch(new URL("/json/list", relay.url)).then((response) => response.json())
          return Array.isArray(current) && current.some((target) => {
            return typeof target === "object" && target !== null &&
              "id" in target && target.id === "restored-target" &&
              !("browserControlSessionId" in target)
          })
        })
        reconnected.close()
      })
    })))
  })

  it("does not let a process that loses the port race rewrite the catalog", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    await catalog.save([{
      id: "port-owner",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
    }])

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* startRelay({ port, sessionCatalogPath })
      const before = fs.readFileSync(sessionCatalogPath, "utf8")
      const failure = yield* Effect.result(Effect.scoped(startRelay({ port, sessionCatalogPath })))
      expect(failure._tag).toBe("Failure")
      expect(fs.readFileSync(sessionCatalogPath, "utf8")).toBe(before)
    })))
  })

  it("retains a restored relay target when reset runs before extension re-announcement", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    await catalog.save([{
      id: "restored",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "relay-target", owner: "relay" },
    }])

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const reset = await fetch(new URL("/cli/session/reset", relay.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "restored" }),
        })
        expect(reset.status).toBe(500)
        await expect(catalog.load()).resolves.toMatchObject([{
          id: "restored",
          target: { id: "relay-target", owner: "relay" },
        }])
      })
    })))
  })
})

async function openFakeExtension(relayUrl: string, targetId: string): Promise<WebSocket> {
  const extension = await openSocket(`${relayUrl.replace("http://", "ws://")}/extension`)
  extension.on("message", (data) => {
    const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: { readonly method?: string } }
    const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
      ? { targetInfo: { targetId, type: "page", title: "Restored", url: "https://example.com/", attached: true, canAccessOpener: false } }
      : {}
    extension.send(JSON.stringify({ id: command.id, result }))
  })
  extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.17" } }))
  extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
  return extension
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  return socket
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for relay test condition")
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
