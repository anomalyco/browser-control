import { Effect, Schedule, Schema } from "effect"
import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"
import * as RelayClient from "./relay-client.ts"
import type { ExtensionStatus, RelayVersion } from "./relay-schema.ts"
import { browserControlBuildId } from "./version.ts"

export type RelayReadiness = {
  readonly version: RelayVersion
  readonly started: boolean
  readonly buildProblem?: string
}

export type EnsureRelayOptions = {
  readonly relay: RelayClient.Interface
  readonly start?: Effect.Effect<void, Error>
  readonly buildId?: string
  readonly retryTimes?: number
  readonly retryDelayMs?: number
}

export class RelayStartFailed extends Schema.TaggedErrorClass<RelayStartFailed>()(
  "RelayLifecycle.RelayStartFailed",
  {
    message: Schema.String,
    endpoint: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ExtensionDisconnected extends Schema.TaggedErrorClass<ExtensionDisconnected>()(
  "RelayLifecycle.ExtensionDisconnected",
  { message: Schema.String },
) {}

export function relayBuildProblem(version: RelayVersion, buildId = browserControlBuildId): string | undefined {
  if (buildId === "dev") {
    return undefined
  }
  if (!version.buildId) {
    return `Running relay does not report a build id; restart it with the current CLI (${buildId}).`
  }
  if (version.buildId !== buildId) {
    return `Running relay build ${version.buildId} does not match CLI build ${buildId}; restart the relay.`
  }
  return undefined
}

export const ensureRelay = Effect.fn("RelayLifecycle.ensureRelay")(function* (options: EnsureRelayOptions) {
  const buildId = options.buildId ?? browserControlBuildId
  const probe = options.relay.version
  const initial = yield* Effect.result(probe)
  if (initial._tag === "Success") {
    const buildProblem = relayBuildProblem(initial.success, buildId)
    return { version: initial.success, started: false, ...(buildProblem ? { buildProblem } : {}) } satisfies RelayReadiness
  }
  if (!isRelayUnreachable(initial.failure)) {
    return yield* Effect.fail(initial.failure)
  }

  yield* options.start ?? spawnManagedRelay()
  const version = yield* probe.pipe(
    Effect.retry({
      times: options.retryTimes ?? 40,
      schedule: Schedule.spaced(options.retryDelayMs ?? 50),
      while: isRelayUnreachable,
    }),
    Effect.mapError((error) => isRelayUnreachable(error)
      ? new RelayStartFailed({
        message: `Browser Control relay did not start at ${options.relay.endpoint}`,
        endpoint: options.relay.endpoint,
        cause: error,
      })
      : error),
  )
  const buildProblem = relayBuildProblem(version, buildId)
  return { version, started: true, ...(buildProblem ? { buildProblem } : {}) } satisfies RelayReadiness
})

export const ensureExtensionConnected = Effect.fn("RelayLifecycle.ensureExtensionConnected")(function* (options: {
  readonly relay: RelayClient.Interface
  readonly waitForReconnect?: boolean
  readonly retryTimes?: number
  readonly retryDelayMs?: number
}) {
  const check = options.relay.extensionStatus.pipe(
    Effect.flatMap((status) => status.connected
      ? Effect.succeed(status)
      : Effect.fail(new ExtensionDisconnected({
        message: "Browser Control extension is not connected. Load extension/dist in Chromium; it reconnects automatically when the relay starts.",
      }))),
  )
  if (!options.waitForReconnect) {
    return yield* check
  }
  return yield* check.pipe(
    Effect.retry({
      times: options.retryTimes ?? 40,
      schedule: Schedule.spaced(options.retryDelayMs ?? 50),
      while: (error) => error instanceof ExtensionDisconnected || isRelayUnreachable(error),
    }),
  )
})

export function stoppedRelayStatus(endpoint: string): {
  readonly endpoint: string
  readonly relay: { readonly running: false }
  readonly extension: null
  readonly sessions: readonly []
  readonly targets: readonly []
} {
  return { endpoint, relay: { running: false }, extension: null, sessions: [], targets: [] }
}

export function statusCollections(status: ExtensionStatus): {
  readonly sessions: NonNullable<ExtensionStatus["sessions"]>
  readonly targets: NonNullable<ExtensionStatus["targets"]>
} | undefined {
  return status.sessions && status.targets ? { sessions: status.sessions, targets: status.targets } : undefined
}

function spawnManagedRelay(): Effect.Effect<void, Error> {
  return Effect.try({
    try: () => {
      const entrypoint = process.argv[1]
      if (!entrypoint) {
        throw new Error("Cannot locate the browser-control CLI entrypoint")
      }
      const child = spawn(process.execPath, [...process.execArgv, managedRelayEntrypoint(entrypoint), "serve"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, BROWSER_CONTROL_MANAGED_RELAY: "1" },
      })
      child.unref()
    },
    catch: (cause) => cause instanceof Error ? cause : new Error("Failed to start Browser Control relay", { cause }),
  })
}

export function managedRelayEntrypoint(entrypoint: string): string {
  const name = path.basename(entrypoint)
  if (name === "mcp.js") {
    return path.join(path.dirname(entrypoint), "cli.js")
  }
  if (name === "mcp-main.ts") {
    return path.join(path.dirname(entrypoint), "cli.ts")
  }
  return entrypoint
}

function isRelayUnreachable(error: unknown): error is RelayClient.RelayUnreachable {
  return error instanceof RelayClient.RelayUnreachable
}
