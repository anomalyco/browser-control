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
      sessions: new BrowserControlSessions(`http://127.0.0.1:${port}`),
    })

    try {
      await expect(postJson(port, "/cli/session/new", { id: "alpha", readOnly: "yes" })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid session new request") },
      })
      await expect(postJson(port, "/recording/start", { outputPath: "/tmp/demo.webm", audio: "yes" })).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Invalid recording start request") },
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
