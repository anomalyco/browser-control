import { Effect, type Scope } from "effect"
import { WebSocket } from "ws"
import cp from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import util from "node:util"
import { getObject } from "../src/relay-helpers.ts"
import type { ExecuteAftermath, TargetSummary } from "../src/relay-schema.ts"
import { browserControlBuildId } from "../src/version.ts"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const endpointUrl = process.env.BROWSER_CONTROL_ENDPOINT ?? "http://127.0.0.1:19989"

/**
 * Which Browser Control CLI drives the relay. The relay rejects operational
 * commands from a CLI whose build id differs from its own, so the gauntlet must
 * use the CLI that matches the *running* relay: the checkout's `src/cli.ts`
 * when the relay was started from this source tree, otherwise the installed
 * `browser-control` binary. `GAUNTLET_CLI=source|installed|/path/to/cli.js`
 * overrides auto-detection.
 */
export type CliSelection = {
  readonly kind: "source" | "installed" | "path"
  readonly describe: string
  readonly command: string
  readonly prefixArgs: readonly string[]
}

export type CliResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export type ExecuteEnvelope = {
  readonly ok: boolean
  readonly isError: boolean
  readonly text: string
  readonly value: unknown
  readonly valueUnavailable: boolean
  readonly error?: { readonly _tag: string; readonly message: string }
  readonly warnings: readonly string[]
  readonly diagnostic?: string
  readonly aftermath?: ExecuteAftermath
  readonly session?: { readonly id: string; readonly pageUrl: string | null; readonly connected: boolean; readonly created?: boolean }
  readonly durationMs: number
  readonly exitCode: number
  readonly cliTimedOut: boolean
}

export type ExtensionStatus = {
  readonly connected: boolean
  readonly protocolVersion: number | null
  readonly protocolCompatible: boolean | null
  readonly activeTargets: number
  readonly childTargets: number
  readonly cdpClients: number
  readonly sessionIds: readonly string[]
  readonly targets: readonly TargetSummary[]
}

export type GauntletContext = {
  readonly cli: CliSelection
  readonly fixtures: { readonly primaryOrigin: string; readonly secondaryOrigin: string }
  readonly run: (args: readonly string[], options?: { readonly timeoutMs?: number }) => Effect.Effect<CliResult, Error>
  readonly execute: (options: { readonly sessionId?: string; readonly code: string; readonly targetUrl?: string; readonly timeoutMs?: number }) => Effect.Effect<ExecuteEnvelope, Error>
  readonly createSession: () => Effect.Effect<string, Error>
  readonly deleteSession: (sessionId: string) => Effect.Effect<void>
  readonly status: () => Effect.Effect<ExtensionStatus, Error>
  readonly sessionTargets: (sessionId: string) => Effect.Effect<readonly TargetSummary[], Error>
  readonly ownerCdpPage: (options: { readonly sessionId: string; readonly urlIncludes: string }) => Effect.Effect<OwnerCdpPage, Error, Scope.Scope>
  readonly note: (text: string) => void
  /** Sessions this case created or adopted into; the runner checks they are gone afterwards. */
  readonly trackSession: (sessionId: string) => void
}

class GauntletAssertion extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(details === undefined ? message : `${message}\n${formatValue(details)}`)
    this.name = "GauntletAssertion"
  }
}

export function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) throw new GauntletAssertion(message, details)
}

/**
 * The invariants every gauntlet case must keep, regardless of whether the
 * hostile page is readable: the session still owns exactly one tab, that tab is
 * on the fixture URL, and no about:blank replacement or silent new page was
 * created.
 */
export const assertTabPreserved = Effect.fnUntraced(function* (
  ctx: GauntletContext,
  options: { readonly sessionId: string; readonly urlIncludes: string; readonly envelopes?: readonly ExecuteEnvelope[]; readonly label?: string },
) {
  const label = options.label ?? "tab preserved"
  const targets = yield* ctx.sessionTargets(options.sessionId)
  assert(targets.length === 1, `${label}: expected exactly one target owned by ${options.sessionId}, found ${targets.length}`, targets)
  const target = targets[0]!
  assert(target.url !== "about:blank", `${label}: session target was replaced with about:blank`, target)
  assert(target.url.includes(options.urlIncludes), `${label}: session target URL no longer matches ${options.urlIncludes}`, target)
  for (const envelope of options.envelopes ?? []) {
    const replacement = envelope.warnings.find((warning) => /created a new page/i.test(warning))
    assert(!replacement, `${label}: relay silently replaced the session page`, { warning: replacement, diagnostic: envelope.diagnostic, text: envelope.text })
  }
  return target
})

export function formatValue(value: unknown): string {
  return util.inspect(value, { depth: 8, colors: false, maxArrayLength: 50, maxStringLength: 2000 })
}

export function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const lines = [error.name === "GauntletAssertion" ? error.message : error.stack ?? error.message]
  if (error.cause) {
    lines.push("cause:")
    lines.push(formatValue(error.cause))
  }
  return lines.join("\n")
}

export function playwright<A>(label: string, run: () => PromiseLike<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: () => run(),
    catch: (cause) => new Error(label, { cause }),
  })
}

export function boundedCleanup(label: string, run: () => PromiseLike<unknown>, timeoutMs = 5_000): Effect.Effect<void> {
  return Effect.promise(() => new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs)
    Promise.resolve(run()).then(
      () => { clearTimeout(timeout); resolve() },
      () => { clearTimeout(timeout); resolve() },
    )
  })).pipe(Effect.withSpan(`Gauntlet.cleanup.${label}`))
}

export const sleep = (milliseconds: number): Effect.Effect<void> => Effect.sleep(milliseconds)

// ---------------------------------------------------------------------------
// CLI selection and invocation
// ---------------------------------------------------------------------------

const sourceCli: CliSelection = {
  kind: "source",
  describe: `tsx ${path.relative(repoRoot, path.join(repoRoot, "src", "cli.ts"))} (build ${browserControlBuildId})`,
  command: process.execPath,
  prefixArgs: ["--import", "tsx", path.join(repoRoot, "src", "cli.ts")],
}

export const resolveCli = Effect.fnUntraced(function* (override: string | undefined) {
  const candidates = yield* candidateClis(override)
  const failures: string[] = []
  for (const candidate of candidates) {
    const probe = yield* Effect.result(probeCli(candidate))
    if (probe._tag === "Success") return candidate
    failures.push(`${candidate.describe}: ${probe.failure.message}`)
  }
  return yield* Effect.fail(new Error([
    "No Browser Control CLI can drive the running relay.",
    ...failures.map((failure) => `  - ${failure}`),
    "Start a relay from the build you want to test, or set GAUNTLET_CLI=source|installed|/path/to/cli.js.",
  ].join("\n")))
})

const candidateClis = Effect.fnUntraced(function* (override: string | undefined): Effect.fn.Return<readonly CliSelection[], Error> {
  if (!override || override === "auto") {
    const installed = yield* installedCli()
    return installed ? [sourceCli, installed] : [sourceCli]
  }
  if (override === "source") return [sourceCli]
  if (override === "installed") {
    const installed = yield* installedCli()
    if (!installed) return yield* Effect.fail(new Error("GAUNTLET_CLI=installed but no `browser-control` binary is on PATH"))
    return [installed]
  }
  return [{ kind: "path", describe: override, command: process.execPath, prefixArgs: [path.resolve(override)] }]
})

const installedCli = Effect.fnUntraced(function* (): Effect.fn.Return<CliSelection | undefined, never> {
  const which = yield* Effect.promise(() => new Promise<string | undefined>((resolve) => {
    cp.execFile("which", ["browser-control"], (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined))
  }))
  if (!which) return undefined
  return { kind: "installed", describe: `installed browser-control (${which})`, command: which, prefixArgs: [] }
})

const probeCli = Effect.fnUntraced(function* (cli: CliSelection) {
  const result = yield* runCli(cli, ["status", "--json"], { timeoutMs: 20_000 })
  if (result.exitCode !== 0) {
    return yield* Effect.fail(new Error(`status --json exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`))
  }
  const status = getObject(parseJson(result.stdout, "status --json"))
  const relay = getObject(status?.relay)
  const extension = getObject(status?.extension)
  if (relay?.running !== true) return yield* Effect.fail(new Error("relay is not running"))
  if (relay.stale === true) return yield* Effect.fail(new Error(`relay build ${String(relay.buildId)} does not match this CLI build`))
  if (extension?.connected !== true) return yield* Effect.fail(new Error("extension is not connected to the relay"))
  return status
})

export function runCli(cli: CliSelection, args: readonly string[], options: { readonly timeoutMs?: number } = {}): Effect.Effect<CliResult, Error> {
  return Effect.callback<CliResult, Error>((resume) => {
    let completed = false
    const endpointPort = new URL(endpointUrl).port
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(endpointPort ? { BROWSER_CONTROL_PORT: endpointPort } : {}),
    }
    delete childEnv.BROWSER_CONTROL_TARGET_URL
    delete childEnv.BROWSER_CONTROL_TARGET_INDEX
    delete childEnv.BROWSER_CONTROL_SESSION
    const child = cp.execFile(
      cli.command,
      [...cli.prefixArgs, ...args],
      { cwd: repoRoot, env: childEnv, timeout: options.timeoutMs ?? 90_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        completed = true
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0
        resume(Effect.succeed({ exitCode, stdout, stderr, timedOut: error?.killed === true }))
      },
    )
    return Effect.sync(() => {
      if (!completed) child.kill()
    })
  })
}

function parseJson(text: string, label: string): unknown {
  const start = text.indexOf("{")
  if (start < 0) throw new Error(`${label} did not print JSON: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text.slice(start)) as unknown
  } catch (cause) {
    throw new Error(`${label} printed invalid JSON: ${text.slice(0, 200)}`, { cause })
  }
}

export function parseExecuteEnvelope(result: CliResult, durationMs: number): ExecuteEnvelope {
  if (result.timedOut) {
    return {
      ok: false,
      isError: true,
      text: `browser-control execute did not return before the gauntlet CLI timeout (${durationMs}ms)`,
      value: null,
      valueUnavailable: true,
      error: { _tag: "GauntletCliTimeout", message: "execute child process timed out" },
      warnings: [],
      durationMs,
      exitCode: result.exitCode,
      cliTimedOut: true,
    }
  }
  const object = getObject(parseJson(result.stdout, "execute --json"))
  if (!object || typeof object.ok !== "boolean" || typeof object.isError !== "boolean" || typeof object.text !== "string") {
    throw new Error(`execute --json returned an unexpected envelope: ${result.stdout.slice(0, 400)}`)
  }
  const error = getObject(object.error)
  const session = getObject(object.session)
  return {
    ok: object.ok,
    isError: object.isError,
    text: object.text,
    value: object.value,
    valueUnavailable: object.valueUnavailable === true,
    ...(error && typeof error.message === "string" ? { error: { _tag: typeof error._tag === "string" ? error._tag : "Error", message: error.message } } : {}),
    warnings: Array.isArray(object.warnings) ? object.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    ...(typeof object.diagnostic === "string" ? { diagnostic: object.diagnostic } : {}),
    ...(getObject(object.aftermath) ? { aftermath: object.aftermath as unknown as ExecuteAftermath } : {}),
    ...(session && typeof session.id === "string"
      ? {
        session: {
          id: session.id,
          pageUrl: typeof session.pageUrl === "string" ? session.pageUrl : null,
          connected: session.connected === true,
          ...(session.created === true ? { created: true } : {}),
        },
      }
      : {}),
    durationMs,
    exitCode: result.exitCode,
    cliTimedOut: false,
  }
}

// ---------------------------------------------------------------------------
// Relay status
// ---------------------------------------------------------------------------

export const fetchStatus = Effect.fnUntraced(function* () {
  const response = yield* Effect.tryPromise({
    try: () => fetch(new URL("/extension/status", endpointUrl)),
    catch: (cause) => new Error(`fetch extension status from ${endpointUrl}`, { cause }),
  })
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => new Error("parse extension status", { cause }),
  })
  return parseExtensionStatus(body)
})

function parseExtensionStatus(value: unknown): ExtensionStatus {
  const status = getObject(value)
  if (!status || typeof status.connected !== "boolean" || typeof status.activeTargets !== "number") {
    throw new Error("Invalid extension status shape")
  }
  return {
    connected: status.connected,
    protocolVersion: typeof status.protocolVersion === "number" ? status.protocolVersion : null,
    protocolCompatible: typeof status.protocolCompatible === "boolean" ? status.protocolCompatible : null,
    activeTargets: status.activeTargets,
    childTargets: typeof status.childTargets === "number" ? status.childTargets : 0,
    cdpClients: typeof status.cdpClients === "number" ? status.cdpClients : 0,
    sessionIds: Array.isArray(status.sessions)
      ? status.sessions.flatMap((item) => {
        const id = getObject(item)?.id
        return typeof id === "string" ? [id] : []
      })
      : [],
    targets: Array.isArray(status.targets)
      ? status.targets.flatMap((item) => {
        const target = getObject(item)
        return target && typeof target.id === "string" && typeof target.url === "string" ? [target as unknown as TargetSummary] : []
      })
      : [],
  }
}

/**
 * Leaks are judged only against resources this case created: other agents share
 * the relay, so raw target/session counts cannot be compared before and after.
 */
export function resourceLeaks(options: {
  readonly after: ExtensionStatus
  readonly createdSessionIds: ReadonlySet<string>
  readonly fixtureOrigins: readonly string[]
}): string | undefined {
  const leaks: string[] = []
  const leakedSessions = options.after.sessionIds.filter((id) => options.createdSessionIds.has(id))
  if (leakedSessions.length > 0) leaks.push(`sessions still present: ${leakedSessions.join(", ")}`)
  const leakedTargets = options.after.targets.filter((target) => options.fixtureOrigins.some((origin) => target.url.startsWith(origin)))
  if (leakedTargets.length > 0) leaks.push(`fixture tabs still open: ${leakedTargets.map((target) => target.url).join(", ")}`)
  return leaks.length > 0 ? leaks.join("; ") : undefined
}

// ---------------------------------------------------------------------------
// Owner CDP page: acts as "the human" on a session-owned tab through the relay
// without going through the session's Execute Sandbox.
// ---------------------------------------------------------------------------

export type OwnerCdpPage = {
  readonly targetId: string
  readonly evaluate: <A = unknown>(expression: string) => Effect.Effect<A, Error>
  readonly waitFor: (expression: string, options?: { readonly timeoutMs?: number }) => Effect.Effect<void, Error>
  readonly close: () => Promise<void>
}

export const scopedOwnerCdpPage = Effect.fnUntraced(function* (options: { readonly sessionId: string; readonly urlIncludes: string }) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => makeOwnerCdpPage(options),
      catch: (cause) => cause instanceof Error ? cause : new Error(`connect owner CDP page for ${options.sessionId}`, { cause }),
    }),
    (page) => boundedCleanup("close owner CDP page", page.close),
  )
})

async function makeOwnerCdpPage(options: { readonly sessionId: string; readonly urlIncludes: string }): Promise<OwnerCdpPage> {
  const [versionResponse, targetsResponse] = await Promise.all([
    fetch(new URL("/json/version", endpointUrl)),
    fetch(new URL("/json/list", endpointUrl)),
  ])
  const version = await versionResponse.json() as { readonly webSocketDebuggerUrl?: unknown }
  const targets = await targetsResponse.json() as Array<{ readonly id?: unknown; readonly url?: unknown; readonly browserControlSessionId?: unknown }>
  if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("Relay did not provide a browser websocket URL")
  const target = targets.find((candidate) =>
    candidate.browserControlSessionId === options.sessionId && typeof candidate.url === "string" && candidate.url.includes(options.urlIncludes),
  )
  if (!target || typeof target.id !== "string") throw new Error(`No target owned by ${options.sessionId} matched ${options.urlIncludes}`)
  const targetId = target.id

  const websocketUrl = new URL(version.webSocketDebuggerUrl)
  websocketUrl.searchParams.set("browserControlSessionId", options.sessionId)
  const socket = new WebSocket(websocketUrl)
  let nextId = 1
  const pending = new Map<number, { readonly resolve: (value: Record<string, unknown>) => void; readonly reject: (error: Error) => void; readonly timeout: NodeJS.Timeout }>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { readonly id?: unknown; readonly result?: unknown; readonly error?: { readonly message?: unknown } }
    if (typeof message.id !== "number") return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timeout)
    if (message.error) {
      waiter.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Owner CDP command failed"))
      return
    }
    waiter.resolve(getObject(message.result) ?? {})
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  const command = (method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs = 10_000): Promise<Record<string, unknown>> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Owner CDP command timed out: ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timeout })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  const announced = await command("Target.attachToTarget", { targetId, flatten: true })
  if (typeof announced.sessionId !== "string") {
    socket.close()
    throw new Error("Owner CDP target attach did not return a session id")
  }
  // The first attach announces the root; the second returns a client-local
  // alias that remains routable if Chrome re-announces the root generation.
  const attached = await command("Target.attachToTarget", { targetId, flatten: true })
  if (typeof attached.sessionId !== "string") {
    socket.close()
    throw new Error("Owner CDP target alias did not return a session id")
  }
  const targetSessionId = attached.sessionId
  const evaluate = <A>(expression: string): Effect.Effect<A, Error> => Effect.tryPromise({
    try: async () => {
      const response = await command("Runtime.evaluate", { expression, returnByValue: true }, targetSessionId)
      if (response.exceptionDetails) throw new Error(`Owner CDP evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
      const result = getObject(response.result)
      return (result ? result.value : undefined) as A
    },
    catch: (cause) => cause instanceof Error ? cause : new Error("Owner CDP evaluation failed", { cause }),
  })
  return {
    targetId,
    evaluate,
    waitFor: (expression, waitOptions) => Effect.gen(function* () {
      const attempts = Math.ceil((waitOptions?.timeoutMs ?? 10_000) / 50)
      for (let attempt = 0; attempt < attempts; attempt++) {
        const outcome = yield* Effect.result(evaluate<boolean>(expression))
        if (outcome._tag === "Success" && outcome.success) return
        yield* Effect.sleep("50 millis")
      }
      return yield* Effect.fail(new Error(`Owner CDP condition timed out: ${expression}`))
    }),
    close: async () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error("Owner CDP socket closed"))
      }
      pending.clear()
      socket.terminate()
    },
  }
}
