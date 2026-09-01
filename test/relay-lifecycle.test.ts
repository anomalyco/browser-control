import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as RelayClient from "../src/relay-client.ts"
import {
  ensureExtensionConnected,
  ensureRelay,
  managedRelayEntrypoint,
  managedRelayLaunch,
  relayBuildProblem,
  restartRelay,
  startManagedRelay,
  statusCollections,
  stoppedRelayStatus,
} from "../src/relay-lifecycle.ts"
import { sourceBuildIdForFiles } from "../src/version.ts"
import type { RelayShutdownRequest, RelayVersion } from "../src/relay-schema.ts"

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }))

const version = { version: "0.1.0", buildId: "build-current" }

function relay(options: {
  readonly version: Effect.Effect<RelayVersion, RelayClient.RelayClientError>
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

  it("leaves an older managed relay untouched during ordinary readiness", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z" }
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true, shutdownProtocol: 2 as const }
    let stops = 0
    let starts = 0
    const client = relay({
      version: Effect.succeed(stale),
      shutdown: () => Effect.sync(() => { stops++; return { stopping: true as const } }),
    })

    const result = await Effect.runPromise(ensureRelay({
      relay: client,
      buildId: current.buildId,
      start: Effect.sync(() => { starts++ }),
      retryDelayMs: 0,
    }))

    expect(result).toMatchObject({ version: stale, started: false })
    expect(result.buildProblem).toContain("browser-control relay restart")
    expect(stops).toBe(0)
    expect(starts).toBe(0)
  })

  it("explicitly replaces an exact older managed instance with attributed shutdown", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", managed: true }
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true, shutdownProtocol: 2 as const }
    let running: RelayVersion | undefined = stale
    const shutdowns: RelayShutdownRequest[] = []
    const client = relay({
      version: Effect.suspend(() => running ? Effect.succeed(running) : Effect.fail(unreachable())),
      shutdown: (request) => Effect.sync(() => {
        shutdowns.push(request)
        running = undefined
        return { stopping: true as const }
      }),
    })

    const result = await Effect.runPromise(restartRelay({
      relay: client,
      buildId: current.buildId,
      clientKind: "cli",
      start: Effect.sync(() => { running = current }),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version: current, started: true, waitForReconnect: true })
    expect(shutdowns).toEqual([{
      instanceId: "stale",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      reason: "explicit-restart",
      client: { kind: "cli", instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/), buildId: current.buildId },
    }])
  })

  it("does not stop a relay instance that changed after the stale probe", async () => {
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true, shutdownProtocol: 2 as const }
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", pid: 123, managed: true }
    let probes = 0
    let stops = 0
    const client = relay({
      version: Effect.sync(() => ++probes === 1 ? stale : current),
      shutdown: () => Effect.sync(() => { stops++; return { stopping: true as const } }),
    })

    const result = await Effect.runPromise(restartRelay({
      relay: client,
      buildId: current.buildId,
      start: Effect.die("should not start"),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version: current, started: false, waitForReconnect: true })
    expect(stops).toBe(0)
  })

  it("observes a concurrent replacement when stale shutdown loses the race", async () => {
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", pid: 123, managed: true, shutdownProtocol: 2 as const }
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

    const result = await Effect.runPromise(restartRelay({
      relay: client,
      buildId: current.buildId,
      start: Effect.die("should not start"),
      retryDelayMs: 0,
    }))

    expect(result).toEqual({ version: current, started: false, waitForReconnect: true })
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

    expect(result.buildProblem).toContain("refresh or restart this CLI or MCP client")
    expect(shutdowns).toBe(0)
  })

  it.each([
    { name: "newer", buildId: "2026-08-05T12:00:00.000Z", managed: true, shutdownProtocol: 2, message: "Refusing to downgrade" },
    { name: "source", buildId: "source-abc", managed: true, shutdownProtocol: 2, message: "source or unorderable" },
    { name: "foreground", buildId: "2026-08-03T12:00:00.000Z", managed: false, shutdownProtocol: 2, message: "foreground" },
    { name: "legacy", buildId: "2026-08-03T12:00:00.000Z", managed: true, shutdownProtocol: undefined, message: "Stop it manually once" },
  ] as const)("refuses explicit replacement of a $name relay", async ({ name, buildId, managed, shutdownProtocol, message }) => {
    await expect(Effect.runPromise(restartRelay({
      relay: relay({ version: Effect.succeed({ ...version, buildId, instanceId: name, managed, ...(shutdownProtocol ? { shutdownProtocol } : {}) }) }),
      buildId: "2026-08-04T12:00:00.000Z",
      start: Effect.die("should not start"),
    }))).rejects.toThrow(message)
  })

  it("refuses a source client without stopping the managed relay", async () => {
    await expect(Effect.runPromise(restartRelay({
      relay: relay({ version: Effect.succeed({ ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", managed: true, shutdownProtocol: 2 }) }),
      buildId: "source-current",
      start: Effect.die("should not start"),
    }))).rejects.toThrow("source or unorderable")
  })

  it("preserves relay-busy refusal instead of treating it as a concurrent replacement", async () => {
    const busy = new RelayClient.RelayRejected({ message: "Relay is busy", status: 409, path: "/shutdown", code: "relay-busy" })
    await expect(Effect.runPromise(restartRelay({
      relay: relay({
        version: Effect.succeed({ ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", managed: true, shutdownProtocol: 2 }),
        shutdown: () => Effect.fail(busy),
      }),
      buildId: "2026-08-04T12:00:00.000Z",
      start: Effect.die("should not start"),
    }))).rejects.toThrow("Relay is busy")
  })

  it("does not stop a competing replacement with the wrong build", async () => {
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", managed: true, shutdownProtocol: 2 as const }
    let probes = 0
    await expect(Effect.runPromise(restartRelay({
      relay: relay({ version: Effect.sync(() => ++probes === 1 ? stale : { ...stale, instanceId: "competitor", buildId: "2026-08-05T12:00:00.000Z" }) }),
      buildId: "2026-08-04T12:00:00.000Z",
      start: Effect.die("should not start"),
    }))).rejects.toThrow("competing relay was left untouched")
  })

  it("explicit restart starts an absent relay and verifies its identity and build", async () => {
    const current = { ...version, instanceId: "current", managed: true }
    let running = false
    const result = await Effect.runPromise(restartRelay({
      relay: relay({ version: Effect.suspend(() => running ? Effect.succeed(current) : Effect.fail(unreachable())) }),
      buildId: current.buildId,
      start: Effect.sync(() => { running = true }),
    }))
    expect(result).toEqual({ version: current, started: true, waitForReconnect: true })
  })

  it("checks the build of the process launched after shutdown without stopping it again", async () => {
    const stale = { ...version, buildId: "2026-08-03T12:00:00.000Z", instanceId: "stale", managed: true, shutdownProtocol: 2 as const }
    let running: RelayVersion | undefined = stale
    let shutdowns = 0
    await expect(Effect.runPromise(restartRelay({
      relay: relay({
        version: Effect.suspend(() => running ? Effect.succeed(running) : Effect.fail(unreachable())),
        shutdown: () => Effect.sync(() => { shutdowns++; running = undefined; return { stopping: true as const } }),
      }),
      buildId: "2026-08-04T12:00:00.000Z",
      start: Effect.sync(() => { running = { ...stale, instanceId: "wrong-artifact" } }),
      retryDelayMs: 0,
    }))).rejects.toThrow("competing relay was left untouched")
    expect(shutdowns).toBe(1)
  })

  it("waits for the acknowledged same-build instance to drain before starting its successor", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", managed: true, shutdownProtocol: 2 as const }
    let stopping = false
    let probes = 0
    let running: RelayVersion | undefined = current
    const result = await Effect.runPromise(restartRelay({
      relay: relay({
        version: Effect.suspend(() => {
          if (stopping && ++probes === 3) running = undefined
          return running ? Effect.succeed(running) : Effect.fail(unreachable())
        }),
        shutdown: () => Effect.sync(() => { stopping = true; return { stopping: true as const } }),
      }),
      buildId: current.buildId,
      start: Effect.sync(() => {
        expect(probes).toBe(3)
        expect(running).toBeUndefined()
        running = { ...current, instanceId: "successor" }
      }),
      retryDelayMs: 0,
    }))
    expect(result.version.instanceId).toBe("successor")
  })

  it("never launches a successor when the acknowledged relay does not finish draining", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", managed: true, shutdownProtocol: 2 as const }
    await expect(Effect.runPromise(restartRelay({
      relay: relay({ version: Effect.succeed(current), shutdown: () => Effect.succeed({ stopping: true }) }),
      buildId: current.buildId,
      start: Effect.die("should not start"),
      retryTimes: 1,
      retryDelayMs: 0,
    }))).rejects.toThrow("still draining")
  })

  it("requires a distinct successor identity even when the build matches", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", managed: true, shutdownProtocol: 2 as const }
    let running: RelayVersion | undefined = current
    await expect(Effect.runPromise(restartRelay({
      relay: relay({
        version: Effect.suspend(() => running ? Effect.succeed(running) : Effect.fail(unreachable())),
        shutdown: () => Effect.sync(() => { running = undefined; return { stopping: true as const } }),
      }),
      buildId: current.buildId,
      start: Effect.sync(() => { running = current }),
      retryDelayMs: 0,
    }))).rejects.toThrow("did not produce a new managed instance")
  })

  it("correlates the successor launch with the acknowledged shutdown request", async () => {
    const current = { ...version, buildId: "2026-08-04T12:00:00.000Z", instanceId: "current", managed: true, shutdownProtocol: 2 as const }
    let running: RelayVersion | undefined = current
    let requestId: string | undefined
    let probes = 0
    const spawns = vi.mocked(spawn).mock.calls.length
    await Effect.runPromise(restartRelay({
      relay: relay({
        version: Effect.suspend(() => {
          if (!running && ++probes > 1) running = { ...current, instanceId: "successor" }
          return running ? Effect.succeed(running) : Effect.fail(unreachable())
        }),
        shutdown: (request) => Effect.sync(() => { requestId = request.requestId; running = undefined; return { stopping: true as const } }),
      }),
      buildId: current.buildId,
      retryDelayMs: 0,
    }))
    expect(vi.mocked(spawn).mock.calls.length).toBe(spawns + 1)
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.BROWSER_CONTROL_RESTART_REQUEST_ID).toBe(requestId)
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
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
    expect(relayBuildProblem(
      { ...version, buildId: "2026-08-06T12:00:00.000Z" },
      "2026-08-05T12:00:00.000Z",
    )).toContain("refresh or restart this CLI or MCP client")
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

  it("pins the default CLI to the loaded module rather than a mutable global entrypoint", () => {
    const original = [...process.argv]
    try {
      process.argv[1] = "/new/global/browser-control-mcp"
      expect(managedRelayLaunch(undefined, "node", ["--import", "tsx"])).toEqual({
        executable: "node",
        args: ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "serve"],
      })
    } finally {
      process.argv.splice(0, process.argv.length, ...original)
    }
  })

  it("passes restart attribution only to the child and omits inherited attribution on autostart", async () => {
    vi.stubEnv("BROWSER_CONTROL_RESTART_REQUEST_ID", "inherited-request")
    try {
      await Effect.runPromise(startManagedRelay("/package/dist/cli.js", "node", [], { restartRequestId: "explicit-request" }))
      expect(spawn).toHaveBeenLastCalledWith("node", ["/package/dist/cli.js", "serve"], expect.objectContaining({
        env: expect.objectContaining({ BROWSER_CONTROL_MANAGED_RELAY: "1", BROWSER_CONTROL_RESTART_REQUEST_ID: "explicit-request" }),
      }))
      await Effect.runPromise(startManagedRelay("/package/dist/cli.js", "node", []))
      const env = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env
      expect(env).not.toHaveProperty("BROWSER_CONTROL_RESTART_REQUEST_ID")
      expect(process.env.BROWSER_CONTROL_RESTART_REQUEST_ID).toBe("inherited-request")
    } finally {
      vi.unstubAllEnvs()
    }
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
