import http from "node:http"
import { describe, expect, it } from "vitest"
import { createHttpRequestHandler } from "../src/http-api.ts"
import { RecordingRelay } from "../src/recording-relay.ts"
import { BrowserControlSessions } from "../src/session-manager.ts"
import { TargetRegistry } from "../src/target-registry.ts"

describe("HTTP request schemas", () => {
  it("returns 400 for malformed session and recording requests", async () => {
    let handler: ReturnType<typeof createHttpRequestHandler> | undefined
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
    handler = createHttpRequestHandler({
      host: "127.0.0.1",
      port,
      browserId: "test-browser",
      extensionStatus: () => ({ connected: true, version: "test" }),
      recordingRelay: new RecordingRelay({
        isExtensionConnected: () => true,
        sendToExtension: async () => ({}),
        sendDebuggerCommand: async () => ({}),
      }),
      registry,
      sessions,
    })

    try {
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
    } finally {
      await close(server)
    }
  })
})

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
