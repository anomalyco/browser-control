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
const profileId = "11111111-1111-4111-8111-111111111111"

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("relay session persistence", () => {
  it("creates no phantom profile and restores a named session after a clean relay restart", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const absent = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "restart-proof" }) })
        expect(absent.status).toBe(404)
        expect(await absent.json()).toMatchObject({ code: "profile-not-found" })
        expect(await fetch(`${relay.url}/extension/status`).then((response) => response.json())).toMatchObject({ profiles: [] })
        expect(await fetch(`${relay.url}/cli/sessions`).then((response) => response.json())).toMatchObject({ sessions: [] })
        const extension = await openProtocolExtension(relay.url)
        try {
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).connected)
          const response = await fetch(new URL("/cli/session/new", relay.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "restart-proof", readOnly: true }),
          })
          expect(response.status).toBe(200)
        } finally {
          extension.close()
        }
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

  it("durably restores profile pins and names without switching to the only connected profile", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const otherProfileId = "22222222-2222-4222-8222-222222222222"
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const personal = await openProtocolExtension(relay.url)
        const work = await openProtocolExtension(relay.url, undefined, { profileId: otherProfileId, profileName: "Work" })
        try {
          await waitFor(async () => {
            const status = await fetch(`${relay.url}/extension/status`).then((response) => response.json())
            return status.profiles?.filter((profile: { connected: boolean }) => profile.connected).length === 2
          })
          for (const [id, selectedProfileId] of [["personal", profileId], ["work", otherProfileId]]) {
            const response = await fetch(`${relay.url}/cli/session/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, profileId: selectedProfileId }) })
            expect(response.status).toBe(200)
          }
          expect(await new SessionCatalog(sessionCatalogPath).load()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "personal", profileId, profileName: "Personal" }),
            expect.objectContaining({ id: "work", profileId: otherProfileId, profileName: "Work" }),
          ]))
        } finally {
          personal.close()
          work.close()
        }
      })
    })))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        expect(await fetch(`${relay.url}/cli/sessions`).then((response) => response.json())).toMatchObject({ sessions: expect.arrayContaining([
          expect.objectContaining({ id: "personal", profileId, profileName: "Personal", connected: false }),
          expect.objectContaining({ id: "work", profileId: otherProfileId, profileName: "Work", connected: false }),
        ]) })
        const work = await openProtocolExtension(relay.url, undefined, { profileId: otherProfileId, profileName: "Work" })
        try {
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).connected)
          const ensured = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "personal" }) })
          expect(ensured.status).toBe(200)
          expect(await ensured.json()).toMatchObject({ session: { id: "personal", profileId, profileName: "Personal" } })
          const mismatch = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "personal", profileId: otherProfileId }) })
          expect(mismatch.status).toBe(409)
        } finally {
          work.close()
        }
      })
    })))
  })

  it("restores colliding target identities only to their persisted profile owners", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const otherProfileId = "22222222-2222-4222-8222-222222222222"
    await new SessionCatalog(sessionCatalogPath).save([profileId, otherProfileId].map((id, index) => ({
      id: index === 0 ? "personal" : "work",
      profileId: id,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:01:00.000Z",
      readOnly: false,
      target: { id: "shared-target", owner: "user" as const },
    })))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const work = await openProtocolExtension(relay.url, "shared-target", { profileId: otherProfileId, profileName: "Work" })
        const personal = await openProtocolExtension(relay.url, "shared-target")
        try {
          let targets: unknown
          await waitFor(async () => {
            targets = await fetch(`${relay.url}/json/list`).then((response) => response.json())
            return Array.isArray(targets) && targets.length === 2
          })
          expect(targets).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "shared-target", profileId, browserControlSessionId: "personal", owner: "user" }),
            expect.objectContaining({ id: "shared-target", profileId: otherProfileId, browserControlSessionId: "work", owner: "user" }),
          ]))
          personal.close()
          await waitFor(async () => (await fetch(`${relay.url}/json/list`).then((response) => response.json())).length === 1)
          expect(await fetch(`${relay.url}/json/list`).then((response) => response.json())).toMatchObject([
            { id: "shared-target", profileId: otherProfileId, browserControlSessionId: "work", owner: "user" },
          ])
        } finally {
          work.close()
          personal.close()
        }
      })
    })))
  })

  it.each([undefined, "legacy"])("binds a legacy target (%s) only to its matching ready profile and never switches that pin", async (previousProfileId) => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    const otherProfileId = "22222222-2222-4222-8222-222222222222"
    await catalog.save([{
      id: "legacy-target-session",
      ...(previousProfileId ? { profileId: previousProfileId } : {}),
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:01:00.000Z",
      readOnly: true,
      target: { id: "legacy-target", owner: "user" },
    }])
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const wrong = await openProtocolExtension(relay.url, "unrelated-target", { profileId: otherProfileId, profileName: "Work" })
        let matching: WebSocket | undefined
        let reconnectedWrong: WebSocket | undefined
        try {
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).connected)
          const before = await fetch(`${relay.url}/cli/sessions`).then((response) => response.json())
          expect(before.sessions).toHaveLength(1)
          expect(before.sessions[0].profileId).not.toBe(otherProfileId)
          expect(await fetch(`${relay.url}/json/list`).then((response) => response.json())).toEqual([
            expect.objectContaining({ id: "unrelated-target", profileId: otherProfileId }),
          ])
          expect((await catalog.load())[0]?.profileId).not.toBe(otherProfileId)
          const wrongEnsure = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-target-session" }) })
          expect(wrongEnsure.status).toBe(409)
          expect(await wrongEnsure.json()).toMatchObject({ code: "profile-mismatch" })
          const wrongExplicit = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-target-session", profileId: otherProfileId }) })
          expect(wrongExplicit.status).toBe(409)
          expect((await catalog.load())[0]?.profileId).not.toBe(otherProfileId)
          matching = await openProtocolExtension(relay.url, "legacy-target", { profileId, profileName: "Personal" }, false)
          await waitFor(async () => (await fetch(`${relay.url}/json/list`).then((response) => response.json())).some((target: { id: string; profileId?: string }) => target.id === "legacy-target" && target.profileId === profileId))
          expect((await catalog.load())[0]?.profileId).not.toBe(profileId)
          const premature = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-target-session" }) })
          expect(premature.status).toBe(409)
          matching.send(JSON.stringify({ method: "ready" }))
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).profiles.some((profile: { id: string; connected: boolean }) => profile.id === profileId && profile.connected))
          const ensured = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-target-session" }) })
          expect(ensured.status).toBe(200)
          expect(await ensured.json()).toMatchObject({ session: { id: "legacy-target-session", profileId } })
          expect(await fetch(`${relay.url}/json/list`).then((response) => response.json())).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "legacy-target", profileId, browserControlSessionId: "legacy-target-session", owner: "user" }),
          ]))
          await waitFor(async () => (await catalog.load())[0]?.profileId === profileId)
          expect(await catalog.load()).toMatchObject([{ id: "legacy-target-session", profileId, readOnly: true, target: { id: "legacy-target", owner: "user" } }])
          matching.close()
          wrong.close()
          await waitFor(async () => (await fetch(`${relay.url}/json/list`).then((response) => response.json())).length === 0)
          reconnectedWrong = await openProtocolExtension(relay.url, "legacy-target", { profileId: otherProfileId, profileName: "Work" })
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).connected)
          const wrongTargets = await fetch(`${relay.url}/json/list`).then((response) => response.json())
          expect(wrongTargets).toHaveLength(1)
          expect(wrongTargets[0]).toMatchObject({ id: "legacy-target", profileId: otherProfileId })
          expect(wrongTargets[0].browserControlSessionId).toBeUndefined()
          expect(await catalog.load()).toMatchObject([{ id: "legacy-target-session", profileId }])
        } finally {
          wrong.close()
          matching?.close()
          reconnectedWrong?.close()
        }
      })
    })))
  })

  it("does not infer a legacy profile from target ids shared by two ready inventories", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    const otherProfileId = "22222222-2222-4222-8222-222222222222"
    await catalog.save([{
      id: "legacy-collision",
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:01:00.000Z",
      readOnly: false,
      target: { id: "shared-target", owner: "user" },
    }])
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const personal = await openProtocolExtension(relay.url, "shared-target")
        const work = await openProtocolExtension(relay.url, "shared-target", { profileId: otherProfileId, profileName: "Work" })
        try {
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).profiles.filter((profile: { connected: boolean }) => profile.connected).length === 2)
          const ambiguous = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-collision" }) })
          expect(ambiguous.status).toBe(409)
          expect(await ambiguous.json()).toMatchObject({ code: "profile-ambiguous" })
          expect([profileId, otherProfileId]).not.toContain((await catalog.load())[0]?.profileId)
          const targets = await fetch(`${relay.url}/json/list`).then((response) => response.json())
          expect(targets).toHaveLength(2)
          expect(targets.every((target: { browserControlSessionId?: string }) => target.browserControlSessionId === undefined)).toBe(true)
        } finally {
          personal.close()
          work.close()
        }
      })
    })))
  })

  it("requires explicit profile selection before binding a targetless legacy session", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    await catalog.save([{
      id: "legacy-targetless",
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:01:00.000Z",
      readOnly: true,
    }])
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath })
      yield* Effect.tryPromise(async () => {
        const extension = await openProtocolExtension(relay.url)
        try {
          await waitFor(async () => (await fetch(`${relay.url}/extension/status`).then((response) => response.json())).connected)
          const implicit = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-targetless" }) })
          expect(implicit.status).toBe(409)
          expect(await implicit.json()).toMatchObject({ error: expect.stringMatching(/profile/i) })
          expect((await catalog.load())[0]?.profileId).not.toBe(profileId)
          const explicit = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-targetless", profileId }) })
          expect(explicit.status).toBe(200)
          expect(await explicit.json()).toMatchObject({ session: { id: "legacy-targetless", profileId, profileName: "Personal", readOnly: true } })
          expect(await catalog.load()).toMatchObject([{ id: "legacy-targetless", profileId, profileName: "Personal", readOnly: true }])
          const automatic = await fetch(`${relay.url}/v1/sessions/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-targetless" }) })
          expect(automatic.status).toBe(200)
          expect(await automatic.json()).toMatchObject({ session: { id: "legacy-targetless", profileId } })
        } finally {
          extension.close()
        }
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
      profileId,
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

  it("waits for a delayed relay target re-announcement before resetting", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    await catalog.save([{
      id: "restored",
      profileId,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "relay-target", owner: "relay" },
    }])

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath, releaseTargetGraceMs: 1_000 })
      yield* Effect.tryPromise(async () => {
        let settled = false
        const resetPromise = fetch(new URL("/cli/session/reset", relay.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "restored" }),
        }).then((response) => {
          settled = true
          return response
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(settled).toBe(false)

        const extension = await openProtocolExtension(relay.url, "relay-target")
        const reset = await resetPromise
        expect(reset.status).toBe(200)
        expect(extension.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === 7)).toBe(true)
        await expect(catalog.load()).resolves.toMatchObject([{
          id: "restored",
          profileId,
        }])
        expect((await catalog.load())[0]?.target).toBeUndefined()
        extension.close()
      })
    })))
  })

  for (const operation of ["reset", "delete"] as const) {
    it(`${operation} forgets a relay target missing from a completed extension inventory`, async () => {
      const port = await freePort()
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
      temporaryDirectories.push(directory)
      const sessionCatalogPath = path.join(directory, "sessions.json")
      const catalog = new SessionCatalog(sessionCatalogPath)
      await catalog.save([{
        id: "restored",
        profileId,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:01:00.000Z",
        readOnly: false,
        target: { id: "dead-target", owner: "relay" },
      }])

      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const relay = yield* startRelay({ port, sessionCatalogPath, releaseTargetGraceMs: 1_000 })
        yield* Effect.tryPromise(async () => {
          const lifecycle = fetch(new URL(`/cli/session/${operation}`, relay.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "restored" }),
          })
          const extension = await openProtocolExtension(relay.url)
          const response = await lifecycle

          expect(response.status).toBe(200)
          expect(extension.commands.some((command) => command.method === "tabs.remove")).toBe(false)
          const entries = await catalog.load()
          if (operation === "reset") {
            expect(entries).toMatchObject([{ id: "restored" }])
            expect(entries[0]?.target).toBeUndefined()
          } else {
            expect(entries).toEqual([])
          }
          extension.close()
        })
      })))
    })
  }

  it("bounds stale relay target cleanup when no extension inventory arrives", async () => {
    const port = await freePort()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-sessions-"))
    temporaryDirectories.push(directory)
    const sessionCatalogPath = path.join(directory, "sessions.json")
    const catalog = new SessionCatalog(sessionCatalogPath)
    await catalog.save([{
      id: "restored",
      profileId,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "dead-target", owner: "relay" },
    }])

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const relay = yield* startRelay({ port, sessionCatalogPath, releaseTargetGraceMs: 20 })
      yield* Effect.tryPromise(async () => {
        const response = await fetch(new URL("/cli/session/reset", relay.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "restored" }),
        })
        expect(response.status).toBe(200)
        expect((await catalog.load())[0]?.target).toBeUndefined()
      })
    })))
  })
})

type FakeExtensionCommand = {
  readonly id: number
  readonly method: string
  readonly params?: { readonly method?: string; readonly tabId?: number }
}

async function openProtocolExtension(relayUrl: string, targetId?: string, identity = { profileId, profileName: "Personal" }, ready = true): Promise<WebSocket & { readonly commands: FakeExtensionCommand[] }> {
  const commands: FakeExtensionCommand[] = []
  const extension = await openSocket(`${relayUrl.replace("http://", "ws://")}/extension`)
  extension.on("message", (data) => {
    const command = JSON.parse(data.toString()) as FakeExtensionCommand
    commands.push(command)
    const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo" && targetId
      ? { targetInfo: { targetId, type: "page", title: "Restored", url: "https://example.com/", attached: true, canAccessOpener: false } }
      : {}
    extension.send(JSON.stringify({ id: command.id, result }))
  })
  extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2, ...identity } }))
  if (targetId) extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
  if (ready) extension.send(JSON.stringify({ method: "ready" }))
  return Object.assign(extension, { commands })
}

async function openFakeExtension(relayUrl: string, targetId: string): Promise<WebSocket> {
  const extension = await openSocket(`${relayUrl.replace("http://", "ws://")}/extension`)
  extension.on("message", (data) => {
    const command = JSON.parse(data.toString()) as { readonly id: number; readonly method: string; readonly params?: { readonly method?: string } }
    const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo"
      ? { targetInfo: { targetId, type: "page", title: "Restored", url: "https://example.com/", attached: true, canAccessOpener: false } }
      : {}
    extension.send(JSON.stringify({ id: command.id, result }))
  })
  extension.send(JSON.stringify({ method: "hello", params: { version: "0.0.23", protocolVersion: 2, profileId } }))
  extension.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 7 } }))
  return extension
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin: "chrome-extension://browser-control-test" })
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
