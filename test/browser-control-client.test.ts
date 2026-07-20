import http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import * as BrowserControlClient from "../src/browser-control-client.ts"
import { browserControlBuildId, browserControlVersion } from "../src/version.ts"

let server: http.Server
let endpoint: string
let authenticatedOutcome: unknown

const session = {
  id: "x-live-chat-auth",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  connected: true,
  pageUrl: "https://studio.x.com/live",
  stateKeys: [],
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    response.setHeader("content-type", "application/json")
    if (path === "/version") {
      response.end(JSON.stringify({ version: browserControlVersion, buildId: browserControlBuildId }))
      return
    }
    if (path === "/extension/status") {
      response.end(JSON.stringify({ connected: true, version: "test", activeTargets: 1 }))
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      if (path === "/v1/sessions/ensure") {
        response.end(JSON.stringify({ session }))
        return
      }
      if (path === "/cli/session/reset") {
        response.end(JSON.stringify({ session }))
        return
      }
      if (path === "/v1/authenticated-origin/json") {
        response.end(JSON.stringify(authenticatedOutcome))
        return
      }
      response.writeHead(404)
      response.end(JSON.stringify({ error: "not found" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected test server address")
  endpoint = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const makeOrigin = Effect.gen(function* () {
  const client = yield* BrowserControlClient.make({ endpoint })
  const liveSession = yield* client.ensureSession({ id: session.id })
  return yield* liveSession.authenticatedOrigin({
    origin: "https://studio.x.com",
    startUrl: "/live",
  })
})

describe("BrowserControlClient", () => {
  it("resets a named session", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* BrowserControlClient.make({ endpoint })
      return yield* client.resetSession(session.id)
    }))
    expect(result.id).toBe(session.id)
    expect(result.summary).toEqual(session)
  })

  it("schema-decodes authenticated JSON responses", async () => {
    authenticatedOutcome = { _tag: "Success", status: 200, value: { rows: [{ id: "1" }] } }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const origin = yield* makeOrigin
      return yield* origin.json({
        path: "/api/live/get-broadcasts?limit=1000",
        response: Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      })
    }))
    expect(result).toEqual({ rows: [{ id: "1" }] })
  })

  it("returns sensitive values as Redacted and redacts schema failures", async () => {
    const token = "distinctive-secret-chat-token"
    authenticatedOutcome = { _tag: "Success", status: 200, value: { accessToken: token } }
    const redacted = await Effect.runPromise(Effect.gen(function* () {
      const origin = yield* makeOrigin
      return yield* origin.json({
        path: "/api/live/get-chat-session",
        method: "POST",
        body: { broadcastId: "1" },
        response: Schema.Struct({ accessToken: Schema.String }),
        sensitive: true,
      })
    }))
    expect(String(redacted)).not.toContain(token)
    expect(BrowserControlClient.reveal(redacted)).toEqual({ accessToken: token })

    authenticatedOutcome = { _tag: "Success", status: 200, value: { accessToken: token } }
    const error = await Effect.runPromise(Effect.gen(function* () {
      const origin = yield* makeOrigin
      return yield* origin.json({
        path: "/api/live/get-chat-session",
        response: Schema.Struct({ accessToken: Schema.Number }),
        sensitive: true,
      })
    }).pipe(Effect.flip))
    expect(error.message).not.toContain(token)
    expect(String(error)).not.toContain(token)
  })

  it("reports mutating transport ambiguity as an unknown outcome", async () => {
    authenticatedOutcome = { _tag: "RequestFailed", outcome: "unknown" }
    const error = await Effect.runPromise(Effect.gen(function* () {
      const origin = yield* makeOrigin
      return yield* origin.json({
        path: "/api/live/go-live",
        method: "POST",
        body: { title: "Private stream" },
        response: Schema.Unknown,
      })
    }).pipe(Effect.flip))
    expect(error).toBeInstanceOf(BrowserControlClient.RequestOutcomeUnknown)
  })
})
