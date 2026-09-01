import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Effect, Latch, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHttpRequestHandler } from "../src/http-api.ts"
import { RecordingRelay } from "../src/recording-relay.ts"
import { ExecuteRequest, RelayShutdownRequest, SessionAdoptRequest } from "../src/relay-schema.ts"
import { RelayShutdown } from "../src/relay-shutdown.ts"
import { BrowserControlSessions } from "../src/session-manager.ts"
import { TargetRegistry } from "../src/target-registry.ts"

const shutdownRequest = RelayShutdownRequest.make({
  instanceId: "relay-test",
  requestId: "restart-test",
  reason: "explicit-restart",
  client: { kind: "cli", instanceId: "client-test", buildId: "build-test" },
})
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-http-api-"))
  vi.spyOn(os, "homedir").mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe("HTTP request schemas", () => {
  it("forwards decoded selectors and preserves schema errors and session normalization", async () => {
    const { server, port, sessions } = await startBoundaryServer()
    const session = sessions.summary("alpha")
    if (!session) throw new Error("test session was not created")
    const execute = vi.spyOn(sessions, "execute").mockReturnValue(Effect.succeed({
      session,
      result: { text: "ok", isError: false, logs: [], warnings: [], logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 } },
    }))
    const adopt = vi.spyOn(sessions, "adopt").mockReturnValue(Effect.succeed({ session, adoptedUrl: "https://target-7.example/", releasedTargetIds: [] }))
    try {
      for (const selection of [{}, { targetSelection: { index: 0 } }, { targetSelection: { urlIncludes: "target-8" } }]) {
        await expect(postJson(port, "/cli/execute", { sessionId: " alpha ", code: "1", createIfMissing: false, ...selection })).resolves.toMatchObject({ status: 200 })
        expect(execute.mock.lastCall?.[0]).toStrictEqual({ sessionId: "alpha", code: "1", createIfMissing: false, ...selection })
      }
      await postJson(port, "/cli/execute", { sessionId: "", code: "1", createIfMissing: true })
      expect(execute.mock.lastCall?.[0]).toStrictEqual({ code: "1", createIfMissing: true })
      for (const [targetSelection, targetId, targetUrl] of [
        [{ index: 0 }, "target-7", "https://target-7.example/"],
        [{ urlIncludes: "target-8" }, "target-8", "https://target-8.example/"],
      ] as const) {
        await expect(postJson(port, "/cli/session/adopt", { sessionId: " alpha ", createIfMissing: false, targetSelection })).resolves.toMatchObject({ status: 200 })
        expect(adopt.mock.lastCall?.[0]).toStrictEqual({ sessionId: "alpha", createIfMissing: false, targetId, targetUrl })
      }
      execute.mockClear()
      adopt.mockClear()
      for (const [pathname, schema, label] of [
        ["/cli/execute", ExecuteRequest, "execute"],
        ["/cli/session/adopt", SessionAdoptRequest, "session adopt"],
      ] as const) {
        for (const targetSelection of [{}, { urlIncludes: "" }, { urlIncludes: 42 }, { urlIncludes: "target", index: 0 }, { index: -1 }, { index: 1.5 }, { index: "0" }, null]) {
          const body = { code: "1", createIfMissing: true, targetSelection }
          const error = await Effect.runPromise(Schema.decodeUnknownEffect(schema)(body).pipe(Effect.flip))
          await expect(postJson(port, pathname, body)).resolves.toStrictEqual({
            status: 400,
            body: { error: `Invalid ${label} request: ${error.message}`, code: "invalid-request" },
          })
        }
      }
      expect(execute).not.toHaveBeenCalled()
      expect(adopt).not.toHaveBeenCalled()
    } finally {
      await close(server)
    }
  })

  it("preserves recording options and shares permissive POST/query target mapping without weakening start", async () => {
    const { server, port, recordingRelay } = await startBoundaryServer()
    const outputPath = path.join(home, "unused.webm")
    const start = vi.spyOn(recordingRelay, "startRecording").mockResolvedValue({ success: true, tabId: 7, startedAt: 1, path: outputPath, mimeType: "video/webm", mode: "tab-capture", artifactType: "webm" })
    const stop = vi.spyOn(recordingRelay, "stopRecording").mockResolvedValue({ success: true, tabId: 7, duration: 0, path: outputPath, size: 0, mode: "tab-capture", artifactType: "webm" })
    const cancel = vi.spyOn(recordingRelay, "cancelRecording").mockResolvedValue({ success: true })
    const status = vi.spyOn(recordingRelay, "statusRecording").mockResolvedValue({ isRecording: false })
    try {
      for (const options of [{}, { mode: "auto", audio: false, frameRate: 0, videoBitsPerSecond: 0, audioBitsPerSecond: 0, maxDurationMs: 0 }]) {
        await expect(postJson(port, "/recording/start", { sessionId: "owner-7", outputPath, ...options, ignored: "discard me" })).resolves.toMatchObject({ status: 200 })
        expect(start.mock.lastCall?.[0]).toStrictEqual({ tabId: 7, sessionId: "bc-tab-7", owner: "user", outputPath, ...options })
      }
      await postJson(port, "/recording/start", { tabId: 7, sessionId: "unknown", outputPath })
      expect(start.mock.lastCall?.[0]).toStrictEqual({ tabId: 7, sessionId: "bc-tab-7", owner: "user", outputPath })
      start.mockClear()
      for (const [selector, message, code, statusCode] of [
        [{ sessionId: "unknown" }, "No attached tab found for sessionId unknown", "target-not-found", 404],
        [{ tabId: 0 }, "No attached tab found for tabId 0", "target-not-found", 404],
        [{ sessionId: "" }, "Multiple attached tabs available; provide sessionId or tabId", "target-ambiguous", 409],
        [{ tabId: 1.5 }, "tabId must be an integer", "invalid-request", 400],
      ] as const) {
        await expect(postJson(port, "/recording/start", { outputPath, ...selector })).resolves.toStrictEqual({ status: statusCode, body: { error: message, code } })
      }
      expect(start).not.toHaveBeenCalled()
      for (const [body, query, target] of [
        [{}, "", {}],
        [{ sessionId: "", tabId: undefined }, "?sessionId=&tabId=", {}],
        [{ sessionId: "owner-7" }, "?sessionId=owner-7", { sessionId: "bc-tab-7" }],
        [{ sessionId: "bc-tab-7" }, "?sessionId=bc-tab-7", { sessionId: "bc-tab-7" }],
        [{ sessionId: "unknown" }, "?sessionId=unknown", { sessionId: "unknown" }],
        [{ tabId: 0 }, "?tabId=0", { tabId: 0 }],
        [{ tabId: 0 }, "?tabId=%20", { tabId: 0 }],
        [{ tabId: 10, sessionId: "owner-7" }, "?tabId=1e1&sessionId=owner-7", { tabId: 10, sessionId: "bc-tab-7" }],
      ] as const) {
        await expect(postJson(port, "/recording/stop", body)).resolves.toMatchObject({ status: 200 })
        expect(stop.mock.lastCall?.[0]).toStrictEqual(target)
        await expect(postJson(port, "/recording/cancel", body)).resolves.toMatchObject({ status: 200 })
        expect(cancel.mock.lastCall?.[0]).toStrictEqual(target)
        const response = await fetch(`http://127.0.0.1:${port}/recording/status${query}`)
        expect(response.status).toBe(200)
        await response.json()
        expect(status.mock.lastCall?.[0]).toStrictEqual(target)
      }
      status.mockClear()
      for (const value of ["1.5", "oops"]) {
        const response = await fetch(`http://127.0.0.1:${port}/recording/status?tabId=${value}`)
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toStrictEqual({ error: "tabId must be an integer", code: "invalid-request" })
      }
      expect(status).not.toHaveBeenCalled()
      await expect(postJson(port, "/recording/stop", { tabId: 1.5 })).resolves.toStrictEqual({ status: 400, body: { error: "tabId must be an integer", code: "invalid-request" } })
    } finally {
      await close(server)
    }
  })

  it("returns 400 for malformed session and recording requests", async () => {
    let handler: ReturnType<typeof createHttpRequestHandler> | undefined
    let shutdowns = 0
    const server = http.createServer((request, response) => {
      if (!handler) {
        response.writeHead(503).end()
        return
      }
      handler(request, response)
    })
    await listen(server)
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")
    const port = address.port
    const registry = new TargetRegistry()
    registry.addRootTarget({
      tabId: 7,
      sessionId: "bc-tab-7",
      browserControlSessionId: "alpha",
      owner: "user",
      targetInfo: {
        targetId: "target-7",
        type: "page",
        title: "Owned",
        url: "https://owned.example/",
        attached: true,
        canAccessOpener: false,
      },
    })
    const sessions = new BrowserControlSessions(`http://127.0.0.1:${port}`, undefined, undefined, registry)
    sessions.createNew("beta")
    const shutdown = new RelayShutdown({
      instanceId: "relay-test",
      managed: true,
      drain: sessions.beginDrain(),
      resume: () => sessions.resume(),
      busy: () => undefined,
      settle: Effect.void,
      quiescent: () => sessions.isDrained(),
      audit: () => Effect.void,
      stop: () => { shutdowns++ },
    })
    handler = createHttpRequestHandler({
      relayInstance: { id: "relay-test", startedAt: "2026-07-19T00:00:00.000Z", pid: 123, managed: true },
      shutdown,
      host: "127.0.0.1",
      port,
      browserId: "test-browser",
      extensionStatus: () => ({
        connected: true,
        version: "9.4.2",
        protocolVersion: 2,
        protocolCompatible: true,
        protocolLegacy: false,
      }),
      recordingRelay: new RecordingRelay({
        isExtensionConnected: () => true,
        sendToExtension: async () => ({}),
        sendDebuggerCommand: async () => ({}),
      }),
      registry,
      sessions,
    })

    try {
      const version = await fetch(`http://127.0.0.1:${port}/version`).then((response) => response.json())
      expect(version).toMatchObject({
        instanceId: "relay-test",
        startedAt: "2026-07-19T00:00:00.000Z",
        pid: 123,
        managed: true,
        shutdownProtocol: 2,
      })
      const extension = await fetch(`http://127.0.0.1:${port}/extension/status`).then((response) => response.json())
      expect(extension).toMatchObject({
        connected: true,
        version: "9.4.2",
        protocolVersion: 2,
        protocolCompatible: true,
        protocolLegacy: false,
      })
      await expect(postJson(port, "/cli/session/new", { id: "alpha", readOnly: "yes" })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid session new request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/cli/session/new", { id: "beta" })).resolves.toMatchObject({
        status: 409,
        body: { error: "Session already exists: beta", code: "session-already-exists" },
      })
      await expect(postJson(port, "/cli/session/new", { id: "INVALID" })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Session ids must use lowercase"), code: "invalid-request" },
      })
      await expect(postJson(port, "/recording/start", { outputPath: "/tmp/demo.webm", audio: "yes" })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid recording start request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/network/start", { sessionId: "beta", content: "everything" })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid network start request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/network/stop", { sessionId: "beta", secrets: 42 })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid network stop request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/auth/run", { name: "uber", command: "", timeoutMs: -1 })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid auth run request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/auth/status", { name: `missing-${Date.now()}` })).resolves.toMatchObject({
        status: 404,
        body: { error: expect.stringContaining("Auth profile not found"), code: "auth-profile-not-found" },
      })
      await expect(postJson(port, "/network/stop", { sessionId: "beta", outputPath: "/tmp/unused.har" })).resolves.toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("not active"), code: "capture-conflict" },
      })
      await expect(postJson(port, "/cli/execute", { code: 42, createIfMissing: true })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid execute request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/cli/session/adopt", { createIfMissing: true, targetSelection: {} })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid session adopt request"), code: "invalid-request" },
      })
      await expect(postJson(port, "/cli/execute", { sessionId: "ghost", code: "1", createIfMissing: false })).resolves.toMatchObject({
        status: 404,
        body: { error: "Session not found: ghost", code: "session-not-found" },
      })
      await expect(postJson(port, "/cli/session/delete", { id: "ghost" })).resolves.toMatchObject({
        status: 200,
        body: { deleted: false, id: "ghost" },
      })
      for (const invalid of [
        { instanceId: "relay-test" },
        { ...shutdownRequest, requestId: undefined },
        { ...shutdownRequest, reason: undefined },
        { ...shutdownRequest, reason: "automatic-restart" },
        { ...shutdownRequest, client: undefined },
        { ...shutdownRequest, client: { ...shutdownRequest.client, kind: "unknown" } },
        { ...shutdownRequest, client: { ...shutdownRequest.client, instanceId: undefined } },
        { ...shutdownRequest, client: { ...shutdownRequest.client, buildId: undefined } },
      ]) {
        await expect(postJson(port, "/shutdown", invalid)).resolves.toMatchObject({
          status: 400,
          body: { error: expect.stringContaining("Invalid relay shutdown request"), code: "invalid-request" },
        })
        expect(shutdown.accepting).toBe(true)
        expect(shutdowns).toBe(0)
      }
      await expect(postJson(port, "/shutdown", { ...shutdownRequest, instanceId: "another-relay" })).resolves.toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("does not match"), code: "invalid-request" },
      })
      expect(shutdowns).toBe(0)
      await expect(postJson(port, "/cli/session/adopt", {
        sessionId: "beta",
        createIfMissing: false,
        targetSelection: { urlIncludes: "missing.example" },
      })).resolves.toMatchObject({
        status: 404,
        body: { code: "target-not-found" },
      })
      await expect(postJson(port, "/cli/session/adopt", {
        sessionId: "beta",
        createIfMissing: false,
        targetSelection: { urlIncludes: "owned.example" },
      })).resolves.toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("already adopted by session alpha"), code: "target-owned" },
      })
      await expect(postJson(port, "/shutdown", shutdownRequest)).resolves.toMatchObject({
        status: 200,
        body: { stopping: true },
      })
      expect(shutdowns).toBe(1)
      for (const pathname of ["/cli/session/new", "/cli/execute", "/v1/sessions/ensure", "/recording/start", "/network/start", "/auth/run"]) {
        await expect(postJson(port, pathname, {})).resolves.toMatchObject({ status: 409, body: { code: "relay-busy" } })
      }
      await expect(postJson(port, "/shutdown", shutdownRequest)).resolves.toMatchObject({ status: 409, body: { code: "relay-busy" } })
      expect(shutdowns).toBe(1)
      for (const pathname of ["/version", "/extension/status", "/cli/sessions", "/json/list", "/recording/status"]) {
        expect((await fetch(`http://127.0.0.1:${port}${pathname}`)).status).toBe(200)
      }
      await expect(postJson(port, "/network/status", { sessionId: "beta" })).resolves.toMatchObject({ status: 200 })
      await expect(postJson(port, "/auth/status", { name: "missing-test-profile" })).resolves.toMatchObject({ status: 404, body: { code: "auth-profile-not-found" } })
    } finally {
      await close(server)
    }
  })

  it("keeps reads available while draining and resumes mutation admission when the shutdown socket aborts", async () => {
    const accepted = Latch.makeUnsafe()
    const release = Latch.makeUnsafe()
    const requested = Latch.makeUnsafe()
    const cancelled = Latch.makeUnsafe()
    const partialStarted = Latch.makeUnsafe()
    const stop = vi.fn()
    let handler: ReturnType<typeof createHttpRequestHandler> | undefined
    const server = http.createServer((request, response) => {
      if (handler) handler(request, response)
      else response.writeHead(503).end()
      if (request.headers["x-test-partial"] === "true") partialStarted.openUnsafe()
    })
    await listen(server)
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")
    const port = address.port
    const registry = new TargetRegistry()
    const sessions = new BrowserControlSessions(`http://127.0.0.1:${port}`, undefined, undefined, registry)
    sessions.createNew("alpha")
    const summary = sessions.summary("alpha")
    if (!summary) throw new Error("test session was not created")
    vi.spyOn(sessions, "ensure").mockImplementationOnce(() => accepted.open.pipe(
      Effect.andThen(release.await),
      Effect.as(summary),
    ))
    const shutdown = new RelayShutdown({
      instanceId: "relay-test",
      managed: true,
      drain: sessions.beginDrain(),
      resume: () => sessions.resume(),
      busy: () => undefined,
      settle: Effect.void,
      quiescent: () => sessions.isDrained(),
      audit: (event) => event._tag === "Requested" ? requested.open : event._tag === "Cancelled" ? cancelled.open : Effect.void,
      stop,
    })
    handler = createHttpRequestHandler({
      host: "127.0.0.1",
      port,
      browserId: "test-browser",
      relayInstance: { id: "relay-test", startedAt: "2026-07-19T00:00:00.000Z", pid: 123, managed: true },
      shutdown,
      extensionStatus: () => ({ connected: true, version: "9.4.2" }),
      registry,
      sessions,
      recordingRelay: new RecordingRelay({
        isExtensionConnected: () => true,
        sendToExtension: async () => ({}),
        sendDebuggerCommand: async () => ({}),
      }),
    })
    let restart: http.ClientRequest | undefined
    const partial = http.request({
      host: "127.0.0.1",
      port,
      path: "/cli/session/new",
      method: "POST",
      headers: { "content-type": "application/json", "x-test-partial": "true" },
    })
    const partialStatus = new Promise<number>((resolve) => {
      partial.once("response", (response) => {
        response.resume()
        response.once("end", () => resolve(response.statusCode ?? 0))
      })
      partial.once("error", () => resolve(0))
    })
    const work = postJson(port, "/v1/sessions/ensure", { id: "alpha" })
    try {
      await Effect.runPromise(accepted.await)
      partial.write('{"id":')
      await Effect.runPromise(partialStarted.await)
      restart = http.request({
        host: "127.0.0.1",
        port,
        path: "/shutdown",
        method: "POST",
        headers: { "content-type": "application/json" },
      })
      restart.on("error", () => {})
      restart.end(JSON.stringify(shutdownRequest))
      await Effect.runPromise(requested.await)
      expect(shutdown.accepting).toBe(false)
      expect(stop).not.toHaveBeenCalled()
      // Headers alone do not admit session work; a late body must fail closed.
      partial.end('"partial"}')
      await expect(partialStatus).resolves.toBe(409)
      expect(sessions.summary("partial")).toBeUndefined()
      await expect(postJson(port, "/cli/session/new", { id: "blocked" })).resolves.toMatchObject({ status: 409, body: { code: "relay-busy" } })
      await expect(postJson(port, "/shutdown", { ...shutdownRequest, requestId: "competing" })).resolves.toMatchObject({ status: 409, body: { code: "relay-busy" } })
      expect((await fetch(`http://127.0.0.1:${port}/cli/sessions`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${port}/version`)).status).toBe(200)
      await expect(postJson(port, "/network/status", { sessionId: "alpha" })).resolves.toMatchObject({ status: 200 })

      restart.destroy()
      await Effect.runPromise(cancelled.await)
      expect(shutdown.accepting).toBe(true)
      expect(stop).not.toHaveBeenCalled()
      await expect(postJson(port, "/cli/session/new", { id: "resumed" })).resolves.toMatchObject({ status: 200 })
      release.openUnsafe()
      await expect(work).resolves.toMatchObject({ status: 200, body: { session: { id: "alpha" } } })
      expect(stop).not.toHaveBeenCalled()
      await expect(postJson(port, "/shutdown", { ...shutdownRequest, requestId: "retry" })).resolves.toMatchObject({ status: 200, body: { stopping: true } })
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      restart?.destroy()
      partial.destroy()
      release.openUnsafe()
      await work
      await close(server)
    }
  })
})

async function startBoundaryServer() {
  const registry = new TargetRegistry()
  for (const tabId of [7, 8]) {
    registry.addRootTarget({
      tabId,
      sessionId: `bc-tab-${tabId}`,
      browserControlSessionId: `owner-${tabId}`,
      owner: "user",
      targetInfo: { targetId: `target-${tabId}`, type: "page", title: "Test", url: `https://target-${tabId}.example/`, attached: true, canAccessOpener: false },
    })
  }
  const recordingRelay = new RecordingRelay({
    isExtensionConnected: () => true,
    sendToExtension: async () => { throw new Error("unexpected extension call") },
    sendDebuggerCommand: async () => { throw new Error("unexpected debugger call") },
  })
  let handler: ReturnType<typeof createHttpRequestHandler> | undefined
  const server = http.createServer((request, response) => handler ? handler(request, response) : response.writeHead(503).end())
  await listen(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")
  const port = address.port
  const sessions = new BrowserControlSessions(`http://127.0.0.1:${port}`, undefined, undefined, registry)
  sessions.createNew("alpha")
  handler = createHttpRequestHandler({
    host: "127.0.0.1", port, browserId: "test-browser",
    relayInstance: { id: "relay-test", startedAt: "2026-07-19T00:00:00.000Z", pid: 123, managed: true },
    shutdown: new RelayShutdown({
      instanceId: "relay-test", managed: true,
      drain: sessions.beginDrain(), resume: () => sessions.resume(), busy: () => undefined,
      settle: Effect.void, quiescent: () => sessions.isDrained(), audit: () => Effect.void, stop: () => {},
    }),
    extensionStatus: () => ({ connected: true, version: "9.4.2" }),
    registry, sessions, recordingRelay,
  })
  return { server, port, sessions, recordingRelay }
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function postJson(port: number, path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.once("error", reject)
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown })
      })
    })
    request.once("error", reject)
    request.end(JSON.stringify(body))
  })
}
