import { describe, expect, it, vi } from "vitest"
import { Effect, Layer, Queue, Sink, Stdio, Stream } from "effect"
import { McpSchema, McpServer } from "effect/unstable/ai"
import { mcpErrorMessage, mcpServerLayer, mcpToolRequiresRelayCompatibility, mcpToolsLayer, toolResultForValue } from "../src/mcp.ts"
import * as RelayClient from "../src/relay-client.ts"

vi.mock("../src/version.ts", () => ({ browserControlVersion: "1.0.0", browserControlBuildId: "2026-08-31T12:00:00.000Z" }))

describe("MCP protocol negotiation", () => {
  it.each(["2025-06-18", "2025-11-25", "2025-03-26", "2024-11-05", "2024-10-07"])(
    "negotiates an initialize offer for %s without a relay",
    async (protocolVersion) => {
      const response = await Effect.runPromise(Effect.gen(function* () {
        const stdin = yield* Queue.unbounded<Uint8Array>()
        const stdout = yield* Queue.unbounded<string | Uint8Array>()
        yield* Layer.launch(mcpServerLayer.pipe(Layer.provide(Stdio.layerTest({
          stdin: Stream.fromQueue(stdin),
          stdout: () => Sink.forEach((chunk) => Queue.offer(stdout, chunk)),
        })))).pipe(Effect.forkScoped)
        yield* Queue.offer(stdin, new TextEncoder().encode(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion, capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } },
        })}\n`))
        const decoder = new TextDecoder()
        let output = ""
        while (!output.includes("\n")) {
          const chunk = yield* Queue.take(stdout)
          output += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        }
        return JSON.parse(output.slice(0, output.indexOf("\n")))
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")))
      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: protocolVersion === "2024-10-07" ? "2025-06-18" : protocolVersion,
          serverInfo: { name: "browser-control" },
        },
      })
      expect(response).not.toHaveProperty("error")
    },
  )
})

describe("MCP tool results", () => {
  it("preserves selector shapes, permissive optional strings, and public parse failures", async () => {
    const session = { id: "chosen", createdAt: "2026-07-01", updatedAt: "2026-07-01", connected: true, pageUrl: null, stateKeys: [] }
    const execute = vi.fn<RelayClient.Interface["execute"]>(() => Effect.succeed({ session, text: "ok", isError: false, logs: [] }))
    const adopt = vi.fn<RelayClient.Interface["sessionAdopt"]>(() => Effect.succeed({ session, adoptedUrl: "https://example.com/", adoptedTargetId: "target-7" }))
    await Effect.runPromise(Effect.gen(function* () {
      const server = yield* McpServer.McpServer.make
      yield* Layer.build(mcpToolsLayer.pipe(
        Layer.provide(Layer.succeed(McpServer.McpServer, server)),
        Layer.provide(Layer.mock(RelayClient.Service, {
          endpoint: "http://127.0.0.1:19989",
          version: Effect.succeed({ version: "1.0.0", buildId: "2026-08-31T12:00:00.000Z" }),
          extensionStatus: Effect.succeed({ connected: true, version: "9.4.2", activeTargets: 1 }),
          execute,
          sessionAdopt: adopt,
        })),
      ))
      const initializePayload = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } }
      const client = McpSchema.McpServerClient.of({
        clientId: 1, protocolVersion: "2025-06-18", clientCapabilities: {}, clientInfo: initializePayload.clientInfo,
        initializePayload, getClient: Effect.die("unexpected client callback"),
      })
      yield* Effect.gen(function* () {
        for (const [args, forwarded] of [
          [{ session: "chosen", targetUrl: "example.com" }, { createIfMissing: false, targetSelection: { urlIncludes: "example.com" } }],
          [{ targetIndex: 0 }, { createIfMissing: true, targetSelection: { index: 0 } }],
          [{ session: "", targetUrl: "", targetIndex: 0 }, { createIfMissing: true, targetSelection: { index: 0 } }],
          [{}, { createIfMissing: true }],
          [{ session: "", targetUrl: "" }, { createIfMissing: true }],
          [{ session: 42, targetUrl: false }, { createIfMissing: true }],
        ] as const) {
          const result = yield* server.callTool({ name: "execute", arguments: { code: "1", ...args } })
          expect(result.isError).toBe(false)
          expect(execute.mock.lastCall?.[0]).toStrictEqual({ sessionId: "chosen", code: "1", ...forwarded })
        }
        for (const [args, forwarded] of [
          [{ targetUrl: "example.com" }, { createIfMissing: true, targetSelection: { urlIncludes: "example.com" } }],
          [{ session: "chosen", targetIndex: 0 }, { createIfMissing: false, targetSelection: { index: 0 } }],
          [{ session: "", targetUrl: "", targetIndex: 0 }, { createIfMissing: true, targetSelection: { index: 0 } }],
          [{ session: 42, targetUrl: false, targetIndex: 0 }, { createIfMissing: true, targetSelection: { index: 0 } }],
        ] as const) {
          const result = yield* server.callTool({ name: "session_adopt", arguments: args })
          expect(result.isError).toBe(false)
          expect(adopt.mock.lastCall?.[0]).toStrictEqual({ sessionId: "chosen", ...forwarded })
        }
        execute.mockClear()
        adopt.mockClear()
        for (const name of ["execute", "session_adopt"]) {
          for (const args of [{ targetUrl: "example", targetIndex: 0 }, ...[-1, 1.5, "0", null].map((targetIndex) => ({ targetIndex }))]) {
            const result = yield* server.callTool({ name, arguments: { code: "1", ...args } })
            // Effect.try currently hides the inner parser message at the MCP boundary.
            expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "An error occurred in Effect.try" }] })
          }
        }
        for (const args of [{}, { targetUrl: "" }, { targetUrl: 42 }]) {
          const result = yield* server.callTool({ name: "session_adopt", arguments: args })
          expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "An error occurred in Effect.try" }] })
        }
        const result = yield* server.callTool({ name: "execute", arguments: { code: "" } })
        expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "An error occurred in Effect.try" }] })
        expect(execute).not.toHaveBeenCalled()
        expect(adopt).not.toHaveBeenCalled()
      }).pipe(Effect.provideService(McpSchema.McpServerClient, client))
    }).pipe(Effect.scoped))
  })

  it("starts against a mismatched relay without replacing it and retains observational tools", async () => {
    let shutdowns = 0
    const result = await Effect.runPromise(Effect.gen(function* () {
      const server = yield* McpServer.McpServer.make
      yield* Layer.build(mcpToolsLayer.pipe(
        Layer.provide(Layer.succeed(McpServer.McpServer, server)),
        Layer.provide(Layer.mock(RelayClient.Service, {
          endpoint: "http://127.0.0.1:19989",
          version: Effect.succeed({ version: "1.0.0", buildId: "2026-08-01T00:00:00.000Z", instanceId: "managed-old", managed: true, shutdownProtocol: 2 as const }),
          shutdown: () => Effect.sync(() => { shutdowns++; return { stopping: true as const } }),
          extensionStatus: Effect.succeed({ connected: false, version: null, activeTargets: 0 }),
          sessions: Effect.succeed([]),
        })),
      ))
      const initializePayload = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } }
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: initializePayload.clientInfo,
        initializePayload,
        getClient: Effect.die("unexpected client callback"),
      })
      return yield* Effect.all({
        status: server.callTool({ name: "status", arguments: {} }),
        sessions: server.callTool({ name: "session_list", arguments: {} }),
        current: server.callTool({ name: "session_current", arguments: {} }),
        execute: server.callTool({ name: "execute", arguments: { code: "page.url()" } }),
      }).pipe(Effect.provideService(McpSchema.McpServerClient, client))
    }).pipe(Effect.scoped))
    expect(shutdowns).toBe(0)
    expect(result.status.isError).toBe(false)
    expect(result.status.structuredContent).toMatchObject({ buildProblem: expect.stringContaining("browser-control relay restart") })
    expect(result.sessions.isError).toBe(false)
    expect(result.current.isError).toBe(false)
    expect(result.execute).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("browser-control relay restart") }] })
  })

  it("rechecks relay compatibility for operational tools", () => {
    expect(mcpToolRequiresRelayCompatibility("execute")).toBe(true)
    expect(mcpToolRequiresRelayCompatibility("network_start")).toBe(true)
    expect(mcpToolRequiresRelayCompatibility("secrets_run")).toBe(true)
    expect(mcpToolRequiresRelayCompatibility("status")).toBe(false)
    expect(mcpToolRequiresRelayCompatibility("session_list")).toBe(false)
    expect(mcpToolRequiresRelayCompatibility("network_status")).toBe(false)
    expect(mcpToolRequiresRelayCompatibility("secrets_status")).toBe(false)
    expect(mcpToolRequiresRelayCompatibility("session_current")).toBe(false)
    expect(mcpToolRequiresRelayCompatibility("skill")).toBe(false)
  })

  it("advertises session deletion as idempotent in registered tool metadata", async () => {
    const tool = await Effect.runPromise(Effect.gen(function* () {
      const server = yield* McpServer.McpServer.make
      yield* Layer.build(mcpToolsLayer.pipe(
        Layer.provide(Layer.succeed(McpServer.McpServer, server)),
        Layer.provide(Layer.mock(RelayClient.Service, {
          endpoint: "http://127.0.0.1:19989",
          version: Effect.succeed({ version: "1.0.0", buildId: "2026-08-31T12:00:00.000Z" }),
        })),
      ))
      return server.tools.find(({ tool }) => tool.name === "session_delete")?.tool
    }).pipe(Effect.scoped))
    expect(tool).toMatchObject({
      name: "session_delete",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    })
  })

  it("marks execute script failures as failed MCP tool calls", () => {
    const result = toolResultForValue({
      text: "locator.click: Timeout 30000ms exceeded",
      isError: true,
      logs: [],
      session: { id: "mcp-test" },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "locator.click: Timeout 30000ms exceeded",
    })
    expect(result.structuredContent).toMatchObject({ isError: true })
  })

  it("omits structured content for primitive tool results", () => {
    const result = toolResultForValue("# Browser Control\n\nSkill instructions")

    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ type: "text", text: "# Browser Control\n\nSkill instructions" })
    expect(result.structuredContent).toBeUndefined()
  })

  it("adds session recovery guidance at the MCP boundary", () => {
    expect(mcpErrorMessage("execute", "Session not found: stale")).toContain("omit the explicit session id")
    expect(mcpErrorMessage("session_use", "Session not found: stale")).toContain("Create it with session_new first")
    expect(mcpErrorMessage("execute", "Extension disconnected")).toBe("Extension disconnected")
  })

  it("attaches explicit execute images without duplicating base64 in metadata", () => {
    const result = toolResultForValue({
      text: "Image (image/png, 4 bytes)",
      media: [
        { type: "image", mimeType: "image/png", data: Buffer.from([1, 2]).toString("base64"), size: 2 },
        { type: "image", mimeType: "image/png", data: Buffer.from([3, 4]).toString("base64"), size: 2 },
      ],
      isError: false,
      logs: [],
      session: { id: "mcp-test" },
    })

    expect(result.content).toHaveLength(3)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(Array.from(result.content[1]?.type === "image" ? result.content[1].data : [])).toEqual([1, 2])
    expect(Array.from(result.content[2]?.type === "image" ? result.content[2].data : [])).toEqual([3, 4])
    expect(result.structuredContent).not.toHaveProperty("media")
  })
})
