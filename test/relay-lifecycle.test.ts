import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as RelayClient from "../src/relay-client.ts"
import {
  ensureExtensionConnected,
  ensureRelay,
  managedRelayEntrypoint,
  relayBuildProblem,
  statusCollections,
  stoppedRelayStatus,
} from "../src/relay-lifecycle.ts"

const version = { version: "0.1.0", buildId: "build-current" }

function relay(options: {
  readonly version: Effect.Effect<typeof version, RelayClient.RelayUnreachable>
  readonly extensionStatus?: RelayClient.Interface["extensionStatus"]
}): RelayClient.Interface {
  return {
    endpoint: "http://127.0.0.1:19989",
    version: options.version,
    extensionStatus: options.extensionStatus ?? Effect.succeed({ connected: true, version: "0.0.11", activeTargets: 0 }),
  } as RelayClient.Interface
}

function unreachable(): RelayClient.RelayUnreachable {
  return new RelayClient.RelayUnreachable({
    message: "unreachable",
    endpoint: "http://127.0.0.1:19989",
    path: "/version",
    cause: new Error("connection refused"),
  })
}

describe("relay lifecycle", () => {
  it("reuses a matching relay without starting another process", async () => {
    let starts = 0
    const result = await Effect.runPromise(ensureRelay({
      relay: relay({ version: Effect.succeed(version) }),
      buildId: "build-current",
      start: Effect.sync(() => { starts++ }),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version, started: false })
    expect(starts).toBe(0)
  })

  it("starts and waits for an absent relay", async () => {
    let running = false
    let starts = 0
    const client = relay({
      version: Effect.suspend(() => running ? Effect.succeed(version) : Effect.fail(unreachable())),
    })
    const result = await Effect.runPromise(ensureRelay({
      relay: client,
      buildId: "build-current",
      start: Effect.sync(() => {
        starts++
        running = true
      }),
      retryTimes: 1,
      retryDelayMs: 0,
    }))

    expect(result.started).toBe(true)
    expect(starts).toBe(1)
  })

  it("reports a stale relay instead of silently using it", async () => {
    const result = await Effect.runPromise(ensureRelay({
      relay: relay({ version: Effect.succeed({ ...version, buildId: "build-old" }) }),
      buildId: "build-current",
      start: Effect.void,
    }))

    expect(result.buildProblem).toContain("does not match CLI build")
  })

  it("waits for the extension to reconnect after relay startup", async () => {
    let attempts = 0
    const client = relay({
      version: Effect.succeed(version),
      extensionStatus: Effect.sync(() => ({ connected: ++attempts >= 2, version: "0.0.11", activeTargets: 0 })),
    })

    const status = await Effect.runPromise(ensureExtensionConnected({
      relay: client,
      waitForReconnect: true,
      retryTimes: 2,
      retryDelayMs: 0,
    }))
    expect(status.connected).toBe(true)
    expect(attempts).toBe(2)
  })

  it("formats stopped and consolidated status without extra relay requests", () => {
    expect(stoppedRelayStatus("http://127.0.0.1:19989")).toEqual({
      endpoint: "http://127.0.0.1:19989",
      relay: { running: false },
      extension: null,
      sessions: [],
      targets: [],
    })
    expect(statusCollections({
      connected: true,
      version: "0.0.11",
      activeTargets: 0,
      sessions: [],
      targets: [],
    })).toEqual({ sessions: [], targets: [] })
    expect(relayBuildProblem(version, "build-current")).toBeUndefined()
    expect(relayBuildProblem({ ...version, buildId: "build-old" }, "dev")).toBeUndefined()
  })

  it("starts a managed relay through the CLI entrypoint from MCP builds and source", () => {
    expect(managedRelayEntrypoint("/package/dist/mcp.js")).toBe("/package/dist/cli.js")
    expect(managedRelayEntrypoint("/package/src/mcp-main.ts")).toBe("/package/src/cli.ts")
    expect(managedRelayEntrypoint("/package/dist/cli.js")).toBe("/package/dist/cli.js")
  })
})
