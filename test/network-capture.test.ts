import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Page, Request, Response } from "playwright-core"
import { afterEach, describe, expect, it } from "vitest"
import { Recorder } from "../src/network-capture.ts"
import * as AuthProfile from "../src/auth-profile.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("NetworkCapture", () => {
  it("captures complete exchanges across page bindings and writes a reusable auth profile", async () => {
    const directory = await temporaryDirectory()
    const profileDirectory = path.join(directory, "profiles")
    const outputPath = path.join(directory, "capture.har")
    const firstPage = new FakePage()
    const secondPage = new FakePage()
    const recorder = new Recorder({ authProfileBaseDir: profileDirectory })

    await Effect.runPromise(recorder.start(firstPage as unknown as Page, { urlFilter: "/api/" }))
    firstPage.exchange({
      url: "https://example.com/api/restaurants?access_token=query-token",
      requestHeaders: [{ name: "Authorization", value: "Bearer access-token" }],
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      responseBody: Buffer.from(JSON.stringify({ restaurants: ["A"] })),
    })
    recorder.bindPage(secondPage as unknown as Page)
    firstPage.exchange({ url: "https://example.com/api/ignored" })
    secondPage.exchange({
      url: "https://example.com/api/account",
      requestHeaders: [{ name: "Cookie", value: "session=cookie-value" }],
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      responseBody: Buffer.from(JSON.stringify({ refreshToken: "refresh-value" })),
    })

    const result = await Effect.runPromise(recorder.stop({ outputPath, secrets: "uber" }))
    expect(result).toMatchObject({ active: false, entryCount: 2, responseCount: 2, failureCount: 0 })
    expect(result.authProfile).toMatchObject({ name: "uber", slotCount: 4 })
    const artifact = await fs.readFile(outputPath, "utf8")
    expect(artifact).toContain("${BC_SECRET_1}")
    expect(artifact).not.toContain("access-token")
    expect(artifact).not.toContain("cookie-value")
    expect(artifact).not.toContain("refresh-value")
    expect(artifact).not.toContain("/api/ignored")
    expect(artifact).toContain("access_token=${BC_SECRET_2}")
  })

  it("preserves stable refs when a later capture refreshes values", async () => {
    const directory = await temporaryDirectory()
    const page = new FakePage()
    const recorder = new Recorder({ authProfileBaseDir: directory })

    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({ requestHeaders: [{ name: "Authorization", value: "Bearer old-token" }] })
    await Effect.runPromise(recorder.stop({ secrets: "uber" }))

    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({ requestHeaders: [{ name: "Authorization", value: "Bearer new-token" }] })
    const refreshed = await Effect.runPromise(recorder.stop({ secrets: "uber" }))
    const profile = await Effect.runPromise(AuthProfile.read("uber", { baseDir: directory }))

    expect(refreshed.updatedSecretRefs).toContain("BC_SECRET_1")
    expect(profile.slots).toEqual([expect.objectContaining({ ref: "BC_SECRET_1", value: "new-token" })])
  })

  it("reports body truncation and request failures", async () => {
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page, { maxBodyBytes: 4 }))
    page.exchange({ responseBody: Buffer.from("123456789"), responseHeaders: [{ name: "Content-Type", value: "text/plain" }] })
    page.failedExchange("https://example.com/failure")

    const result = await Effect.runPromise(recorder.stop())
    expect(result).toMatchObject({ entryCount: 2, responseCount: 1, failureCount: 1, truncatedBodyCount: 1, capturedBodyBytes: 0 })
  })

  it("bounds aggregate captured body bytes", async () => {
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page, { maxBodyBytes: 10, maxTotalBodyBytes: 6 }))
    page.exchange({ responseBody: Buffer.from("1234"), responseHeaders: [{ name: "Content-Type", value: "text/plain" }] })
    page.exchange({ responseBody: Buffer.from("5678"), responseHeaders: [{ name: "Content-Type", value: "text/plain" }] })
    page.exchange({ responseBody: Buffer.from("9abc"), responseHeaders: [{ name: "Content-Type", value: "text/plain" }] })

    const result = await Effect.runPromise(recorder.stop())
    expect(result).toMatchObject({ capturedBodyBytes: 6, truncatedBodyCount: 2 })
  })

  it("redacts artifact credentials even without a persisted profile", async () => {
    const directory = await temporaryDirectory()
    const outputPath = path.join(directory, "capture.har")
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({ requestHeaders: [{ name: "Authorization", value: "Bearer never-write-me" }] })

    const result = await Effect.runPromise(recorder.stop({ outputPath }))
    const artifact = await fs.readFile(outputPath, "utf8")
    expect(result.authProfile).toBeUndefined()
    expect(artifact).toContain("Bearer ${BC_SECRET_1}")
    expect(artifact).not.toContain("never-write-me")
  })

  it("omits truncated bodies instead of leaking unparseable credential fragments", async () => {
    const directory = await temporaryDirectory()
    const outputPath = path.join(directory, "capture.har")
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page, { maxBodyBytes: 24 }))
    page.exchange({
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      responseBody: Buffer.from(JSON.stringify({ accessToken: "never-write-this-token" })),
    })

    await Effect.runPromise(recorder.stop({ outputPath }))
    const artifact = await fs.readFile(outputPath, "utf8")
    expect(artifact).not.toContain("never-write")
    expect(artifact).toContain('"responseBodyTruncated": true')
  })

  it("does not commit a profile when required refresh credentials are absent", async () => {
    const directory = await temporaryDirectory()
    const page = new FakePage()
    const recorder = new Recorder({ authProfileBaseDir: directory })
    await Effect.runPromise(recorder.start(page as unknown as Page))

    await expect(Effect.runPromise(recorder.stop({ secrets: "missing", requireObservedSecrets: true }))).rejects.toMatchObject({
      _tag: "NetworkCapture.Error",
      reason: "persistence-failed",
    })
    await expect(fs.stat(path.join(directory, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await Effect.runPromise(recorder.cancel())
  })

  it("rejects unsafe limits for execute-sandbox callers", async () => {
    const recorder = new Recorder()
    await expect(Effect.runPromise(recorder.start(new FakePage() as unknown as Page, { maxEntries: 10_001 }))).rejects.toMatchObject({
      _tag: "NetworkCapture.Error",
      reason: "invalid-options",
    })
  })

  it("finalizes in-flight requests when the session page changes", async () => {
    const firstPage = new FakePage()
    const secondPage = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(firstPage as unknown as Page))
    firstPage.requestOnly("https://example.com/in-flight")
    recorder.bindPage(secondPage as unknown as Page)

    const result = await Effect.runPromise(recorder.stop())
    expect(result).toMatchObject({ entryCount: 1, failureCount: 1 })
  })

  it("bounds finalization time for a response body that never settles", async () => {
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.hangingExchange()

    const startedAt = Date.now()
    const result = await Effect.runPromise(recorder.stop())
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(result).toMatchObject({ entryCount: 1, truncatedBodyCount: 1 })
  })

  it("does not materialize response bodies without a declared bound", async () => {
    const page = new FakePage()
    const recorder = new Recorder()
    let bodyReads = 0
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.unknownLengthExchange(() => {
      bodyReads += 1
    })

    const result = await Effect.runPromise(recorder.stop())
    expect(bodyReads).toBe(0)
    expect(result).toMatchObject({ entryCount: 1, truncatedBodyCount: 1 })
  })

  it("redacts known values wherever a response echoes them", async () => {
    const directory = await temporaryDirectory()
    const outputPath = path.join(directory, "capture.har")
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({
      requestHeaders: [{ name: "Authorization", value: "Bearer echoed-token" }],
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      responseBody: Buffer.from(JSON.stringify({ value: "echoed-token" })),
    })

    await Effect.runPromise(recorder.stop({ outputPath }))
    const artifact = await fs.readFile(outputPath, "utf8")
    expect(artifact).not.toContain("echoed-token")
    expect(artifact).toContain('${BC_SECRET_1}')
  })

  it("redacts capture-derived values and secret-shaped execute output", async () => {
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({ requestHeaders: [{ name: "Authorization", value: "Bearer captured-token-value" }] })
    await recorder.settleForOutput()

    expect(recorder.redactText("token=captured-token-value")).toBe("token=${BC_SECRET_1}")
    expect(recorder.redactValue({ refreshToken: "returned-token", nested: { ok: true } })).toEqual({
      refreshToken: "[REDACTED]",
      nested: { ok: true },
    })
    expect(recorder.redactUrl("https://example.com/callback?code=callback-secret")).not.toContain("callback-secret")
    await Effect.runPromise(recorder.cancel())
  })

  it("fails execute output closed while a matching request is still pending", async () => {
    const page = new FakePage()
    const recorder = new Recorder({ outputSettleTimeoutMs: 10 })
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.requestOnly("https://example.com/pending")

    await recorder.settleForOutput()
    expect(recorder.redactText("possibly sensitive output")).toBe("[REDACTED: network capture finalization pending]")
    expect(recorder.redactValue({ ok: true })).toBe("[REDACTED: network capture finalization pending]")
    await Effect.runPromise(recorder.cancel())
  })

  it("redacts short typed values from execute output after capture", async () => {
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({ requestHeaders: [{ name: "Cookie", value: "count=1" }] })
    await recorder.settleForOutput()

    expect(recorder.redactValue(1)).toBe("${BC_SECRET_1}")
    await Effect.runPromise(recorder.cancel())
  })

  it("leaves an existing artifact untouched when profile publication fails", async () => {
    const directory = await temporaryDirectory()
    const outputPath = path.join(directory, "capture.har")
    await fs.writeFile(outputPath, "existing artifact")
    const page = new FakePage()
    const recorder = new Recorder({ authProfileBaseDir: directory })
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({ requestHeaders: [{ name: "Authorization", value: "Bearer captured-token-value" }] })

    await expect(Effect.runPromise(recorder.stop({ outputPath, secrets: "../invalid" }))).rejects.toMatchObject({
      _tag: "NetworkCapture.Error",
      reason: "persistence-failed",
    })
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("existing artifact")
    await Effect.runPromise(recorder.cancel())
  })

  it("redacts redirect URLs and omits opaque binary bodies", async () => {
    const directory = await temporaryDirectory()
    const outputPath = path.join(directory, "capture.har")
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({
      redirectedFrom: "https://example.com/callback?code=redirect-secret",
      responseHeaders: [
        { name: "Location", value: "https://example.com/next?access_token=location-secret" },
        { name: "Content-Type", value: "application/octet-stream" },
      ],
      responseBody: Buffer.from("binary-secret-value"),
    })

    const result = await Effect.runPromise(recorder.stop({ outputPath }))
    const artifact = await fs.readFile(outputPath, "utf8")
    expect(result.truncatedBodyCount).toBe(1)
    expect(artifact).not.toContain("redirect-secret")
    expect(artifact).not.toContain("location-secret")
    expect(artifact).not.toContain(Buffer.from("binary-secret-value").toString("base64"))
  })

  it("does not replace unrelated short JSON scalars that equal cookie values", async () => {
    const directory = await temporaryDirectory()
    const outputPath = path.join(directory, "capture.har")
    const page = new FakePage()
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page as unknown as Page))
    page.exchange({
      requestHeaders: [{ name: "Cookie", value: "count=1; theme=dark" }],
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      responseBody: Buffer.from(JSON.stringify({ count: 1, mode: "dark" })),
    })

    await Effect.runPromise(recorder.stop({ outputPath }))
    const artifact = await fs.readFile(outputPath, "utf8")
    expect(artifact).toContain('\\"count\\":1')
    expect(artifact).toContain('\\"mode\\":\\"dark\\"')
  })
})

class FakePage extends EventEmitter {
  isClosed(): boolean {
    return false
  }

  exchange(options: {
    readonly url?: string
    readonly requestHeaders?: readonly Header[]
    readonly responseHeaders?: readonly Header[]
    readonly responseBody?: Buffer
    readonly redirectedFrom?: string
  } = {}): void {
    const request = fakeRequest({
      ...(options.url ? { url: options.url } : {}),
      ...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
      ...(options.redirectedFrom ? { redirectedFrom: options.redirectedFrom } : {}),
    })
    const response = fakeResponse(request, options.responseHeaders, options.responseBody)
    this.emit("request", request)
    this.emit("response", response)
    this.emit("requestfinished", request)
  }

  failedExchange(url: string): void {
    const request = fakeRequest({ url, failure: "net::ERR_FAILED" })
    this.emit("request", request)
    this.emit("requestfailed", request)
  }

  requestOnly(url: string): void {
    this.emit("request", fakeRequest({ url }))
  }

  hangingExchange(): void {
    const request = fakeRequest({})
    const response = {
      ...fakeResponse(request, [{ name: "Content-Type", value: "application/json" }]),
      body: () => new Promise<Buffer>(() => {}),
    } as unknown as Response
    this.emit("request", request)
    this.emit("response", response)
    this.emit("requestfinished", request)
  }

  unknownLengthExchange(onBody: () => void): void {
    const request = fakeRequest({})
    const response = {
      request: () => request,
      status: () => 200,
      statusText: () => "OK",
      headersArray: async () => [{ name: "Content-Type", value: "application/json" }],
      body: async () => {
        onBody()
        return Buffer.from('{"token":"never-read"}')
      },
    } as unknown as Response
    this.emit("request", request)
    this.emit("response", response)
    this.emit("requestfinished", request)
  }
}

type Header = { readonly name: string; readonly value: string }

function fakeRequest(options: { readonly url?: string; readonly headers?: readonly Header[]; readonly failure?: string; readonly redirectedFrom?: string }): Request {
  const request = {
    method: () => "GET",
    url: () => options.url ?? "https://example.com/api/test",
    headersArray: async () => [...(options.headers ?? [])],
    postDataBuffer: () => null,
    resourceType: () => "fetch",
    redirectedFrom: () => options.redirectedFrom ? { url: () => options.redirectedFrom } : null,
    failure: () => options.failure ? { errorText: options.failure } : null,
  }
  return request as unknown as Request
}

function fakeResponse(request: Request, headers: readonly Header[] = [], body: Uint8Array = Buffer.from("ok")): Response {
  const responseHeaders = [...headers]
  if (!responseHeaders.some((header) => header.name.toLowerCase() === "content-length")) {
    responseHeaders.push({ name: "Content-Length", value: String(body.byteLength) })
  }
  return {
    request: () => request,
    status: () => 200,
    statusText: () => "OK",
    headersArray: async () => responseHeaders,
    body: async () => Buffer.from(body),
  } as unknown as Response
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-network-"))
  temporaryDirectories.push(directory)
  return directory
}
