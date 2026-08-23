import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as RelayClient from "../src/relay-client.ts"
import {
  ensureExtensionConnected,
  ensureRelay,
  managedRelayEntrypoint,
  managedRelayLaunch,
  relayBuildProblem,
  statusCollections,
  stoppedRelayStatus,
} from "../src/relay-lifecycle.ts"
import { sourceBuildIdForFiles } from "../src/version.ts"

const version = { version: "0.1.0", buildId: "build-current" }

function relay(options: {
  readonly version: Effect.Effect<typeof version, RelayClient.RelayClientError>
  readonly extensionStatus?: RelayClient.Interface["extensionStatus"]
  readonly shutdown?: RelayClient.Interface["shutdown"]
}): RelayClient.Interface {
  return {
    endpoint: "http://127.0.0.1:19989",
    version: options.version,
    shutdown: options.shutdown ?? (() => Effect.die("unexpected relay shutdown")),
    extensionStatus: options.extensionStatus ?? Effect.succeed({ connected: true, version: "0.0.11", activeTargets: 0 }),
  } as RelayClient.Interface
}

function starting(): RelayClient.RelayRejected {
  return new RelayClient.RelayRejected({
    message: "Browser Control relay is starting",
    status: 503,
    path: "/version",
    code: "relay-starting",
  })
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

  it("allows a cold managed relay more than two seconds of readiness probes", async () => {
    let attempts = 0
    const result = await Effect.runPromise(ensureRelay({
      relay: relay({
        version: Effect.suspend(() => ++attempts >= 42 ? Effect.succeed(version) : Effect.fail(unreachable())),
      }),
      buildId: "build-current",
      start: Effect.void,
      retryDelayMs: 0,
    }))

    expect(result.started).toBe(true)
    expect(attempts).toBe(42)
  })

  it("waits for a bound relay to finish restoring without starting another process", async () => {
    let attempts = 0
    let starts = 0
    const result = await Effect.runPromise(ensureRelay({
      relay: relay({
        version: Effect.suspend(() => ++attempts >= 3 ? Effect.succeed(version) : Effect.fail(starting())),
      }),
      buildId: "build-current",
      start: Effect.sync(() => { starts++ }),
      retryTimes: 3,
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version, started: false })
    expect(starts).toBe(0)
  })

  it("reports a stale relay that has no safe process identity", async () => {
    const result = await Effect.runPromise(ensureRelay({
      relay: relay({ version: Effect.succeed({ ...version, buildId: "build-old" }) }),
      buildId: "build-current",
      start: Effect.void,
    }))

    expect(result.buildProblem).toContain("does not match CLI build")
  })

  it("replaces a stale relay with the current build", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z" }
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true }
    let running: typeof stale | typeof current | undefined = stale
    let stops = 0
    let starts = 0
    const client = relay({
      version: Effect.suspend(() => running ? Effect.succeed(running) : Effect.fail(unreachable())),
      shutdown: () => Effect.sync(() => {
        stops++
        running = undefined
        return { stopping: true as const }
      }),
    })

    const result = await Effect.runPromise(ensureRelay({
      relay: client,
      buildId: current.buildId,
      start: Effect.sync(() => {
        starts++
        running = current
      }),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version: current, started: true })
    expect(stops).toBe(1)
    expect(starts).toBe(1)
  })

  it("does not stop a relay instance that changed after the stale probe", async () => {
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true }
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", pid: 123, managed: true }
    let probes = 0
    let stops = 0
    const client = relay({
      version: Effect.sync(() => ++probes === 1 ? stale : current),
      shutdown: () => Effect.sync(() => {
        stops++
        return { stopping: true as const }
      }),
    })

    const result = await Effect.runPromise(ensureRelay({
      relay: client,
      buildId: current.buildId,
      start: Effect.die("should not start"),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version: current, started: false })
    expect(stops).toBe(0)
  })

  it("observes a concurrent replacement when stale shutdown loses the race", async () => {
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true }
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", pid: 456, managed: true }
    let probes = 0
    const client = relay({
      version: Effect.sync(() => ++probes <= 2 ? stale : current),
      shutdown: () => Effect.fail(new RelayClient.RelayRejected({
        message: "Relay shutdown does not match the active managed instance",
        status: 409,
        path: "/shutdown",
        code: "invalid-request",
      })),
    })

    const result = await Effect.runPromise(ensureRelay({
      relay: client,
      buildId: current.buildId,
      start: Effect.die("should not start"),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version: current, started: false })
  })

  it("does not replace a managed relay with an older CLI build", async () => {
    const newer = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "newer", pid: 456, managed: true }
    let shutdowns = 0
    const client = relay({
      version: Effect.succeed(newer),
      shutdown: () => Effect.sync(() => {
        shutdowns++
        return { stopping: true as const }
      }),
    })

    const result = await Effect.runPromise(ensureRelay({
      relay: client,
      buildId: "2026-08-03T12:00:00.000Z",
      start: Effect.die("should not start"),
      retryDelayMs: 0,
    }))

    expect(result.buildProblem).toContain("does not match CLI build")
    expect(shutdowns).toBe(0)
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

  it("allows a cold extension more than two seconds of reconnect probes", async () => {
    let attempts = 0
    const client = relay({
      version: Effect.succeed(version),
      extensionStatus: Effect.sync(() => ({ connected: ++attempts >= 42, version: "0.0.11", activeTargets: 0 })),
    })

    const status = await Effect.runPromise(ensureExtensionConnected({
      relay: client,
      waitForReconnect: true,
      retryDelayMs: 0,
    }))

    expect(status.connected).toBe(true)
    expect(attempts).toBe(42)
  })

  it("fails an incompatible extension protocol without retrying", async () => {
    let attempts = 0
    const client = relay({
      version: Effect.succeed(version),
      extensionStatus: Effect.sync(() => {
        attempts++
        return {
          connected: false,
          version: "1.0.0",
          protocolVersion: 2,
          protocolCompatible: false,
          activeTargets: 0,
        }
      }),
    })

    await expect(Effect.runPromise(ensureExtensionConnected({
      relay: client,
      waitForReconnect: true,
      retryDelayMs: 0,
    }))).rejects.toThrow("protocol 2 is incompatible")
    expect(attempts).toBe(1)
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
    expect(relayBuildProblem({ ...version, buildId: "build-old" }, "dev")).toContain("does not match CLI build")
  })

  it("starts a managed relay through the CLI entrypoint from MCP builds and source", () => {
    expect(managedRelayEntrypoint("/package/dist/mcp.js")).toBe("/package/dist/cli.js")
    expect(managedRelayEntrypoint("/package/src/mcp-main.ts")).toBe("/package/src/cli.ts")
    expect(managedRelayEntrypoint("/package/dist/index.js")).toBe("/package/dist/cli.js")
    expect(managedRelayEntrypoint("/package/src/browser-control-client.ts")).toBe("/package/src/cli.ts")
    expect(managedRelayEntrypoint("/package/dist/cli.js")).toBe("/package/dist/cli.js")
    expect(managedRelayEntrypoint("/package/bin/browser-control-mcp")).toBe("/package/bin/browser-control")
  })

  it("can launch the Node relay independently of a Bun consumer runtime", () => {
    expect(managedRelayLaunch("/package/dist/index.js", "node", [])).toEqual({
      executable: "node",
      args: ["/package/dist/cli.js", "serve"],
    })
  })

  it("gives source processes a deterministic content-sensitive build id", () => {
    const files = [
      { name: "src/relay.ts", content: "relay" },
      { name: "src/cli.ts", content: "cli" },
    ]
    expect(sourceBuildIdForFiles(files)).toBe(sourceBuildIdForFiles([...files].reverse()))
    expect(sourceBuildIdForFiles(files)).not.toBe(sourceBuildIdForFiles([
      files[0]!,
      { name: "src/cli.ts", content: "changed" },
    ]))
  })
})
