import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import http from "node:http"
import * as RelayClient from "../src/relay-client.ts"

type CannedResponse = {
  readonly status: number
  readonly body: unknown
}

let server: http.Server
let endpoint: string
const routes = new Map<string, CannedResponse>()
let lastRequestBody: unknown

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const key = `${request.method} ${new URL(request.url ?? "/", "http://localhost").pathname}`
    const canned = routes.get(key)
    if (!canned) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: `no canned route for ${key}` }))
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      lastRequestBody = text ? JSON.parse(text) : undefined
      response.writeHead(canned.status, { "content-type": "application/json" })
      response.end(JSON.stringify(canned.body))
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Expected server address")
  }
  endpoint = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

const withClient = <A, E>(use: (client: RelayClient.Interface) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    RelayClient.make({ endpoint }).pipe(
      Effect.flatMap(use),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const session = {
  id: "rapid-otter-633",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:01.000Z",
  connected: true,
  pageUrl: null,
  stateKeys: [],
}

describe("RelayClient", () => {
  it("decodes sessions", async () => {
    routes.set("GET /cli/sessions", { status: 200, body: { sessions: [session] } })
    const sessions = await withClient((client) => client.sessions)
    expect(sessions.map((item) => item.id)).toEqual(["rapid-otter-633"])
  })

  it("keeps the relay's error message as the top-level failure message", async () => {
    routes.set("POST /cli/session/delete", { status: 404, body: { error: "Session not found: ghost", code: "session-not-found" } })
    const error = await withClient((client) => client.sessionDelete("ghost").pipe(Effect.flip))
    expect(error._tag).toBe("RelayClient.RelayRejected")
    expect(error.message).toBe("Session not found: ghost")
    expect(error._tag === "RelayClient.RelayRejected" ? error.code : undefined).toBe("session-not-found")
  })

  it("fails with RelayRejected including HTTP status when no error envelope exists", async () => {
    routes.set("GET /version", { status: 500, body: "boom" })
    const error = await withClient((client) => client.version.pipe(Effect.flip))
    expect(error._tag).toBe("RelayClient.RelayRejected")
    expect(error.message).toContain("HTTP 500")
  })

  it("preserves the relay message when a newer relay returns an unknown error code", async () => {
    routes.set("POST /cli/session/delete", { status: 409, body: { error: "specific future conflict", code: "future-code" } })
    const error = await withClient((client) => client.sessionDelete("ghost").pipe(Effect.flip))
    expect(error.message).toBe("specific future conflict")
    expect(error._tag === "RelayClient.RelayRejected" ? error.code : undefined).toBeUndefined()
  })

  it("fails with RelayDecodeFailed for shape drift", async () => {
    routes.set("GET /extension/status", { status: 200, body: { connected: "yes" } })
    const error = await withClient((client) => client.extensionStatus.pipe(Effect.flip))
    expect(error._tag).toBe("RelayClient.RelayDecodeFailed")
    expect(error.message).toContain("/extension/status")
  })

  it("fails with RelayUnreachable when nothing is listening", async () => {
    const error = await Effect.runPromise(
      RelayClient.make({ endpoint: "http://127.0.0.1:1" }).pipe(
        Effect.flatMap((client) => client.version),
        Effect.provide(FetchHttpClient.layer),
        Effect.flip,
      ),
    )
    expect(error._tag).toBe("RelayClient.RelayUnreachable")
    expect(error.message).toContain("browser-control serve")
  })

  it("decodes execute responses", async () => {
    routes.set("POST /cli/execute", {
      status: 200,
      body: { text: "42", isError: false, logs: [{ source: "script", type: "log", text: "hi" }], session },
    })
    const result = await withClient((client) =>
      client.execute({ sessionId: session.id, code: "6 * 7", createIfMissing: false }))
    expect(result.text).toBe("42")
    expect(result.logs[0]?.text).toBe("hi")
    expect(result.session.id).toBe(session.id)
    expect(lastRequestBody).toEqual({ sessionId: session.id, code: "6 * 7", createIfMissing: false })
  })

  it("decodes execute image media", async () => {
    routes.set("POST /cli/execute", {
      status: 200,
      body: {
        text: "Image (image/png, 8 bytes)",
        media: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 }],
        isError: false,
        logs: [],
        session,
      },
    })
    const result = await withClient((client) =>
      client.execute({ sessionId: session.id, code: "page.screenshot()", createIfMissing: false }))
    expect(result.media).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 }])
  })

  it("decodes session adopt responses", async () => {
    routes.set("POST /cli/session/adopt", {
      status: 200,
      body: { session: { ...session, pageUrl: "https://example.com/", created: true }, adoptedUrl: "https://example.com/", adoptedTargetId: "target-2" },
    })
    const result = await withClient((client) =>
      client.sessionAdopt({ sessionId: session.id, createIfMissing: true, targetSelection: { urlIncludes: "example.com" } }))
    expect(result.session.id).toBe(session.id)
    expect(result.adoptedUrl).toBe("https://example.com/")
    expect(result.adoptedTargetId).toBe("target-2")
    expect(result.session.created).toBe(true)
  })

  it("preserves recording bitrate options", async () => {
    routes.set("POST /recording/start", {
      status: 200,
      body: { success: true, tabId: 7, startedAt: 1 },
    })
    await withClient((client) => client.recordingStart({
      outputPath: "/tmp/demo.webm",
      tabId: 7,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000,
    }))
    expect(lastRequestBody).toMatchObject({
      outputPath: "/tmp/demo.webm",
      tabId: 7,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000,
    })
  })

  it("preserves network limits and decodes capture results", async () => {
    routes.set("POST /network/start", {
      status: 200,
      body: {
        active: true,
        startedAt: "2026-07-19T00:00:00.000Z",
        entryCount: 0,
        responseCount: 0,
        failureCount: 0,
        capturedBodyBytes: 0,
        truncatedBodyCount: 0,
        droppedEntryCount: 0,
        content: "embed",
      },
    })
    const result = await withClient((client) => client.networkStart({
      sessionId: session.id,
      urlFilter: "/api/",
      resourceTypes: ["fetch", "xhr"],
      maxBodyBytes: 100,
      maxTotalBodyBytes: 1_000,
      maxEntries: 25,
    }))
    expect(result.active).toBe(true)
    expect(lastRequestBody).toMatchObject({
      sessionId: session.id,
      urlFilter: "/api/",
      resourceTypes: ["fetch", "xhr"],
      maxBodyBytes: 100,
      maxTotalBodyBytes: 1_000,
      maxEntries: 25,
    })
  })

  it("decodes redacted command-run output", async () => {
    routes.set("POST /auth/run", {
      status: 200,
      body: {
        exitCode: 0,
        signal: null,
        stdout: "${BC_SECRET_1}\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 12,
      },
    })
    const result = await withClient((client) => client.authRun({ name: "uber", command: "./uber-cli", args: ["restaurants"] }))
    expect(result.stdout).toBe("${BC_SECRET_1}\n")
    expect(lastRequestBody).toEqual({ name: "uber", command: "./uber-cli", args: ["restaurants"] })
  })
})
