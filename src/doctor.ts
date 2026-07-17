import { Effect, FileSystem, Path, Schema } from "effect"
import * as RelayClient from "./relay-client.ts"
import type { ExtensionStatus, RelayVersion, SessionSummary, TargetSummary } from "./relay-schema.ts"
import * as SessionStore from "./session-store.ts"
import { browserControlBuildId, browserControlVersion } from "./version.ts"

/**
 * Read-only local install and runtime diagnostics. Pure report construction
 * over RelayClient/SessionStore/FileSystem probes; never fails, degrades to
 * warn/fail checks instead.
 */

export type ProbeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

const PackageMetadata = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

const ManifestVersion = Schema.Struct({
  version: Schema.String,
})

type PackageInfo = {
  readonly name: string
  readonly version: string
  readonly bin: {
    readonly browserControl: string | null
    readonly browserControlMcp: string | null
  }
}

export type DoctorArtifact = {
  readonly path: string
  readonly exists: boolean
  readonly version?: string
}

export type DoctorCheckStatus = "ok" | "warn" | "fail"

export type DoctorCheck = {
  readonly id: string
  readonly label: string
  readonly status: DoctorCheckStatus
  readonly message: string
}

export type DoctorReport = {
  readonly status: DoctorCheckStatus
  readonly endpoint: string
  readonly cli: {
    readonly version: string
    readonly buildId: string
  }
  readonly package: {
    readonly path: string
    readonly name: string | null
    readonly version: string | null
    readonly bin: {
      readonly browserControl: boolean
      readonly browserControlMcp: boolean
    }
    readonly error: string | null
  }
  readonly relay: {
    readonly reachable: boolean
    readonly version: string | null
    readonly buildId: string | null
    readonly buildMatches: boolean | null
    readonly error: string | null
  }
  readonly extension: {
    readonly connected: boolean | null
    readonly version: string | null
    readonly expectedVersion: string | null
    readonly versionMatches: boolean | null
    readonly error: string | null
  }
  readonly targets: {
    readonly active: number | null
    readonly child: number | null
    readonly relayOwned: readonly TargetSummary[]
    readonly unhealthy: readonly TargetSummary[]
    readonly all: readonly TargetSummary[]
    readonly error: string | null
  }
  readonly sessions: {
    readonly current: string | null
    readonly staleCurrent: boolean
    readonly possibleLeaked: readonly SessionSummary[]
    readonly all: readonly SessionSummary[]
    readonly error: string | null
  }
  readonly artifacts: readonly DoctorArtifact[]
  readonly checks: readonly DoctorCheck[]
  readonly recommendations: readonly string[]
}

const probe = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<ProbeResult<A>> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false, error: errorMessage(error) } as const),
      onSuccess: (value) => ({ ok: true, value } as const),
    }),
  )

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export const createDoctorReport = Effect.fn("Doctor.createReport")(function* (options: {
  readonly packageRoot: string
}) {
  const relay = yield* RelayClient.Service
  const store = yield* SessionStore.Service
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const readJsonFile = <A>(relativePath: string, schema: Schema.ConstraintDecoder<A>): Effect.Effect<A, Error> =>
    fs.readFileString(path.join(options.packageRoot, relativePath)).pipe(
      Effect.mapError((cause) => new Error(`read ${relativePath}: ${cause.reason.message}`)),
      Effect.flatMap((text) =>
        Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () => new Error(`parse ${relativePath}: invalid JSON`),
        })
      ),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError((cause) => new Error(`decode ${relativePath}: ${cause.message}`)),
        )
      ),
    )

  const readPackageInfo: Effect.Effect<PackageInfo, Error> = readJsonFile("package.json", PackageMetadata).pipe(
    Effect.map((metadata) => ({
      name: metadata.name,
      version: metadata.version,
      bin: {
        browserControl: metadata.bin?.["browser-control"] ?? null,
        browserControlMcp: metadata.bin?.["browser-control-mcp"] ?? null,
      },
    })),
  )

  const readManifestVersion = (relativePath: string): Effect.Effect<string, Error> =>
    readJsonFile(relativePath, ManifestVersion).pipe(Effect.map((manifest) => manifest.version))

  const fileExists = (relativePath: string): Effect.Effect<boolean> =>
    fs.exists(path.join(options.packageRoot, relativePath)).pipe(
      Effect.catch(() => Effect.succeed(false)),
    )

  const [packageResult, sourceManifestVersion, distManifestVersion, distCliExists, distMcpExists, extensionDistManifestExists, currentResult] = yield* Effect.all([
    probe(readPackageInfo),
    probe(readManifestVersion("extension/manifest.json")),
    probe(readManifestVersion("extension/dist/manifest.json")),
    fileExists("dist/cli.js"),
    fileExists("dist/mcp.js"),
    fileExists("extension/dist/manifest.json"),
    probe(store.read),
  ])
  const relayResult = yield* probe(relay.version)
  const relayBuildMatches = relayResult.ok
    ? browserControlBuildId === "dev"
      ? true
      : relayResult.value.buildId
        ? relayResult.value.buildId === browserControlBuildId
        : null
    : null
  const [extensionResult, targetsResult, sessionsResult] = relayResult.ok
    ? yield* Effect.all([
      probe(relay.extensionStatus),
      probe(relay.targets),
      probe(relay.sessions),
    ])
    : [
      { ok: false, error: relayResult.error } satisfies ProbeResult<ExtensionStatus>,
      { ok: false, error: relayResult.error } satisfies ProbeResult<readonly TargetSummary[]>,
      { ok: false, error: relayResult.error } satisfies ProbeResult<readonly SessionSummary[]>,
    ]
  const expectedVersion = sourceManifestVersion.ok ? sourceManifestVersion.value : null
  const extensionVersion = extensionResult.ok ? extensionResult.value.version : null
  const extensionVersionMatches = extensionResult.ok && extensionVersion && expectedVersion ? extensionVersion === expectedVersion : null
  const current = currentResult.ok ? currentResult.value ?? null : null
  const targets = targetsResult.ok ? targetsResult.value : []
  const sessions = sessionsResult.ok ? sessionsResult.value : []
  const staleCurrent = Boolean(current && sessionsResult.ok && !sessions.some((session) => {
    return session.id === current
  }))
  const relayOwnedTargets = targets.filter((target) => {
    return target.owner === "relay"
  })
  const unhealthyTargets = targets.filter((target) => {
    return target.crashed === true || target.url.startsWith("chrome-error://")
  })
  const possibleLeakedSessions = sessions.filter((session) => {
    return session.connected && session.id !== current
  })
  const artifacts: readonly DoctorArtifact[] = [
    { path: "dist/cli.js", exists: distCliExists },
    { path: "dist/mcp.js", exists: distMcpExists },
    {
      path: "extension/dist/manifest.json",
      exists: extensionDistManifestExists,
      ...(distManifestVersion.ok ? { version: distManifestVersion.value } : {}),
    },
  ]
  const checks = buildDoctorChecks({
    packageResult,
    relayResult,
    extensionResult,
    sourceManifestVersion,
    extensionVersionMatches,
    artifacts,
    currentResult,
    staleCurrent,
    relayOwnedTargets,
    unhealthyTargets,
    possibleLeakedSessions,
    targetsResult,
    sessionsResult,
  })
  const report: DoctorReport = {
    status: summarizeCheckStatus(checks),
    endpoint: relay.endpoint,
    cli: { version: browserControlVersion, buildId: browserControlBuildId },
    package: {
      path: path.join(options.packageRoot, "package.json"),
      name: packageResult.ok ? packageResult.value.name : null,
      version: packageResult.ok ? packageResult.value.version : null,
      bin: {
        browserControl: packageResult.ok ? Boolean(packageResult.value.bin.browserControl) : false,
        browserControlMcp: packageResult.ok ? Boolean(packageResult.value.bin.browserControlMcp) : false,
      },
      error: packageResult.ok ? null : packageResult.error,
    },
    relay: {
      reachable: relayResult.ok,
      version: relayResult.ok ? relayResult.value.version : null,
      buildId: relayResult.ok ? relayResult.value.buildId ?? null : null,
      buildMatches: relayBuildMatches,
      error: relayResult.ok ? null : relayResult.error,
    },
    extension: {
      connected: extensionResult.ok ? extensionResult.value.connected : null,
      version: extensionVersion,
      expectedVersion,
      versionMatches: extensionVersionMatches,
      error: extensionResult.ok ? null : extensionResult.error,
    },
    targets: {
      active: extensionResult.ok ? extensionResult.value.activeTargets : null,
      child: extensionResult.ok ? extensionResult.value.childTargets ?? null : null,
      relayOwned: relayOwnedTargets,
      unhealthy: unhealthyTargets,
      all: targets,
      error: targetsResult.ok ? null : targetsResult.error,
    },
    sessions: {
      current,
      staleCurrent,
      possibleLeaked: possibleLeakedSessions,
      all: sessions,
      error: sessionsResult.ok ? currentResult.ok ? null : currentResult.error : sessionsResult.error,
    },
    artifacts,
    checks,
    recommendations: buildDoctorRecommendations({
      relayResult,
      relayBuildMatches,
      extensionResult,
      artifacts,
      staleCurrent,
      current,
      relayOwnedTargets,
      unhealthyTargets,
      possibleLeakedSessions,
    }),
  }
  return report
})

function buildDoctorChecks(options: {
  readonly packageResult: ProbeResult<PackageInfo>
  readonly relayResult: ProbeResult<RelayVersion>
  readonly extensionResult: ProbeResult<ExtensionStatus>
  readonly sourceManifestVersion: ProbeResult<string>
  readonly extensionVersionMatches: boolean | null
  readonly artifacts: readonly DoctorArtifact[]
  readonly currentResult: ProbeResult<string | undefined>
  readonly staleCurrent: boolean
  readonly relayOwnedTargets: readonly TargetSummary[]
  readonly unhealthyTargets: readonly TargetSummary[]
  readonly possibleLeakedSessions: readonly SessionSummary[]
  readonly targetsResult: ProbeResult<readonly TargetSummary[]>
  readonly sessionsResult: ProbeResult<readonly SessionSummary[]>
}): readonly DoctorCheck[] {
  const packageBinChecks: readonly DoctorCheck[] = options.packageResult.ok
    ? [
      {
        id: "bin-browser-control",
        label: "browser-control bin",
        status: options.packageResult.value.bin.browserControl ? "ok" : "fail",
        message: options.packageResult.value.bin.browserControl ?? "missing from package.json bin",
      },
      {
        id: "bin-browser-control-mcp",
        label: "browser-control-mcp bin",
        status: options.packageResult.value.bin.browserControlMcp ? "ok" : "warn",
        message: options.packageResult.value.bin.browserControlMcp ?? "missing from package.json bin",
      },
    ]
    : []
  const artifactChecks = options.artifacts.map((artifact): DoctorCheck => {
    return {
      id: `artifact-${artifact.path}`,
      label: artifact.path,
      status: artifact.exists ? "ok" : "warn",
      message: artifact.exists ? artifact.version ? `exists (${artifact.version})` : "exists" : "missing; run pnpm build",
    }
  })
  return [
    {
      id: "package-metadata",
      label: "package metadata",
      status: options.packageResult.ok ? "ok" : "fail",
      message: options.packageResult.ok ? `${options.packageResult.value.name} ${options.packageResult.value.version}` : options.packageResult.error,
    },
    ...packageBinChecks,
    {
      id: "relay-http",
      label: "relay HTTP endpoint",
      status: options.relayResult.ok ? "ok" : "fail",
      message: options.relayResult.ok ? `reachable (${options.relayResult.value.version})` : options.relayResult.error,
    },
    relayBuildCheck({ relayResult: options.relayResult, cliBuildId: browserControlBuildId }),
    {
      id: "extension-connected",
      label: "extension connection",
      status: options.extensionResult.ok && options.extensionResult.value.connected ? "ok" : "fail",
      message: options.extensionResult.ok ? options.extensionResult.value.connected ? `connected${options.extensionResult.value.version ? ` (${options.extensionResult.value.version})` : ""}` : "disconnected" : options.extensionResult.error,
    },
    {
      id: "extension-version",
      label: "extension version",
      status: extensionVersionCheckStatus({ extensionResult: options.extensionResult, sourceManifestVersion: options.sourceManifestVersion, versionMatches: options.extensionVersionMatches }),
      message: extensionVersionCheckMessage({ extensionResult: options.extensionResult, sourceManifestVersion: options.sourceManifestVersion, versionMatches: options.extensionVersionMatches }),
    },
    {
      id: "targets-readable",
      label: "targets readable",
      status: options.targetsResult.ok ? "ok" : "fail",
      message: options.targetsResult.ok ? `${options.targetsResult.value.length} active root target(s)` : options.targetsResult.error,
    },
    unhealthyTargetsCheck({
      targetsResult: options.targetsResult,
      unhealthyTargets: options.unhealthyTargets,
    }),
    {
      id: "sessions-readable",
      label: "sessions readable",
      status: options.sessionsResult.ok ? "ok" : "fail",
      message: options.sessionsResult.ok ? `${options.sessionsResult.value.length} session(s)` : options.sessionsResult.error,
    },
    {
      id: "current-session-file",
      label: "current session file",
      status: options.currentResult.ok ? "ok" : "warn",
      message: options.currentResult.ok ? options.currentResult.value ?? "none" : options.currentResult.error,
    },
    {
      id: "current-session-stale",
      label: "current session membership",
      status: options.staleCurrent ? "warn" : "ok",
      message: options.staleCurrent ? "current session is not present in relay sessions" : "current session is valid or unset",
    },
    {
      id: "relay-owned-targets",
      label: "relay-owned active targets",
      status: "ok",
      message: options.relayOwnedTargets.length ? `${options.relayOwnedTargets.length} persistent relay-owned target(s)` : "none",
    },
    {
      id: "possible-leaked-sessions",
      label: "connected non-current sessions",
      status: "ok",
      message: options.possibleLeakedSessions.length ? `${options.possibleLeakedSessions.length} connected non-current session(s)` : "none",
    },
    ...artifactChecks,
  ]
}

export function unhealthyTargetsCheck(options: {
  readonly targetsResult: ProbeResult<readonly TargetSummary[]>
  readonly unhealthyTargets: readonly TargetSummary[]
}): DoctorCheck {
  if (!options.targetsResult.ok) {
    return {
      id: "unhealthy-targets",
      label: "crashed or browser-error targets",
      status: "warn",
      message: `target health unknown: ${options.targetsResult.error}`,
    }
  }
  return {
    id: "unhealthy-targets",
    label: "crashed or browser-error targets",
    status: options.unhealthyTargets.length ? "warn" : "ok",
    message: options.unhealthyTargets.length ? `${options.unhealthyTargets.length} unhealthy target(s)` : "none",
  }
}

export function relayBuildCheck(options: {
  readonly relayResult: ProbeResult<RelayVersion>
  readonly cliBuildId: string
}): DoctorCheck {
  if (!options.relayResult.ok) {
    return {
      id: "relay-build",
      label: "relay build",
      status: "warn",
      message: "relay unreachable; cannot compare builds",
    }
  }
  if (options.cliBuildId === "dev") {
    return {
      id: "relay-build",
      label: "relay build",
      status: "ok",
      message: "CLI is a development build; build comparison skipped",
    }
  }
  const relayBuildId = options.relayResult.value.buildId
  if (!relayBuildId) {
    return {
      id: "relay-build",
      label: "relay build",
      status: "warn",
      message: "running relay does not report a build id",
    }
  }
  const matches = relayBuildId === options.cliBuildId
  return {
    id: "relay-build",
    label: "relay build",
    status: matches ? "ok" : "warn",
    message: matches
      ? `matches CLI build (${options.cliBuildId})`
      : `runtime ${relayBuildId} does not match CLI ${options.cliBuildId}`,
  }
}

function extensionVersionCheckStatus(options: {
  readonly extensionResult: ProbeResult<ExtensionStatus>
  readonly sourceManifestVersion: ProbeResult<string>
  readonly versionMatches: boolean | null
}): DoctorCheckStatus {
  if (!options.extensionResult.ok || !options.extensionResult.value.connected) {
    return "warn"
  }
  if (!options.sourceManifestVersion.ok || !options.extensionResult.value.version) {
    return "warn"
  }
  return options.versionMatches ? "ok" : "warn"
}

function extensionVersionCheckMessage(options: {
  readonly extensionResult: ProbeResult<ExtensionStatus>
  readonly sourceManifestVersion: ProbeResult<string>
  readonly versionMatches: boolean | null
}): string {
  if (!options.extensionResult.ok) {
    return options.extensionResult.error
  }
  if (!options.extensionResult.value.connected) {
    return "extension disconnected; cannot compare runtime version"
  }
  if (!options.sourceManifestVersion.ok) {
    return `could not read extension/manifest.json: ${options.sourceManifestVersion.error}`
  }
  if (!options.extensionResult.value.version) {
    return "extension did not report a version"
  }
  return options.versionMatches
    ? `matches extension/manifest.json (${options.sourceManifestVersion.value})`
    : `runtime ${options.extensionResult.value.version} does not match extension/manifest.json ${options.sourceManifestVersion.value}`
}

function buildDoctorRecommendations(options: {
  readonly relayResult: ProbeResult<RelayVersion>
  readonly relayBuildMatches: boolean | null
  readonly extensionResult: ProbeResult<ExtensionStatus>
  readonly artifacts: readonly DoctorArtifact[]
  readonly staleCurrent: boolean
  readonly current: string | null
  readonly relayOwnedTargets: readonly TargetSummary[]
  readonly unhealthyTargets: readonly TargetSummary[]
  readonly possibleLeakedSessions: readonly SessionSummary[]
}): readonly string[] {
  const relayRecommendations = options.relayResult.ok ? [] : [
    "Run a relay-backed command to start the detached relay automatically; use `browser-control serve` only for foreground debugging.",
  ]
  const relayBuildRecommendations = options.relayResult.ok && options.relayBuildMatches !== true ? [
    "Restart the relay with `browser-control serve` so it uses the current CLI build.",
  ] : []
  const extensionRecommendations = options.relayResult.ok && options.extensionResult.ok && !options.extensionResult.value.connected ? [
    "Load or reload `extension/dist` as an unpacked extension, then click the Browser Control toolbar button on a normal web tab.",
  ] : []
  const artifactRecommendations = options.artifacts.some((artifact) => {
    return !artifact.exists
  }) ? ["Run `pnpm build` to regenerate missing CLI or extension artifacts."] : []
  const staleSessionRecommendations = options.staleCurrent && options.current ? [
    `Current session ${options.current} is stale; run \`browser-control session new\` or \`browser-control session use <id>\` after the relay is running.`,
  ] : []
  const unhealthyTargetRecommendations = options.unhealthyTargets.length ? [
    "A target is crashed or showing a browser error page. Run the owning session once to trigger relay-owned recovery, or reset/re-adopt a user-owned tab.",
  ] : []
  return [
    ...relayRecommendations,
    ...relayBuildRecommendations,
    ...extensionRecommendations,
    ...artifactRecommendations,
    ...staleSessionRecommendations,
    ...unhealthyTargetRecommendations,
  ]
}

function summarizeCheckStatus(checks: readonly DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => {
    return check.status === "fail"
  })) {
    return "fail"
  }
  if (checks.some((check) => {
    return check.status === "warn"
  })) {
    return "warn"
  }
  return "ok"
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    "Browser Control doctor",
    `Status: ${report.status}`,
    `Endpoint: ${report.endpoint}`,
    `CLI: ${report.cli.version} (${report.cli.buildId})`,
    `Package: ${report.package.name && report.package.version ? `${report.package.name} ${report.package.version}` : report.package.error ?? "unknown"}`,
    `Relay: ${report.relay.reachable ? `reachable (${report.relay.version ?? "unknown"}, ${report.relay.buildId ?? "unknown build"})` : `unreachable (${report.relay.error ?? "unknown error"})`}`,
    `Extension: ${formatExtensionSummary(report)}`,
    `Targets: active=${formatNullableNumber(report.targets.active)} child=${formatNullableNumber(report.targets.child)} relay-owned=${report.targets.relayOwned.length} unhealthy=${report.targets.unhealthy.length}`,
    `Sessions: current=${report.sessions.current ?? "none"} total=${report.sessions.all.length} connected=${report.sessions.all.filter((session) => {
      return session.connected
    }).length}`,
    "",
    "Checks:",
    ...report.checks.map((check) => {
      return `[${check.status}] ${check.label}: ${check.message}`
    }),
  ]
  const targetLines = report.targets.relayOwned.map((target) => {
    return `- ${formatTargetSummary(target)}`
  })
  const unhealthyTargetLines = report.targets.unhealthy.map((target) => {
    return `- ${formatTargetSummary(target)}`
  })
  const sessionLines = report.sessions.possibleLeaked.map((session) => {
    return `- ${session.id} ${session.pageUrl ?? "no page yet"}`
  })
  const details = [
    ...(targetLines.length ? ["", "Relay-owned targets:", ...targetLines] : []),
    ...(unhealthyTargetLines.length ? ["", "Unhealthy targets:", ...unhealthyTargetLines] : []),
    ...(sessionLines.length ? ["", "Connected non-current sessions:", ...sessionLines] : []),
    ...(report.recommendations.length ? ["", "Next steps:", ...report.recommendations.map((item) => {
      return `- ${item}`
    })] : []),
  ]
  return [...lines, ...details].join("\n")
}

function formatExtensionSummary(report: DoctorReport): string {
  if (report.extension.connected === null) {
    return `unknown (${report.extension.error ?? "relay unreachable"})`
  }
  const version = report.extension.version ? ` (${report.extension.version})` : ""
  const match = report.extension.versionMatches === null ? "" : report.extension.versionMatches ? ", version matches manifest" : ", version differs from manifest"
  return `${report.extension.connected ? "connected" : "disconnected"}${version}${match}`
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "unknown" : String(value)
}

export function formatTargetSummary(target: TargetSummary): string {
  const tab = target.tabId === undefined ? "" : ` tab=${target.tabId}`
  const owner = target.owner ? ` owner=${target.owner}` : ""
  const health = target.crashed ? " crashed=true" : ""
  return `${target.type} ${target.id}${tab}${owner}${health} ${target.url || "about:blank"}`
}
