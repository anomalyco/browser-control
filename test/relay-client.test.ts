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

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const key = `${request.method} ${new URL(request.url ?? "/", "http://localhost").pathname}`
    const canned = routes.get(key)
    if (!canned) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: `no canned route for ${key}` }))
      return
    }
    response.writeHead(canned.status, { "content-type": "application/json" })
    response.end(JSON.stringify(canned.body))
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
    routes.set("POST /cli/session/delete", { status: 404, body: { error: "Session not found: ghost" } })
    const error = await withClient((client) => client.sessionDelete("ghost").pipe(Effect.flip))
    expect(error._tag).toBe("RelayClient.RelayRejected")
    expect(error.message).toBe("Session not found: ghost")
  })

  it("fails with RelayRejected including HTTP status when no error envelope exists", async () => {
    routes.set("GET /version", { status: 500, body: "boom" })
    const error = await withClient((client) => client.version.pipe(Effect.flip))
    expect(error._tag).toBe("RelayClient.RelayRejected")
    expect(error.message).toContain("HTTP 500")
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
})
