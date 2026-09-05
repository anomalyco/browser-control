import http from "node:http"
import { AsyncLocalStorage } from "node:async_hooks"
import stream from "node:stream"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Clock, Config, Effect, Exit, Option, Scope, Semaphore } from "effect"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import {
  replayChildFrameNavigation,
  replayChildTargetsForParent,
  replayTargetCreated,
} from "./cdp-shims.ts"
import { CdpClientPool } from "./cdp-client-pool.ts"
import { CdpRouter, isRootRoutableBrowserContextMethod } from "./cdp-router.ts"
import { CdpRuntime } from "./cdp-runtime.ts"
import { ExtensionRpc } from "./extension-rpc.ts"
import { createHttpRequestHandler } from "./http-api.ts"
import type { CdpEvent, CdpRequest, JsonObject, PageStatus } from "./protocol.ts"
import { extensionProtocolCompatibility, isCdpRequest, isExtensionEvent, isExtensionResponse, parseJsonObject } from "./protocol.ts"
import {
  closeHttpServer,
  closeWebSocketServer,
  chromeExtensionOriginForPath,
  defaultHost,
  defaultPort,
  formatHostForUrl,
  getObject,
  getTargetInfo,
  headerValue,
  HttpRouteError,
  isRestrictedTarget,
  listenHttpServer,
  logCloseError,
  sendCdpEvent,
  sendCdpResponse,
  validateHostHeader,
  validateWebSocketOrigin,
} from "./relay-helpers.ts"
import type { ChildTarget, ConnectedTarget } from "./relay-types.ts"
import { ghostCursorMouseActionExpression, ghostCursorRestoreExpression, inputDispatchMouseEventToGhostCursorAction } from "./ghost-cursor.ts"
import { guardCdpMethod } from "./cdp-guardrails.ts"
import {
  awaitHandoffAction,
  HandoffRegistry,
  resolveExactHandoffTarget,
  toolbarClickAction,
  type HandoffCancellationReason,
  type HandoffOutcome,
} from "./handoff.ts"
import { ExecuteSandbox, type HandoffPageTarget } from "./execute.ts"
import { makePageStatus } from "./page-status.ts"
import { appendJournalEntry, defaultJournalBaseDir, makeJournalEntry } from "./session-journal.ts"
import { defaultSessionCatalogPath, SessionCatalog, type PersistedSession } from "./session-catalog.ts"
import { BrowserControlSessions } from "./session-manager.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { appendManagedRelayProcessLog } from "./relay-log.ts"
import { appendRelayLifecycleEvent, RelayLifecycleEvent } from "./relay-lifecycle-log.ts"
import { RelayShutdown } from "./relay-shutdown.ts"
import { RootTargetLifecycle } from "./root-target-lifecycle.ts"
import { boundedToken, runtimeFailureKind, summarizeDiagnosticUrl, summarizeRuntimeEvaluate } from "./runtime-diagnostics.ts"
import { shouldExposeChildTarget, TargetRegistry, type RootTargetChange, type TargetOwnershipChange } from "./target-registry.ts"
import { browserControlBuildId, browserControlVersion } from "./version.ts"
import type { BrowserProfileSummary } from "./relay-schema.ts"

export const startRelay = Effect.fn("Relay.start")(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
} = {}) {
  yield* installRelayProcessGuard
  return yield* Effect.acquireRelease(makeRelay(options), (server) => {
    return server.close()
  })
})

type RelayProcessFaultKind = "uncaughtException" | "unhandledRejection"

const installRelayProcessGuard = Effect.acquireRelease(
  Effect.sync(() => {
    const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
      handleRelayProcessFault("uncaughtException", error, { origin })
    }
    const onUnhandledRejection = (reason: unknown, promise: Promise<unknown>) => {
      handleRelayProcessFault("unhandledRejection", reason, { promise })
    }
    process.on("uncaughtException", onUncaughtException)
    process.on("unhandledRejection", onUnhandledRejection)
    return { onUncaughtException, onUnhandledRejection }
  }),
  (handlers) => {
    return Effect.sync(() => {
      process.off("uncaughtException", handlers.onUncaughtException)
      process.off("unhandledRejection", handlers.onUnhandledRejection)
    })
  },
)

export function shouldSuppressRelayProcessFault(cause: unknown): boolean {
  const errorText = cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause)
  return /playwright-core|coreBundle|Duplicate target/i.test(errorText)
}

export function handleRelayProcessFault(
  kind: RelayProcessFaultKind,
  cause: unknown,
  detail: Record<string, unknown>,
  options: { readonly rethrow?: (cause: unknown) => never } = {},
): void {
  if (shouldSuppressRelayProcessFault(cause)) {
    logProcessFault(kind, cause, detail, "keeping relay alive")
    return
  }
  logProcessFault(kind, cause, detail, "not a known Playwright dispatch fault; rethrowing")
  const rethrow = options.rethrow ?? rethrowProcessFault
  rethrow(cause)
}

function rethrowProcessFault(cause: unknown): never {
  if (cause instanceof Error) {
    throw cause
  }
  throw new Error(String(cause))
}

function logProcessFault(kind: RelayProcessFaultKind, cause: unknown, detail: Record<string, unknown>, disposition: string): void {
  const errorText = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  const message = `[browser-control relay] ${kind}; ${disposition}\n${errorText}`
  console.error(message)
  if (process.env.BROWSER_CONTROL_MANAGED_RELAY === "1") appendManagedRelayProcessLog(message)
  if (debugEnvironmentEnabled(process.env.BROWSER_CONTROL_DEBUG)) {
    console.error(`[browser-control relay] ${kind} detail`, detail)
  }
}

function debugEnvironmentEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function getBundledUnpackedExtensionOrigin(): string | undefined {
  try {
    const extensionPath = fs.realpathSync(fileURLToPath(new URL("../extension/dist", import.meta.url)))
    return chromeExtensionOriginForPath(extensionPath)
  } catch {
    return undefined
  }
}

const makeRelay = Effect.fnUntraced(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
} = {}) {
  const host = defaultHost
  const port = options.port ?? defaultPort
  const browserId = crypto.randomUUID()
  const endpointUrl = `http://${formatHostForUrl(host)}:${port}`
  const debugEnabled = yield* Config.boolean("BROWSER_CONTROL_DEBUG").pipe(Config.withDefault(false))
  const managed = yield* Config.boolean("BROWSER_CONTROL_MANAGED_RELAY").pipe(Config.withDefault(false))
  const restartTimeoutMs = yield* Config.int("BROWSER_CONTROL_RESTART_TIMEOUT_MS").pipe(Config.withDefault(10_000))
  const restartRequestId = yield* Config.option(Config.string("BROWSER_CONTROL_RESTART_REQUEST_ID"))
  const lifecycleLogPath = path.join(path.dirname(defaultSessionCatalogPath(port)), "lifecycle.jsonl")
  const audit = (event: RelayLifecycleEvent) => Effect.try(() => appendRelayLifecycleEvent(lifecycleLogPath, event))
  const allowAnyChromeExtension = browserControlVersion === "0.0.0-dev"
  const bundledOrigin = getBundledUnpackedExtensionOrigin()
  const additionalChromeExtensionOrigins = new Set([
    ...(bundledOrigin ? [bundledOrigin] : []),
    ...(options.additionalExtensionOrigins ?? []),
  ])
  const sessionCatalog = options.sessionCatalogPath === null
    ? undefined
    : new SessionCatalog(options.sessionCatalogPath ?? defaultSessionCatalogPath(port))
  const runtimes = new Map<string, ProfileRuntime>()
  const persisted = new Map<string, readonly PersistedSession[]>()
  let persistenceTail = Promise.resolve()
  let relayReady = false
  let relayClosing = false
  let catalogClosing = false
  const bindSemaphore = Semaphore.makeUnsafe(1)
  const persistAll = (): Promise<void> => {
    if (!relayReady) return Promise.resolve()
    // closeAll clears each manager independently. During shutdown use its final
    // descriptor snapshots, still updated by draining executes, not cleared maps.
    const snapshot = catalogClosing
      ? Array.from(persisted.values()).flat()
      : Array.from(runtimes.values()).flatMap((runtime) => runtime.sessions.persistedSessions())
    const write = persistenceTail.catch(() => {}).then(() => sessionCatalog?.save(snapshot))
    persistenceTail = write
    return write
  }
  let drainedPersistenceTail: Promise<void> | undefined
  const drainProfiles = Effect.fnUntraced(function* () {
    yield* Effect.forEach(Array.from(runtimes.values()), (runtime) => runtime.sessions.beginDrain(), { concurrency: "unbounded", discard: true })
  })
  const settleProfiles = Effect.fnUntraced(function* () {
    yield* bindSemaphore.withPermit(Effect.void)
    while (true) {
      const current = Array.from(runtimes.values())
      yield* Effect.forEach(current, (runtime) => runtime.settle(), { concurrency: "unbounded", discard: true })
      yield* drainProfiles()
      const pending = persistenceTail
      yield* Effect.tryPromise(() => pending)
      if (current.length === runtimes.size && pending === persistenceTail) {
        drainedPersistenceTail = pending
        return
      }
    }
  })
  const shutdownControl = new RelayShutdown({
    instanceId: browserId,
    managed,
    timeoutMs: Math.max(0, restartTimeoutMs),
    drain: drainProfiles(),
    resume: () => { for (const runtime of runtimes.values()) runtime.sessions.resume() },
    busy: () => {
      if (Array.from(runtimes.values()).some((runtime) => runtime.hasRawClients())) return "raw-clients"
      if (Array.from(runtimes.values()).some((runtime) => runtime.recordingRelay.hasActiveRecordings() || runtime.sessions.hasActiveNetworkCapture())) return "recordings"
      return undefined
    },
    settle: settleProfiles(),
    quiescent: () => drainedPersistenceTail === persistenceTail && Array.from(runtimes.values()).every((runtime) => runtime.isIdle() && runtime.sessions.isDrained()),
    audit,
    stop: () => { setImmediate(() => process.kill(process.pid, "SIGTERM")) },
  })
  const createProfile = (profileId: string, profileName?: string): ProfileRuntime => {
    const existing = runtimes.get(profileId)
    if (existing) return existing
    const runtime = makeProfileRuntime({
      endpointUrl,
      shutdownControl,
      profileId,
      ...(profileName ? { profileName } : {}),
      releaseTargetGraceMs: Math.max(0, options.releaseTargetGraceMs ?? 10_000),
      debugEnabled,
      restoredSessions: persisted.get(profileId) ?? [],
      isSessionIdTaken: (id) => Array.from(runtimes.values()).some((profile) => profile.sessions.sessions.has(id)),
      onSessionsChanged: (entries) => {
        persisted.set(profileId, entries)
        return persistAll()
      },
    })
    runtimes.set(profileId, runtime)
    return runtime
  }
  const profiles: RelayProfiles = {
    list: () => Array.from(runtimes.values()),
    get: (profileId) => runtimes.get(profileId),
    bind: (selection) => bindSemaphore.withPermit(Effect.gen(function* () {
      if (relayClosing) return yield* Effect.fail(new Error("Browser Control relay is closing"))
      const source = selection.sessionId ? Array.from(runtimes.values()).find((runtime) =>
        runtime.sessions.sessions.has(selection.sessionId!) && (runtime.profileId === "unbound"
          || (runtime.profileId === "legacy" && !runtime.extensionStatus().connected && !runtime.isInventoryPending()))) : undefined
      const session = selection.sessionId ? source?.sessions.sessions.get(selection.sessionId) : undefined
      if (!source || !session) return profiles.select(selection)
      const selected = selection.profileId !== undefined ? profiles.select({ profileId: selection.profileId }) : undefined
      let destination: RelayProfileRuntime | undefined
      if (session.target) {
        const targetId = session.target.id
        if (!selected && Array.from(runtimes.values()).some((runtime) => runtime.isInventoryPending())) throw new HttpRouteError({ message: `Legacy session ${session.id} is waiting for all connected browser profile inventories to finish`, status: 409, code: "profile-mismatch" })
        const matches = Array.from(runtimes.values()).filter((runtime) => runtime.profileId !== "unbound"
          && runtime.extensionStatus().connected && runtime.registry.targetsByTargetId.has(targetId))
        if (selected) {
          if (!matches.includes(selected as ProfileRuntime)) throw new HttpRouteError({ message: `Legacy session ${session.id} can only bind where its exact target ${targetId} is attached`, status: 409, code: "profile-mismatch" })
          destination = selected
        } else {
          if (matches.length > 1) throw new HttpRouteError({ message: `Legacy session ${session.id} target exists in multiple browser profiles; provide profileId`, status: 409, code: "profile-ambiguous" })
          destination = matches[0]
          if (!destination) throw new HttpRouteError({ message: `Legacy session ${session.id} is waiting for its exact target to appear in a connected browser profile`, status: 409, code: "profile-mismatch" })
        }
      } else {
        if (!selected || selected.profileId === "unbound" || !selected.extensionStatus().connected) throw new HttpRouteError({ message: `Legacy session ${session.id} has no target; provide the profileId of a connected browser profile`, status: 409, code: "profile-mismatch" })
        destination = selected
      }
      yield* source.sessions.transferTo(session.id, destination.sessions, persistAll)
      ;(destination as ProfileRuntime).reconcileTransferredTarget(session.id)
      return destination
    })),
    select: ({ profileId, sessionId }) => {
      const all = Array.from(runtimes.values())
      const owners = sessionId ? all.filter((profile) => profile.sessions.sessions.has(sessionId)) : []
      if (owners.length > 1) throw new HttpRouteError({ message: `Session ${sessionId} exists in multiple profiles`, status: 409, code: "profile-ambiguous" })
      let selected: ProfileRuntime | undefined
      if (profileId !== undefined) {
        const matches = runtimes.has(profileId) ? [runtimes.get(profileId)!] : all.filter((profile) => profile.profileName === profileId)
        if (matches.length > 1) throw new HttpRouteError({ message: `Multiple profiles are named ${profileId}; use the exact profileId`, status: 409, code: "profile-ambiguous" })
        selected = matches[0]
        if (!selected) throw new HttpRouteError({ message: `Browser profile not found: ${profileId}`, status: 404, code: "profile-not-found" })
      }
      const owner = owners[0]
      if (owner) {
        if (selected && selected !== owner) throw new HttpRouteError({ message: `Session ${sessionId} is pinned to profile ${owner.profileId}`, status: 409, code: "profile-mismatch" })
        return owner
      }
      if (selected) return selected
      const connected = all.filter((profile) => profile.extensionStatus().connected)
      if (connected.length === 1) return connected[0]!
      if (connected.length > 1 || all.length > 1) throw new HttpRouteError({ message: "Multiple browser profiles are available; provide profileId", status: 409, code: "profile-ambiguous" })
      if (all[0] && all[0].profileId !== "unbound") return all[0]
      if (all.length === 0) throw new HttpRouteError({ message: "No browser profile is connected; connect the Browser Control extension first", status: 404, code: "profile-not-found" })
      throw new HttpRouteError({ message: "Legacy sessions have no verified browser profile; connect a profile and select its profileId", status: 409, code: "profile-mismatch" })
    },
  }
  const relayRequestHandler = createHttpRequestHandler({
    host, port, browserId,
    relayInstance: { id: browserId, startedAt: new Date().toISOString(), pid: process.pid, managed },
    shutdown: shutdownControl,
    profiles,
    extensionStatus: () => {
      const all = profiles.list()
      const statuses = all.map((runtime) => runtime.extensionStatus())
      const connected = statuses.filter((status) => status.connected)
      const representative = connected.length > 0 ? connected : statuses.filter((status) => status.protocolCompatible !== null)
      const shared = <K extends "version" | "protocolVersion" | "protocolCompatible" | "protocolLegacy">(key: K) => {
        const value = representative[0]?.[key] ?? null
        return representative.every((status) => status[key] === value) ? value : null
      }
      return {
        connected: connected.length > 0,
        version: shared("version"),
        protocolVersion: shared("protocolVersion"),
        protocolCompatible: shared("protocolCompatible"),
        protocolLegacy: shared("protocolLegacy"),
        rejectedConnections: statuses.reduce((count, status) => count + status.rejectedConnections, 0),
        cdpClients: statuses.reduce((count, status) => count + status.cdpClients, 0),
        profiles: all.map((runtime) => ({
          id: runtime.profileId,
          ...(runtime.profileName ? { name: runtime.profileName } : {}),
          connected: runtime.extensionStatus().connected,
          version: runtime.extensionStatus().version,
          activeTargets: runtime.registry.rootTargetCount(),
        })),
      }
    },
  })
  const httpServer = http.createServer((request, response) => {
    if (!relayReady || relayClosing) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "1" })
      response.end(JSON.stringify({ error: "Browser Control relay is starting or stopping", code: "relay-starting" }))
      return
    }
    relayRequestHandler(request, response)
  })
  const websocketServer = new WebSocketServer({ noServer: true })
  const cleanup = Effect.fnUntraced(function* () {
    // Accepted sandbox work may still need HTTP discovery, handoffs and RPCs.
    yield* shutdownControl.close().pipe(Effect.ignore)
    relayClosing = true
    // Drain migration before freezing manager identities; draining session work
    // may still update these cached descriptors through onSessionsChanged.
    yield* bindSemaphore.withPermit(Effect.sync(() => {
      if (catalogClosing) return
      for (const [profileId, runtime] of runtimes) persisted.set(profileId, runtime.sessions.persistedSessions())
      catalogClosing = true
    }))
    yield* Effect.forEach(Array.from(runtimes.values()), (runtime) => runtime.close(), { concurrency: "unbounded" })
    for (const socket of websocketServer.clients) socket.close()
    yield* Effect.promise(() => persistenceTail.catch(() => {}))
    if (managed) {
      yield* audit(RelayLifecycleEvent.cases.Closed.make({ instanceId: browserId })).pipe(
        Effect.catch(() => Effect.sync(() => console.error("Failed to record relay shutdown lifecycle event"))),
      )
    }
    yield* closeWebSocketServer(websocketServer).pipe(logCloseError("Failed to close websocket server"))
    yield* closeHttpServer(httpServer).pipe(logCloseError("Failed to close http server"))
  })
  httpServer.on("upgrade", (request, socket, head) => {
    if (!relayReady || relayClosing) {
      sendUpgradeError({ socket, status: 404, message: "Browser Control relay is starting or stopping" })
      return
    }
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host, port })
    if (hostError) {
      sendUpgradeError({ socket, status: 403, message: hostError })
      return
    }
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    const extension = requestUrl.pathname === "/extension"
    if (!extension && !requestUrl.pathname.startsWith("/devtools/browser/")) {
      socket.destroy()
      return
    }
    const origin = headerValue(request.headers.origin)
    const originError = validateWebSocketOrigin({ origin, requireChromeExtension: extension, allowAnyChromeExtension, additionalChromeExtensionOrigins })
    if (originError) {
      sendUpgradeError({ socket, status: 403, message: originError })
      return
    }
    let selected: ProfileRuntime | undefined
    const sessionId = requestUrl.searchParams.get("browserControlSessionId") ?? headerValue(request.headers["browser-control-session-id"])
    const clientKind = headerValue(request.headers["browser-control-client-kind"]) === "sandbox" ? "sandbox" : "raw"
    if (!extension) {
      try {
        const profileId = requestUrl.searchParams.get("profileId") ?? headerValue(request.headers["browser-control-profile-id"])
        selected = profiles.select({ ...(profileId !== undefined ? { profileId } : {}), ...(sessionId ? { sessionId } : {}) }) as ProfileRuntime
        if (!shutdownControl.accepting && (clientKind !== "sandbox" || !sessionId || !selected.sessions.hasPendingWork(sessionId))) {
          sendUpgradeError({ socket, status: 503, message: "Relay is draining for an explicit restart" })
          return
        }
      } catch (error) {
        sendUpgradeError({ socket, status: error instanceof HttpRouteError && error.status === 404 ? 404 : 409, message: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (selected) {
        selected.acceptCdp(websocket, sessionId, clientKind)
        return
      }
      const helloTimeout = setTimeout(() => websocket.close(4002, "Extension hello required"), 10_000)
      websocket.once("close", () => clearTimeout(helloTimeout))
      websocket.once("message", (data, isBinary) => {
        clearTimeout(helloTimeout)
        if (relayClosing) {
          websocket.close(1001, "Relay closed")
          return
        }
        const raw = data.toString()
        const hello = isBinary ? undefined : parseJsonObject(raw)
        if (!hello || !isExtensionEvent(hello) || hello.method !== "hello") {
          websocket.close(4002, "Extension hello required")
          return
        }
        const identity = hello.params?.profileId
        if (identity !== undefined && (typeof identity !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(identity) || identity === "legacy" || identity === "unbound")) {
          websocket.close(4002, "Invalid browser profile identity")
          return
        }
        const profileId = typeof identity === "string" ? identity : "legacy"
        const name = typeof hello.params?.profileName === "string" ? hello.params.profileName.trim().slice(0, 200) : undefined
        createProfile(profileId, name).acceptExtension(websocket, raw)
      })
    })
  })
  yield* Effect.catch(Effect.gen(function* () {
    // Win the port before reading or writing any durable session state.
    yield* listenHttpServer({ server: httpServer, host, port })
    const restoredSessions = yield* Effect.tryPromise({
      try: () => sessionCatalog?.load() ?? Promise.resolve([]),
      catch: (cause) => cause instanceof Error ? cause : new Error("Load Browser Control session catalog", { cause }),
    })
    yield* Effect.try({
      try: () => {
        const ids = new Set<string>()
        for (const entry of restoredSessions) {
          if (ids.has(entry.id)) throw new Error(`Duplicate persisted session: ${entry.id}`)
          ids.add(entry.id)
          const profileId = entry.profileId ?? "unbound"
          persisted.set(profileId, [...(persisted.get(profileId) ?? []), { ...entry, profileId }])
        }
        for (const [profileId, entries] of persisted) createProfile(profileId, entries.find((entry) => entry.profileName)?.profileName)
      },
      catch: (cause) => cause instanceof Error ? cause : new Error("Restore Browser Control sessions", { cause }),
    })
    if (managed) {
      yield* audit(yield* RelayLifecycleEvent.cases.Ready.makeEffect({
        instanceId: browserId,
        buildId: browserControlBuildId,
        ...(Option.isSome(restartRequestId) ? { restartRequestId: restartRequestId.value } : {}),
      }))
    }
    relayReady = true
  }), (error) => Effect.gen(function* () {
    yield* cleanup()
    return yield* Effect.fail(error)
  }))
  return { url: endpointUrl, close: () => cleanup() }
})

export type RelayProfileRuntime = {
  readonly profileId: string
  readonly profileName: string | undefined
  readonly registry: TargetRegistry
  readonly sessions: BrowserControlSessions
  readonly recordingRelay: RecordingRelay
  readonly renameProfile: (name: string) => Promise<BrowserProfileSummary>
  readonly extensionStatus: () => {
    readonly connected: boolean
    readonly version: string | null
    readonly protocolVersion: number | null
    readonly protocolCompatible: boolean | null
    readonly protocolLegacy: boolean | null
    readonly rejectedConnections: number
    readonly cdpClients: number
  }
}

export type RelayProfiles = {
  readonly list: () => readonly RelayProfileRuntime[]
  readonly get: (profileId: string) => RelayProfileRuntime | undefined
  readonly bind: (options: { readonly profileId?: string; readonly sessionId?: string }) => Effect.Effect<RelayProfileRuntime, Error>
  readonly select: (options: { readonly profileId?: string; readonly sessionId?: string }) => RelayProfileRuntime
}

type ProfileRuntime = RelayProfileRuntime & {
  readonly acceptExtension: (socket: WebSocket, rawHello: string) => void
  readonly acceptCdp: (socket: WebSocket, sessionId: string | undefined, kind: "sandbox" | "raw") => void
  readonly hasRawClients: () => boolean
  readonly settle: () => Effect.Effect<boolean>
  readonly isIdle: () => boolean
  readonly reconcileTransferredTarget: (sessionId: string) => void
  readonly isInventoryPending: () => boolean
  readonly close: () => Effect.Effect<void>
}

function makeProfileRuntime(options: {
  readonly endpointUrl: string
  readonly shutdownControl: RelayShutdown
  readonly profileId: string
  readonly profileName?: string
  readonly releaseTargetGraceMs: number
  readonly debugEnabled: boolean
  readonly restoredSessions: readonly PersistedSession[]
  readonly onSessionsChanged: (entries: readonly PersistedSession[]) => Promise<void>
  readonly isSessionIdTaken: (id: string) => boolean
}): ProfileRuntime {
  const { endpointUrl, releaseTargetGraceMs, shutdownControl } = options
  let profileName = options.profileName
  const registry = new TargetRegistry()
  type TabGroupingMethod = "tabs.group" | "tabs.ungroup"
  const pendingTabGrouping = new Map<number, TabGroupingMethod>()
  const tabGroupingWorkers = new Map<number, Promise<void>>()
  let extensionGeneration = 0
  let rejectedExtensionConnections = 0
  const extensionRpc = new ExtensionRpc()
  // An old socket's asynchronous work must never issue commands on its successor.
  const connectionEpoch = new AsyncLocalStorage<number>()
  const sendToExtension = Effect.fnUntraced(function* (command: Parameters<ExtensionRpc["send"]>[0]) {
    const epoch = connectionEpoch.getStore()
    if (epoch !== undefined && epoch !== extensionGeneration) {
      return yield* Effect.fail(new Error("Extension connection changed before command completed"))
    }
    const generation = extensionGeneration
    const result = yield* shutdownControl.trackTransport(extensionRpc.send(command))
    if (generation !== extensionGeneration) {
      return yield* Effect.fail(new Error("Extension connection changed while command was in flight"))
    }
    return result
  })
  const sendDebuggerCommand = Effect.fnUntraced(function* (options: {
    readonly tabId: number
    readonly sessionId?: string
    readonly method: string
    readonly params: JsonObject
  }) {
    return yield* sendToExtension({
      method: "debugger.sendCommand",
      params: {
        tabId: options.tabId,
        method: options.method,
        params: options.params,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
    })
  })
  const trackNative = <A>(run: () => Promise<A>): Promise<A> => Effect.runPromise(shutdownControl.trackTransport(Effect.promise(run)))
  class ProfileRecordingRelay extends RecordingRelay {
    override startRecording(...args: Parameters<RecordingRelay["startRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => trackNative(() => super.startRecording(...args)))
    }
    override stopRecording(...args: Parameters<RecordingRelay["stopRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => trackNative(() => super.stopRecording(...args)))
    }
    override statusRecording(...args: Parameters<RecordingRelay["statusRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => trackNative(() => super.statusRecording(...args)))
    }
    override cancelRecording(...args: Parameters<RecordingRelay["cancelRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => trackNative(() => super.cancelRecording(...args)))
    }
    override abortRecordingForTab(...args: Parameters<RecordingRelay["abortRecordingForTab"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => trackNative(() => super.abortRecordingForTab(...args)))
    }
    override cleanupAll(...args: Parameters<RecordingRelay["cleanupAll"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => trackNative(() => super.cleanupAll(...args)))
    }
  }
  const recordingRelay = new ProfileRecordingRelay({
    sendToExtension: (command) => {
      return Effect.runPromise(sendToExtension(command))
    },
    sendDebuggerCommand: (command) => {
      return Effect.runPromise(sendDebuggerCommand(command))
    },
    isExtensionConnected: () => {
      return extensionRpc.connected
    },
  })
  const handoffs = new HandoffRegistry()
  const activeHandoffTabs = new Map<string, Set<number>>()
  const clearLiveExtensionState = (reason: string, retiringGeneration = extensionGeneration) => {
    void connectionEpoch.run(retiringGeneration, () => recordingRelay.cleanupAll(reason)).catch(() => {})
    pendingTabGrouping.clear()
    for (const target of [...registry.listRootTargets()]) {
      detachTargetState(target.tabId, { preserveSessionTarget: true, updateExtension: false })
    }
    registry.clear()
    suppressedChildSessions.clear()
  }
  const releaseRelayTarget = Effect.fnUntraced(function* (targetId: string) {
    const deadline = (yield* Clock.currentTimeMillis) + releaseTargetGraceMs
    while (true) {
      const target = registry.targetsByTargetId.get(targetId)
      if (target && (extensionRpc.connected || extensionRpc.protocolLegacy === true)) {
        yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } })
        return
      }
      // Protocol v1 reports ready only after its complete attached-tab inventory
      // has reconciled. Legacy shims need the full grace because hello came first.
      if (extensionRpc.connected && extensionRpc.protocolLegacy === false) return
      const remaining = deadline - (yield* Clock.currentTimeMillis)
      if (remaining <= 0) return
      yield* Effect.sleep(Math.min(50, remaining))
    }
  })
  const journalBaseDir = defaultJournalBaseDir()
  const attachedBadge = { text: "ON", color: "#7c3aed", title: "Detach from Browser Control" }
  const executingBadge = { text: "RUN", color: "#f59e0b", title: "Browser Control is running a script" }
  const waitingBadge = (message: string) => ({ text: "WAIT", color: "#2563eb", title: `Browser Control is waiting for you: ${message}` })
  const executionBadge = (sessionId: string, executing: boolean) => executing && !sessions.isReadOnly(sessionId) ? executingBadge : attachedBadge
  const setActivityForSessionTabs = (
    browserControlSessionId: string,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
  ) => {
    for (const target of registry.listRootTargets()) {
      if (pageStatusSessionId(target) !== browserControlSessionId) {
        continue
      }
      // Best-effort: older shims without action.setBadge just reject the command.
      Effect.runPromise(Effect.ignore(sendToExtension({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } }))).catch(() => {})
      sendPageStatus(target, state)
    }
  }
  const setActivityForTarget = (
    target: ConnectedTarget,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ) => {
    Effect.runPromise(Effect.ignore(sendToExtension({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } }))).catch(() => {})
    sendPageStatus(target, state, options)
  }
  const setActivityForTargetAcknowledged = async (
    target: ConnectedTarget,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): Promise<void> => {
    Effect.runPromise(Effect.ignore(sendToExtension({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } }))).catch(() => {})
    await Effect.runPromise(sendPageStatusEffect(target, state, options))
  }
  const removeActiveHandoffTab = (sessionId: string, tabId: number): void => {
    const tabIds = activeHandoffTabs.get(sessionId)
    if (!tabIds) {
      return
    }
    tabIds.delete(tabId)
    if (tabIds.size === 0) {
      activeHandoffTabs.delete(sessionId)
    }
  }
  const cancelTargetHandoffs = (target: ConnectedTarget, reason: HandoffCancellationReason): void => {
    const cancelled = handoffs.cancelForTarget({
      targetId: target.targetInfo.targetId,
      targetSessionId: target.sessionId,
      reason,
    })
    for (const pending of cancelled) {
      removeActiveHandoffTab(pending.sessionId, pending.tabId)
    }
  }
  const requestHandoff = async (options: {
    readonly sessionId: string
    readonly message: string
    readonly timeoutMs: number
    readonly target: HandoffPageTarget
    readonly start?: () => unknown | Promise<unknown>
    readonly cancelStart?: () => Promise<void>
  }): Promise<HandoffOutcome> => {
    const target = resolveHandoffTarget(options.sessionId, options.target)
    const sessionTabs = activeHandoffTabs.get(options.sessionId) ?? new Set<number>()
    sessionTabs.add(target.tabId)
    activeHandoffTabs.set(options.sessionId, sessionTabs)
    const wait = handoffs.wait({
      sessionId: options.sessionId,
      tabId: target.tabId,
      targetId: target.targetInfo.targetId,
      targetSessionId: target.sessionId,
      message: options.message,
      timeoutMs: options.timeoutMs,
    })
    let outcome: HandoffOutcome | undefined
    try {
      outcome = await awaitHandoffAction({
        outcome: wait.outcome,
        present: () => setActivityForTargetAcknowledged(target, "waiting", waitingBadge(options.message), {
          sessionId: options.sessionId,
          message: options.message,
          handoffId: wait.id,
        }),
        ...(options.start ? { start: options.start } : {}),
        ...(options.cancelStart ? { cancelStart: options.cancelStart } : {}),
        cancel: () => {
          handoffs.cancel(wait.id)
        },
      })
      return outcome
    } catch (error) {
      handoffs.cancel(wait.id)
      removeActiveHandoffTab(options.sessionId, target.tabId)
      throw error
    } finally {
      if (outcome !== undefined && outcome !== "resolved" && outcome !== "timeout") {
        removeActiveHandoffTab(options.sessionId, target.tabId)
      }
      const currentTarget = registry.tabTargets.get(target.tabId)
      if (currentTarget) {
        if (outcome !== undefined && outcome !== "resolved" && outcome !== "timeout") {
          refreshPageStatus(currentTarget.tabId)
        } else {
          const executing = sessions.isExecuting(options.sessionId)
          setActivityForTarget(currentTarget, executing ? "running" : "attached", executionBadge(options.sessionId, executing), { sessionId: options.sessionId })
        }
      }
    }
  }
  const sessions: BrowserControlSessions = new BrowserControlSessions(
    endpointUrl,
    (id, onDefaultTargetChange) =>
      new ExecuteSandbox({
        endpointUrl,
        sessionId: id,
        onDefaultTargetChange,
        requestHandoff: ({ message, timeoutMs, target, start, cancelStart }) => requestHandoff({
          sessionId: id,
          message,
          timeoutMs,
          target,
          ...(start ? { start } : {}),
          ...(cancelStart ? { cancelStart } : {}),
        }),
      }),
    {
      profileId: options.profileId,
      ...(profileName ? { profileName } : {}),
      isSessionIdTaken: options.isSessionIdTaken,
      getUserAttachedPageUrls: () => registry.listRootTargets()
        .filter((target) => target.owner === "user")
        .map((target) => target.targetInfo.url || "about:blank"),
      onExecuteStateChange: (sessionId, executing) => {
        setActivityForSessionTabs(sessionId, executing ? "running" : "attached", executionBadge(sessionId, executing))
        if (!executing) {
          for (const tabId of activeHandoffTabs.get(sessionId) ?? []) {
            const target = registry.tabTargets.get(tabId)
            if (target) {
              setActivityForTarget(target, "attached", attachedBadge, { sessionId })
            }
          }
          activeHandoffTabs.delete(sessionId)
        }
      },
      onExecuteRecord: (record) => {
        const entry = makeJournalEntry({
          sessionId: record.sessionId,
          code: record.code,
          isError: record.result.isError,
          durationMs: record.durationMs,
          resultText: record.result.text,
          logCount: record.result.logs.length,
          startUrl: record.result.aftermath?.startUrl,
          endUrl: record.result.aftermath?.endUrl,
          navigations: record.result.aftermath?.navigations,
          warnings: record.result.warnings,
          diagnostic: record.result.diagnostic,
          handoffs: record.result.aftermath?.handoffs,
        })
        return appendJournalEntry({ baseDir: journalBaseDir, entry })
      },
      onTargetOwnershipChange: (change) => {
        reconcileTargetOwnership(change)
      },
      onReleaseRelayTarget: (targetId) => releaseRelayTarget(targetId),
      onSessionsChanged: options.onSessionsChanged,
    },
    registry,
  )
  sessions.restore(options.restoredSessions)
  function pageStatusSessionId(target: ConnectedTarget): string | undefined {
    return target.browserControlSessionId
  }

  function activeHandoffSessionIdForTab(tabId: number): string | undefined {
    return Array.from(activeHandoffTabs.entries()).find(([, tabIds]) => tabIds.has(tabId))?.[0]
  }

  function resolveHandoffTarget(sessionId: string, selectedPage: HandoffPageTarget): ConnectedTarget {
    return resolveExactHandoffTarget({
      targetId: selectedPage.targetId,
      targets: registry.listRootTargets(),
      isVisible: (target) => cdpRouter.canSessionSeeTarget(sessionId, target),
    })
  }

  function sendPageStatusEffect(
    target: ConnectedTarget,
    state: PageStatus["state"],
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): Effect.Effect<void, Error> {
    const sessionId = options.sessionId ?? pageStatusSessionId(target)
    const status = makePageStatus({
      state,
      targetOwner: target.owner,
      ...(sessionId ? { sessionId, readOnly: sessions.isReadOnly(sessionId) } : {}),
      ...(options.message ? { message: options.message } : {}),
      ...(options.handoffId ? { handoffId: options.handoffId } : {}),
    })
    return sendToExtension({
      method: "pageStatus.set",
      params: {
        tabId: target.tabId,
        status: {
          state: status.state,
          owner: status.owner,
          ...(status.sessionId ? { sessionId: status.sessionId } : {}),
          ...(status.readOnly ? { readOnly: true } : {}),
          ...(status.message ? { message: status.message } : {}),
          ...(status.handoffId ? { handoffId: status.handoffId } : {}),
        },
      },
    }).pipe(Effect.asVoid)
  }

  function sendPageStatus(
    target: ConnectedTarget,
    state: PageStatus["state"],
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): void {
    Effect.runPromise(Effect.ignore(sendPageStatusEffect(target, state, options))).catch(() => {})
  }

  function refreshPageStatus(tabId: number): void {
    const target = registry.tabTargets.get(tabId)
    if (!target) {
      Effect.runPromise(Effect.ignore(sendToExtension({ method: "pageStatus.clear", params: { tabId } }))).catch(() => {})
      return
    }
    const pending = handoffs.pendingForTab(tabId)
    if (pending) {
      sendPageStatus(target, "waiting", { sessionId: pending.sessionId, message: pending.message, handoffId: pending.id })
      return
    }
    const sessionId = pageStatusSessionId(target) ?? activeHandoffSessionIdForTab(tabId)
    sendPageStatus(target, sessionId && sessions.isExecuting(sessionId) ? "running" : "attached", sessionId ? { sessionId } : {})
  }
  function scheduleTabGrouping(tabId: number, method: TabGroupingMethod): void {
    pendingTabGrouping.set(tabId, method)
    if (tabGroupingWorkers.has(tabId)) return
    const worker = trackNative(async () => {
      while (true) {
        const next = pendingTabGrouping.get(tabId)
        if (!next) return
        pendingTabGrouping.delete(tabId)
        await Effect.runPromise(Effect.ignore(sendToExtension({ method: next, params: { tabId } })))
      }
    }).finally(() => {
      if (tabGroupingWorkers.get(tabId) !== worker) return
      tabGroupingWorkers.delete(tabId)
      const next = pendingTabGrouping.get(tabId)
      if (next) scheduleTabGrouping(tabId, next)
    })
    tabGroupingWorkers.set(tabId, worker)
  }
  function refreshTabGrouping(tabId: number): void {
    const target = registry.tabTargets.get(tabId)
    scheduleTabGrouping(tabId, target && pageStatusSessionId(target) ? "tabs.group" : "tabs.ungroup")
  }
  function refreshTabPresentation(tabId: number): void {
    refreshPageStatus(tabId)
    refreshTabGrouping(tabId)
  }
  const extensionStatus = () => ({
    connected: extensionRpc.connected,
    version: extensionRpc.version ?? null,
    protocolVersion: extensionRpc.protocolVersion ?? null,
    protocolCompatible: extensionRpc.protocolCompatible ?? null,
    protocolLegacy: extensionRpc.protocolLegacy ?? null,
    rejectedConnections: rejectedExtensionConnections,
    cdpClients: cdpClients.size,
  })
  const debugLog = options.debugEnabled ? (line: string) => console.error(`[bc ${new Date().toISOString().slice(11, 23)} profile=${options.profileId}] ${line}`) : undefined
  const contextDebugLog = debugLog ? (line: string) => debugLog(`[bc:ctx] ${line}`) : undefined
  const cdpClients = new CdpClientPool<WebSocket>(sendCdpEvent)
  const cdpRouter = new CdpRouter(cdpClients, registry)
  const cdpRuntime = new CdpRuntime({
    registry,
    generation: () => extensionGeneration,
    send: sendDebuggerCommand,
    ...(contextDebugLog ? { trace: contextDebugLog } : {}),
  })
  const mainFrameIdsByTab = new Map<number, string>()
  const ghostCursorPositionsByTab = new Map<number, { readonly x: number; readonly y: number }>()
  const suppressedChildSessions = new Map<string, number>()

  function targetDiagnosticIdentity(target: ConnectedTarget | ChildTarget | undefined): string {
    if (!target) {
      return "target=unknown"
    }
    const root = registry.tabTargets.get(target.tabId)
    const isRoot = "owner" in target
    return [
      `tab=${target.tabId}`,
      `target=${boundedToken(target.targetInfo.targetId)}`,
      `cdpSession=${boundedToken(target.sessionId)}`,
      `owner=${isRoot ? target.owner : root?.owner ?? "child"}`,
      `bcSession=${boundedToken(isRoot ? target.browserControlSessionId : root?.browserControlSessionId)}`,
      `browserContext=${boundedToken(target.targetInfo.browserContextId ?? root?.targetInfo.browserContextId)}`,
    ].join(" ")
  }

  function targetForCdpSession(tabId: number, sessionId: string | undefined): ConnectedTarget | ChildTarget | undefined {
    if (sessionId) {
      return registry.targets.get(sessionId) ?? registry.childTargets.get(sessionId) ?? registry.tabTargets.get(tabId)
    }
    return registry.tabTargets.get(tabId)
  }

  function diagnosticTargetForClient(socket: WebSocket, sessionId: string | undefined): ConnectedTarget | ChildTarget | undefined {
    return sessionId
      ? cdpRouter.targetInfo(socket, { sessionId })
      : cdpRouter.preferredRoot(socket)
  }

  function isRuntimeEvaluationMethod(method: string): boolean {
    return method === "Runtime.evaluate" || method === "Runtime.callFunctionOn"
  }

  const cleanup = Effect.fnUntraced(function* () {
    yield* sessions.closeAll()
    yield* Scope.close(lifecycleScope, Exit.void)
    handoffs.cancelAll()
    extensionRpc.rejectPending(new Error("Relay closed"))
    yield* Effect.tryPromise(() => recordingRelay.cleanupAll("Relay closed")).pipe(Effect.ignore)
    for (const socket of cdpClients) {
      socket.close()
    }
    extensionRpc.close()
  })

  function acceptExtension(socket: WebSocket, rawHello: string): void {
    const socketGeneration = acceptExtensionHello(socket, rawHello)
    if (socketGeneration === undefined) {
      socket.close(4002, "Extension hello required")
      return
    }
    const announcedRootTabIds = new Set<number>()
    socket.on("message", (data, isBinary) => {
      try {
        if (!extensionRpc.isCurrent(socket) || !extensionRpc.acceptsEvents) return
        if (isBinary) {
          try {
            recordingRelay.handleBinaryData(rawDataToBuffer(data))
          } catch {
            socket.close(1002, "Invalid recording frame")
          }
          return
        }
        connectionEpoch.run(socketGeneration, () => handleExtensionMessage(socket, data.toString(), socketGeneration, announcedRootTabIds))
      } catch (error) {
        console.error("Extension message handling failed", error)
      }
    })
    socket.on("close", () => {
      if (extensionRpc.disconnectIfCurrent(socket)) {
        const retiringGeneration = extensionGeneration
        extensionGeneration += 1
        rejectedExtensionConnections = 0
        clearLiveExtensionState("Extension disconnected", retiringGeneration)
      }
    })
  }

  function acceptCdp(socket: WebSocket, browserControlSessionId: string | undefined, kind: "sandbox" | "raw"): void {
    cdpClients.register(socket, browserControlSessionId, kind)
    debugLog?.(`client+ ${browserControlSessionId ?? "raw"} total=${cdpClients.size}`)
    socket.on("message", (data) => {
      connectionEpoch.run(extensionGeneration, () => Effect.runPromise(shutdownControl.trackTransport(handleCdpMessage(socket, data.toString())))).catch((error: unknown) => {
        sendCdpResponse(socket, {
          id: 0,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    })
    socket.on("close", () => {
      debugLog?.(`client- ${cdpClients.sessionId(socket) ?? "raw"} total=${cdpClients.size - 1}`)
      const idleGeneration = cdpClients.unregister(socket)
      if (idleGeneration !== undefined && !shutdownControl.stopping) {
        Effect.runPromise(shutdownControl.trackTransport(cdpRuntime.disableIdle(() => cdpClients.isCurrentIdleGeneration(idleGeneration))).pipe(Effect.ignore)).catch((error: unknown) => {
          console.error("Failed to reset idle runtime domains", error)
        })
      }
    })
  }

  const close = cleanup()

  const closeTargetByTargetId = Effect.fnUntraced(function* (targetId: string) {
    const target = registry.targetsByTargetId.get(targetId)
    if (!target) {
      return
    }
    yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } })
    detachTargetState(target.tabId)
  })

  function acceptExtensionHello(socket: WebSocket, raw: string): number | undefined {
    const message = parseJsonObject(raw)
    if (!isExtensionEvent(message) || message.method !== "hello") {
      return undefined
    }
    const protocol = extensionProtocolCompatibility(message.params?.protocolVersion)
    if (!protocol.compatible && extensionRpc.protocolCompatible === true) {
      socket.close(4003, "Extension protocol incompatible")
      return extensionGeneration
    }
    // Protect an OPEN compatible connection, including its inventory handshake.
    // Competing browser retries must not erase targets, handoffs, or pending RPCs.
    if (extensionRpc.acceptsEvents) {
      rejectedExtensionConnections += 1
      extensionRpc.probeLiveness()
      socket.close(4004, "Another connection for this browser profile is already active")
      return extensionGeneration
    }
    const retiringGeneration = extensionGeneration
    extensionGeneration += 1
    rejectedExtensionConnections = 0
    clearLiveExtensionState("Extension replaced", retiringGeneration)
    extensionRpc.replaceSocket(socket)
    extensionRpc.markHandshake(
      typeof message.params?.version === "string" ? message.params.version : undefined,
      message.params?.protocolVersion,
    )
    const announcedName = typeof message.params?.profileName === "string" ? message.params.profileName.trim().slice(0, 100) : undefined
    if (announcedName && announcedName !== profileName) {
      profileName = announcedName
      void Effect.runPromise(sessions.setProfileName(announcedName)).catch((error) => console.error("Persist browser profile name failed", error))
    }
    if (protocol.legacy) {
      extensionRpc.markReady()
    }
    return extensionGeneration
  }

  function handleExtensionMessage(socket: WebSocket, raw: string, generation: number, announcedRootTabIds: Set<number>): void {
    const message = parseJsonObject(raw)
    if (isExtensionResponse(message)) {
      extensionRpc.handleResponse(message)
      return
    }

    if (!isExtensionEvent(message)) {
      return
    }
    const extensionMethod = message.method as string
    if (extensionMethod === "hello") {
      return
    }
    if (extensionMethod === "log") {
      const text = typeof message.params?.message === "string" ? message.params.message : undefined
      if (!text) return
      const level = message.params?.level === "error" || message.params?.level === "warn" ? message.params.level : "log"
      console[level](`[browser-control extension] ${text}`)
      return
    }
    if (extensionMethod === "ready") {
      void Effect.runPromise(rootLifecycle.settle(generation)).then((reconciled) => {
        if (!extensionRpc.isCurrent(socket) || generation !== extensionGeneration) return
        if (reconciled) {
          for (const target of registry.listRootTargets()) {
            if (!announcedRootTabIds.has(target.tabId)) detachTargetState(target.tabId)
          }
          extensionRpc.markReady()
          for (const target of registry.listRootTargets()) refreshTabGrouping(target.tabId)
        } else {
          socket.close(1011, "Target inventory reconciliation failed")
        }
      })
      return
    }
    if (extensionMethod === "debugger.attached") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      if (tabId) {
        announcedRootTabIds.add(tabId)
        rootLifecycle.queue({ tabId, attachIfMissing: true, verificationRetries: 0, errorMessage: "Debugger re-announce failed", generation })
      }
      return
    }
    if (extensionMethod === "toolbar.clicked") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      if (tabId) {
        announcedRootTabIds.add(tabId)
        handleToolbarClick(tabId)
      }
      return
    }
    if (extensionMethod === "handoff.completed") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      const handoffId = typeof message.params?.handoffId === "string" ? message.params.handoffId : undefined
      const target = tabId ? registry.tabTargets.get(tabId) : undefined
      if (target && handoffId) {
        const completed = handoffs.complete({
          id: handoffId,
          tabId: target.tabId,
          targetId: target.targetInfo.targetId,
          targetSessionId: target.sessionId,
        })
        if (completed) {
          refreshPageStatus(target.tabId)
        }
      }
      return
    }
    if (extensionMethod === "pageStatus.requested") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      if (tabId) {
        refreshPageStatus(tabId)
      }
      return
    }
    if (extensionMethod === "debugger.detached") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      const detachedSessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined
      const reason = typeof message.params?.reason === "string" ? message.params.reason : undefined
      if (detachedSessionId) {
        suppressedChildSessions.delete(detachedSessionId)
        detachChildTargetState(detachedSessionId)
        return
      }
      if (reason === "target_closed") {
        if (tabId) {
          rootLifecycle.queue({ tabId, attachIfMissing: false, verificationRetries: 3, errorMessage: "Failed to reconcile ambiguous debugger detach" })
        }
        return
      }
      if (tabId) {
        detachTargetState(tabId)
      }
      return
    }
    if (extensionMethod === "tabs.removed") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      if (tabId) {
        detachTargetState(tabId)
      }
      return
    }
    if (extensionMethod === "recording.cancelled") {
      recordingRelay.handleRecordingCancelled(message)
      return
    }
    if (extensionMethod !== "debugger.event") {
      return
    }

    const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
    if (!tabId) {
      return
    }
    const target = registry.routingRootTarget(tabId)
    if (!target) {
      return
    }
    const method = typeof message.params?.method === "string" ? message.params.method : ""
    const params = getObject(message.params?.params)
    const sourceSessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined
    debugLog?.(`evt tab=${tabId} ${method} src=${sourceSessionId ?? "root"}`)
    const sourceChild = sourceSessionId ? registry.childTargets.get(sourceSessionId) : undefined
    if (sourceSessionId && sourceSessionId !== target.sessionId && !sourceChild) {
      return
    }
    if (
      sourceSessionId &&
      method !== "Target.attachedToTarget" &&
      method !== "Target.detachedFromTarget" &&
      method !== "Target.targetInfoChanged" &&
      (suppressedChildSessions.has(sourceSessionId) || (sourceChild && !shouldExposeChildTarget(sourceChild)))
    ) {
      return
    }
    if (recordingRelay.handleDebuggerEvent({ tabId, method, params })) {
      return
    }
    let shouldBroadcast = true
    let attachedChildTarget: ChildTarget | undefined

    if ((method === "Inspector.targetCrashed" || method === "Target.targetCrashed") && (sourceSessionId === undefined || sourceSessionId === target.sessionId)) {
      const crashedTarget = registry.markRootTargetCrashed(tabId)
      if (crashedTarget) {
        cancelTargetHandoffs(crashedTarget, "target-crashed")
        const affectedSessions = sessions.markTargetCrashed(crashedTarget.targetInfo.targetId)
        extensionRpc.rejectDebuggerCommandsForTab(tabId, new Error(`Target crashed: ${crashedTarget.targetInfo.targetId}`))
        contextDebugLog?.(`target-crashed ${targetDiagnosticIdentity(crashedTarget)} affectedSessions=${affectedSessions.length}`)
      }
    }
    if (method === "Target.attachedToTarget") {
      const childSessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (childSessionId && !targetInfo) {
        if (params?.waitingForDebugger === true) {
          Effect.runPromise(
            sendDebuggerCommand({
              tabId,
              sessionId: childSessionId,
              method: "Runtime.runIfWaitingForDebugger",
              params: {},
            }).pipe(Effect.ignore),
          ).catch((error: unknown) => {
            console.error("Failed to resume unsupported target", error)
          })
        }
        return
      }
      if (childSessionId && targetInfo) {
        if (isRestrictedTarget(targetInfo)) {
          suppressedChildSessions.set(childSessionId, tabId)
          if (params?.waitingForDebugger === true) {
            Effect.runPromise(
              sendDebuggerCommand({
                tabId,
                sessionId: childSessionId,
                method: "Runtime.runIfWaitingForDebugger",
                params: {},
              }).pipe(Effect.ignore),
            ).catch((error: unknown) => {
              console.error("Failed to resume restricted target", error)
            })
          }
          return
        }
        suppressedChildSessions.delete(childSessionId)
        shouldBroadcast = false
        const parentSessionId = sourceSessionId ?? target.sessionId
        const childTarget: ChildTarget = {
          tabId,
          sessionId: childSessionId,
          parentSessionId,
          targetInfo,
          waitingForDebugger: params?.waitingForDebugger === true,
        }
        for (const previous of registry.addChildTarget(childTarget)) {
          cdpClients.detachTarget(previous)
        }
        contextDebugLog?.(`target-attached kind=child parentSession=${boundedToken(parentSessionId)} ${targetDiagnosticIdentity(childTarget)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
        if (shouldExposeChildTarget(childTarget)) {
          attachedChildTarget = childTarget
        }
      }
    }
    if (method === "Target.detachedFromTarget") {
      const childSessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined
      if (childSessionId) {
        shouldBroadcast = false
        suppressedChildSessions.delete(childSessionId)
        contextDebugLog?.(`target-detached kind=child ${targetDiagnosticIdentity(registry.childTargets.get(childSessionId))}`)
        detachChildTargetState(childSessionId)
      }
    }
    if (method === "Target.targetInfoChanged") {
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (!targetInfo) {
        return
      }
      const childTarget = registry.childTargetsByTargetId.get(targetInfo.targetId)
      const wasExposed = childTarget ? shouldExposeChildTarget(childTarget) : false
      if (isRestrictedTarget(targetInfo)) {
        if (childTarget) {
          suppressedChildSessions.set(childTarget.sessionId, tabId)
          detachChildTargetState(childTarget.sessionId)
        }
        return
      }
      const changed = registry.updateConnectedTargetInfo({ tabId, targetInfo })
      if (!changed) {
        const currentRoot = registry.routingRootTarget(tabId)
        if (targetInfo.type === "page" && currentRoot && currentRoot.targetInfo.targetId !== targetInfo.targetId) {
          rootLifecycle.queue({ tabId, attachIfMissing: false, verificationRetries: 1, errorMessage: "Failed to reconcile changed root target info" })
        }
        return
      }
      contextDebugLog?.(`target-info-changed ${targetDiagnosticIdentity(changed.target)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
      if (changed.kind === "child" && !wasExposed && shouldExposeChildTarget(changed.target)) {
        announceAttachedChildTarget(target.sessionId, changed.target)
      }
    } else if (method.startsWith("Target.") && params?.targetInfo !== undefined) {
      const eventTargetInfo = getTargetInfo(params.targetInfo)
      if (!eventTargetInfo || isRestrictedTarget(eventTargetInfo)) {
        return
      }
    }
    if (method === "Page.frameNavigated") {
      const frame = getObject(params?.frame)
      if (typeof frame?.url === "string" && typeof frame.parentId !== "string" && (sourceSessionId === undefined || sourceSessionId === target.sessionId)) {
        if (typeof frame.id === "string") {
          mainFrameIdsByTab.set(tabId, frame.id)
        }
        contextDebugLog?.(`main-frame-navigated frame=${boundedToken(typeof frame.id === "string" ? frame.id : undefined)} loader=${boundedToken(typeof frame.loaderId === "string" ? frame.loaderId : undefined)} ${targetDiagnosticIdentity(target)} ${summarizeDiagnosticUrl(frame.url)}`)
        registry.updateTargetUrl(tabId, frame.url)
      }
      if (typeof frame?.id === "string" && typeof frame.parentId === "string" && params) {
        registry.rememberFrameEvent({ tabId, frameId: frame.id, navigated: params })
      }
    }
    if (method === "Page.navigatedWithinDocument") {
      const frameId = typeof params?.frameId === "string" ? params.frameId : undefined
      const url = typeof params?.url === "string" ? params.url : undefined
      if (frameId && frameId === mainFrameIdsByTab.get(tabId)) {
        contextDebugLog?.(`main-frame-same-document frame=${boundedToken(frameId)} ${targetDiagnosticIdentity(target)} ${summarizeDiagnosticUrl(url)}`)
      }
    }
    if (method === "Page.lifecycleEvent") {
      const frameId = typeof params?.frameId === "string" ? params.frameId : undefined
      if (frameId && frameId === mainFrameIdsByTab.get(tabId)) {
        contextDebugLog?.(`main-frame-lifecycle name=${boundedToken(typeof params?.name === "string" ? params.name : undefined)} frame=${boundedToken(frameId)} loader=${boundedToken(typeof params?.loaderId === "string" ? params.loaderId : undefined)} ${targetDiagnosticIdentity(target)}`)
      }
    }
    if (method === "Page.frameAttached") {
      const frameId = typeof params?.frameId === "string" ? params.frameId : undefined
      if (frameId && params) {
        registry.rememberFrameEvent({ tabId, frameId, attached: params })
      }
    }
    if (method === "Page.frameDetached") {
      const frameId = typeof params?.frameId === "string" ? params.frameId : undefined
      if (frameId) {
        registry.tabFrameEvents.get(tabId)?.delete(frameId)
      }
    }

    const eventSessionId = sourceSessionId ?? target.sessionId
    const event: CdpEvent = { method, ...(params === undefined ? {} : { params }), sessionId: eventSessionId }
    if (method === "Runtime.executionContextCreated") {
      const context = getObject(params?.context)
      const auxData = getObject(context?.auxData)
      const contextTarget = targetForCdpSession(tabId, eventSessionId)
      contextDebugLog?.(`context-created id=${boundedToken(typeof context?.id === "number" || typeof context?.id === "string" ? String(context.id) : undefined)} unique=${boundedToken(typeof context?.uniqueId === "string" ? context.uniqueId : undefined)} default=${auxData?.isDefault === true} type=${boundedToken(typeof auxData?.type === "string" ? auxData.type : undefined)} frame=${boundedToken(typeof auxData?.frameId === "string" ? auxData.frameId : undefined)} ${targetDiagnosticIdentity(contextTarget)} ${summarizeDiagnosticUrl(typeof context?.origin === "string" ? context.origin : undefined)}`)
      const cursorPosition = ghostCursorPositionsByTab.get(tabId)
      if (cursorPosition && auxData?.isDefault === true && auxData.frameId === mainFrameIdsByTab.get(tabId)) {
        Effect.runPromise(Effect.ignore(sendDebuggerCommand({
          tabId,
          method: "Runtime.evaluate",
          params: { expression: ghostCursorRestoreExpression(cursorPosition) },
        }))).catch(() => {})
      }
    } else if (method === "Runtime.executionContextDestroyed") {
      const contextTarget = targetForCdpSession(tabId, eventSessionId)
      contextDebugLog?.(`context-destroyed id=${boundedToken(typeof params?.executionContextId === "number" || typeof params?.executionContextId === "string" ? String(params.executionContextId) : undefined)} unique=${boundedToken(typeof params?.executionContextUniqueId === "string" ? params.executionContextUniqueId : undefined)} ${targetDiagnosticIdentity(contextTarget)}`)
    } else if (method === "Runtime.executionContextsCleared") {
      contextDebugLog?.(`contexts-cleared ${targetDiagnosticIdentity(targetForCdpSession(tabId, eventSessionId))}`)
    }
    cdpRuntime.notify(event)
    if (attachedChildTarget) {
      announceAttachedChildTarget(target.sessionId, attachedChildTarget)
      return
    }
    if (shouldBroadcast) {
      sendEventToTargetViewers(target.sessionId, event)
    }
  }

  function handleToolbarClick(tabId: number): void {
    const target = registry.tabTargets.get(tabId)
    if (target) {
      const sessionId = pageStatusSessionId(target) ?? activeHandoffSessionIdForTab(tabId)
      const action = toolbarClickAction({
        handoffPending: handoffs.pendingForTab(tabId) !== undefined,
        sessionExecuting: sessionId !== undefined && sessions.isExecuting(sessionId),
      })
      if (action === "ignore") {
        if (sessionId) {
          console.error(`Ignored toolbar detach for tab ${tabId}: session ${sessionId} is executing`)
        }
        return
      }
    }
    Effect.runPromise(shutdownControl.track(toggleTab(tabId))).catch((error: unknown) => {
      console.error("Toolbar toggle failed", error)
    })
  }

  const handleCdpMessage = Effect.fnUntraced(function* (socket: WebSocket, raw: string) {
    const message = parseJsonObject(raw)
    if (!isCdpRequest(message)) {
      return yield* Effect.fail(new Error("Invalid CDP request"))
    }

    debugLog?.(`cdp<- ${cdpClients.sessionId(socket) ?? "raw"} #${message.id} ${message.method} ${message.sessionId ?? ""}`)
    yield* Effect.matchEffect(routeCdpCommand(socket, message), {
      onFailure: (error) => {
        return Effect.sync(() => {
          const runtimeEvaluation = isRuntimeEvaluationMethod(message.method)
          const errorDetail = runtimeEvaluation ? runtimeFailureKind(error) : error.message
          debugLog?.(`cdp-> ${cdpClients.sessionId(socket) ?? "raw"} #${message.id} ${message.method} ERROR ${errorDetail}`)
          if (runtimeEvaluation) {
            contextDebugLog?.(`evaluation-failed method=${message.method} failure=${runtimeFailureKind(error)} client=${boundedToken(cdpClients.sessionId(socket) ?? "raw")} ${targetDiagnosticIdentity(diagnosticTargetForClient(socket, message.sessionId))} ${summarizeRuntimeEvaluate(message.params)}`)
          }
          sendCdpResponse(socket, {
            id: message.id,
            error: { message: error.message },
            ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
          })
        })
      },
      onSuccess: (result) => {
        return Effect.sync(() => {
          debugLog?.(`cdp-> ${cdpClients.sessionId(socket) ?? "raw"} #${message.id} ${message.method} ok`)
          const resultObject = getObject(result)
          const exceptionDetails = isRuntimeEvaluationMethod(message.method) ? getObject(resultObject?.exceptionDetails) : undefined
          if (exceptionDetails) {
            contextDebugLog?.(`evaluation-exception method=${message.method} exceptionId=${boundedToken(typeof exceptionDetails.exceptionId === "number" || typeof exceptionDetails.exceptionId === "string" ? String(exceptionDetails.exceptionId) : undefined)} line=${typeof exceptionDetails.lineNumber === "number" ? exceptionDetails.lineNumber : "none"} column=${typeof exceptionDetails.columnNumber === "number" ? exceptionDetails.columnNumber : "none"} client=${boundedToken(cdpClients.sessionId(socket) ?? "raw")} ${targetDiagnosticIdentity(diagnosticTargetForClient(socket, message.sessionId))} ${summarizeRuntimeEvaluate(message.params)}`)
          }
          sendCdpResponse(socket, {
            id: message.id,
            result,
            ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
          })
        })
      },
    })
  })

  const routeCdpCommand = Effect.fn("Relay.routeCdpCommand")(function* (socket: WebSocket, message: CdpRequest) {
    const clientBrowserControlSessionId = cdpClients.sessionId(socket)
    if (!shutdownControl.accepting && (!cdpClients.isSandbox(socket) || !clientBrowserControlSessionId || !sessions.hasPendingWork(clientBrowserControlSessionId))) {
      return yield* Effect.fail(new Error("Relay is draining for an explicit restart"))
    }
    const guardMessage = guardCdpMethod({
      method: message.method,
      readOnly: clientBrowserControlSessionId ? sessions.isReadOnly(clientBrowserControlSessionId) : false,
      sessionId: clientBrowserControlSessionId,
    })
    if (guardMessage) {
      return yield* Effect.fail(new Error(guardMessage))
    }
    if (message.method === "Browser.getVersion") {
      return {
        protocolVersion: "1.3",
        product: "Browser-Control/0.0.0",
        revision: "0",
        userAgent: "Browser-Control",
        jsVersion: "V8",
      }
    }
    if (message.method === "Browser.setDownloadBehavior") {
      return {}
    }
    if (message.method === "Target.setDiscoverTargets") {
      if (message.params?.discover === true) {
        replayTargetCreated({ socket, targetInfos: cdpRouter.visibleTargetInfos(socket) })
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && !message.sessionId) {
      cdpClients.setAutoAttachParams(socket, message.params)
      for (const target of cdpRouter.visibleRoots(socket)) {
        yield* Effect.ignore(sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} }))
        cdpClients.announce(socket, target)
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && message.sessionId && registry.targets.has(message.sessionId)) {
      const target = cdpRouter.rootForSession(socket, message.sessionId)
      if (!target) {
        return yield* Effect.fail(new Error(`Target not found: ${message.sessionId}`))
      }
      const result = yield* sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} })
      replayChildTargetsForParent({ socket, parentSessionId: target.sessionId, registry, clients: cdpClients })
      return result
    }
    if (message.method === "Target.getTargets") {
      return {
        targetInfos: cdpRouter.visibleTargetInfos(socket),
      }
    }
    if (message.method === "Target.attachToBrowserTarget") {
      return { sessionId: cdpClients.createBrowserAlias(socket) }
    }
    if (message.method === "Target.attachToTarget") {
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target = cdpRouter.targetForAttach(socket, targetId)
      if (target) {
        if (cdpClients.hasSession(socket, target.sessionId)) {
          return { sessionId: cdpClients.createTargetAlias(socket, target) }
        }
        cdpClients.announce(socket, target)
        if ("parentSessionId" in target) replayChildFrameNavigation({ socket, registry, target })
        return { sessionId: target.sessionId }
      }
      return yield* Effect.fail(new Error(`Target not found: ${targetId}`))
    }
    if (message.method === "Target.getTargetInfo") {
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target = cdpRouter.targetInfo(socket, {
        ...(targetId ? { targetId } : {}),
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      })
      if (!target) {
        if (!targetId && !message.sessionId) {
          return {}
        }
        return yield* Effect.fail(new Error(`Target not found: ${targetId || message.sessionId || "unknown"}`))
      }
      return { targetInfo: target.targetInfo }
    }
    if (message.method === "Target.createTarget" || message.method === "Target.closeTarget") {
      if (message.method === "Target.createTarget") {
        const url = typeof message.params?.url === "string" ? message.params.url : "about:blank"
        const browserControlSessionId = cdpClients.sessionId(socket)
        const autoAttachParams = cdpClients.autoAttachParams(socket)
        const target = yield* createAndAttachTab({
          url,
          active: false,
          ...(browserControlSessionId ? { browserControlSessionId } : {}),
          ...(autoAttachParams ? { autoAttachParams } : {}),
        })
        return { targetId: target.targetInfo.targetId }
      }
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target = cdpRouter.targetForAttach(socket, targetId)
      if (!target || !("owner" in target)) {
        return { success: false }
      }
      yield* closeTargetByTargetId(targetId)
      return { success: true }
    }
    if (message.method === "Target.detachFromTarget") {
      const childSessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined
      if (childSessionId) {
        cdpClients.detach(socket, childSessionId)
      }
      return {}
    }
    const normalizedMessage = removeDefaultLightColorSchemeEmulation(message)
    const browserAlias = message.sessionId !== undefined && cdpRouter.isBrowserAlias(socket, message.sessionId)
    const rootRoutable = isRootRoutableBrowserContextMethod(message.method) && (!message.sessionId || browserAlias)
    const preferredRoot = rootRoutable ? cdpRouter.preferredRoot(socket) : undefined
    const route = rootRoutable && preferredRoot
      ? { tabId: preferredRoot.tabId, rootSessionId: preferredRoot.sessionId }
      : message.sessionId
      ? cdpRouter.session(socket, message.sessionId)
      : undefined
    if (!route) {
      return yield* Effect.fail(new Error(rootRoutable
        ? clientBrowserControlSessionId === undefined
          ? `Exactly one visible root target is required for ${message.method}`
          : `A session-owned root target is required for ${message.method}`
        : message.sessionId
        ? `Unknown CDP session ${message.sessionId} for ${message.method}`
        : `CDP sessionId is required for ${message.method}`))
    }
    const { tabId } = route
    const command = {
      tabId,
      method: normalizedMessage.method,
      params: normalizedMessage.params ?? {},
      ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }),
    }
    const sessionId = message.sessionId
    const result = yield* (message.method === "Runtime.enable" && sessionId
      ? cdpRuntime.enable(route, command.params, () => cdpRouter.session(socket, sessionId) !== undefined)
      : sendDebuggerCommand(command))
    yield* applyGhostCursorMouseEvent({ tabId, message }).pipe(Effect.ignore)
    return result
  })

  function removeDefaultLightColorSchemeEmulation(message: CdpRequest): CdpRequest {
    if (message.method !== "Emulation.setEmulatedMedia") {
      return message
    }
    const features = Array.isArray(message.params?.features) ? message.params.features : []
    const hasDefaultLightColorScheme = features.some((feature) => {
      const object = getObject(feature)
      return object?.name === "prefers-color-scheme" && object.value === "light"
    })
    if (!hasDefaultLightColorScheme) {
      return message
    }
    return {
      ...message,
      params: {
        ...message.params,
        features: features.filter((feature) => {
          const object = getObject(feature)
          return object?.name !== "prefers-color-scheme"
        }),
      },
    }
  }

  const toggleTab = Effect.fnUntraced(function* (tabId: number) {
    if (registry.tabTargets.has(tabId)) {
      yield* sendToExtension({ method: "debugger.detach", params: { tabId } })
      detachTargetState(tabId)
      yield* Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: false } }))
      return
    }
    yield* rootLifecycle.attach({ tabId, owner: "user" })
  })

  const createAndAttachTab = Effect.fnUntraced(function* (options: {
    readonly url: string
    readonly active: boolean
    readonly browserControlSessionId?: string
    readonly autoAttachParams?: JsonObject
  }) {
    const result = yield* sendToExtension({ method: "tabs.create", params: { url: options.url, active: options.active } })
    const tabId = typeof result.tabId === "number" ? result.tabId : undefined
    if (!tabId) {
      return yield* Effect.fail(new Error("tabs.create did not return a tabId"))
    }
    return yield* rootLifecycle.attach({
      tabId,
      owner: "relay",
      ...(options.browserControlSessionId ? { browserControlSessionId: options.browserControlSessionId } : {}),
      ...(options.autoAttachParams ? { autoAttachParams: options.autoAttachParams } : {}),
    })
  })

  // Profile construction is synchronous so hello inventory events cannot race it.
  // The explicit scope owns all lifecycle workers until this profile is closed.
  const lifecycleScope = Effect.runSync(Scope.make())
  const rootLifecycle = Effect.runSync(RootTargetLifecycle.make({
    registry,
    sessions,
    handoffs,
    clients: cdpClients,
    extension: { generation: () => extensionGeneration, send: sendToExtension },
    presentation: {
      replaced: recordRootReplacement,
      committed: presentAttachedTarget,
      announceRoot: announceAttachedTarget,
      announceChild: announceAttachedChildTarget,
    },
    reportError: (message, error) => console.error(message, error),
  }).pipe(Scope.provide(lifecycleScope)))

  function presentAttachedTarget(committedTarget: ConnectedTarget): void {
    const tabId = committedTarget.tabId
    mainFrameIdsByTab.set(tabId, committedTarget.targetInfo.targetId)
    contextDebugLog?.(`target-attached kind=root ${targetDiagnosticIdentity(committedTarget)} ${summarizeDiagnosticUrl(committedTarget.targetInfo.url)}`)
    if (committedTarget.browserControlSessionId) {
      pruneInvisibleAnnouncementsForSession(committedTarget.browserControlSessionId)
    }
    if (extensionRpc.connected) {
      refreshTabGrouping(tabId)
    }
    const pendingHandoff = handoffs.pendingForTab(tabId)
    if (pendingHandoff) {
      setActivityForTarget(committedTarget, "waiting", waitingBadge(pendingHandoff.message), {
        sessionId: pendingHandoff.sessionId,
        message: pendingHandoff.message,
        handoffId: pendingHandoff.id,
      })
    } else {
      sendPageStatus(committedTarget, committedTarget.browserControlSessionId && sessions.isExecuting(committedTarget.browserControlSessionId) ? "running" : "attached")
    }
  }

  const applyGhostCursorMouseEvent = Effect.fnUntraced(function* (options: { readonly tabId: number; readonly message: CdpRequest }) {
    if (options.message.method !== "Input.dispatchMouseEvent") {
      return
    }
    const action = inputDispatchMouseEventToGhostCursorAction(options.message.params)
    if (!action) {
      return
    }
    ghostCursorPositionsByTab.set(options.tabId, { x: action.x, y: action.y })
    yield* sendDebuggerCommand({
      tabId: options.tabId,
      method: "Runtime.evaluate",
      params: { expression: ghostCursorMouseActionExpression(action) },
    })
  })

  function detachTargetState(tabId: number, options: {
    readonly preserveSessionTarget?: boolean
    readonly updateExtension?: boolean
  } = {}): void {
    rootLifecycle.invalidate(tabId)
    if (options.updateExtension !== false) {
      Effect.runPromise(Effect.ignore(sendToExtension({ method: "pageStatus.clear", params: { tabId } }))).catch(() => {})
      scheduleTabGrouping(tabId, "tabs.ungroup")
      Effect.runPromise(Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: false } }))).catch(() => {})
      void recordingRelay.abortRecordingForTab({ tabId, reason: "Tab detached" }).catch((error: unknown) => {
        console.error("Failed to abort recording for detached tab", error)
      })
    }
    const detached = registry.detachRootTargetState(tabId)
    if (!detached) {
      return
    }
    cancelTargetHandoffs(detached.target, "target-detached")
    if (!options.preserveSessionTarget) sessions.markTargetDetached(detached.target.targetInfo.targetId)
    cdpClients.detachTab(tabId, { destroyed: true })
    mainFrameIdsByTab.delete(tabId)
    ghostCursorPositionsByTab.delete(tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === tabId) {
        suppressedChildSessions.delete(sessionId)
      }
    }
    contextDebugLog?.(`target-detached kind=root ${targetDiagnosticIdentity(detached.target)}`)
  }

  function recordRootReplacement(change: Extract<RootTargetChange, { readonly kind: "replaced" }>): void {
    mainFrameIdsByTab.delete(change.target.tabId)
    ghostCursorPositionsByTab.delete(change.target.tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === change.target.tabId) suppressedChildSessions.delete(sessionId)
    }
    contextDebugLog?.(`target-replaced kind=root old=${targetDiagnosticIdentity(change.previous)} new=${targetDiagnosticIdentity(change.target)}`)
  }

  function detachChildTargetState(sessionId: string): void {
    const detached = registry.detachChildTargetState(sessionId)
    if (detached) {
      cdpClients.detachTarget(detached)
    }
  }

  // Deliver a session-scoped event only to clients that have been told about
  // the tab's root target. Broadcasting to every client lets concurrently
  // connected sandboxes attach to each other's pages and interfere.
  function sendEventToTargetViewers(rootSessionId: string, event: CdpEvent): void {
    cdpClients.sendToViewers(rootSessionId, event, (client, tabId) => cdpRouter.canSeeTab(client, tabId))
  }

  function pruneInvisibleAnnouncementsForSession(browserControlSessionId: string): void {
    for (const client of cdpClients) {
      if (cdpClients.sessionId(client) === browserControlSessionId) {
        cdpRouter.reconcileClient(client)
      }
    }
  }

  function reconcileTargetOwnership(change: TargetOwnershipChange): void {
    for (const client of cdpClients) {
      cdpRouter.reconcileClient(client)
    }
    for (const targetId of change.targetIds) {
      const target = registry.targetsByTargetId.get(targetId)
      if (target) {
        announceAttachedTarget(target)
      }
    }
    for (const tabId of change.tabIds) {
      refreshTabPresentation(tabId)
    }
  }

  function announceAttachedTarget(target: ConnectedTarget): void {
    for (const client of cdpClients) {
      if (cdpRouter.canSeeTarget(client, target)) {
        cdpClients.announce(client, target)
      }
    }
  }

  function announceAttachedChildTarget(rootSessionId: string, target: ChildTarget): void {
    for (const client of cdpClients) {
      if (cdpClients.hasSession(client, rootSessionId) && cdpRouter.canSeeTab(client, target.tabId)) {
        cdpClients.announce(client, target)
      }
    }
  }

  return {
    profileId: options.profileId,
    get profileName() { return profileName },
    registry,
    sessions,
    recordingRelay,
    renameProfile: async (name) => {
      const normalized = name.trim()
      if (!normalized || normalized.length > 100) throw new HttpRouteError({ message: "Browser profile name must be 1–100 characters", status: 400, code: "invalid-request" })
      if (!extensionRpc.connected) throw new HttpRouteError({ message: `Browser profile ${options.profileId} is not connected`, status: 409, code: "profile-not-found" })
      const generation = extensionGeneration
      await connectionEpoch.run(generation, () => Effect.runPromise(sendToExtension({ method: "profile.rename", params: { name: normalized } })))
      if (generation !== extensionGeneration) throw new Error("Extension changed while renaming browser profile")
      profileName = normalized
      await Effect.runPromise(sessions.setProfileName(normalized))
      return { id: options.profileId, name: normalized, connected: extensionRpc.connected, version: extensionRpc.version ?? null, activeTargets: registry.rootTargetCount() }
    },
    extensionStatus,
    hasRawClients: () => Array.from(cdpClients).some((client) => !cdpClients.isSandbox(client)),
    settle: () => rootLifecycle.settle(),
    isIdle: () => rootLifecycle.isIdle(),
    isInventoryPending: () => extensionRpc.acceptsEvents && !extensionRpc.connected,
    acceptExtension,
    acceptCdp,
    reconcileTransferredTarget: (sessionId) => {
      const durable = sessions.sessions.get(sessionId)?.target
      const target = durable ? registry.targetsByTargetId.get(durable.id) : undefined
      if (!durable || !target || target.browserControlSessionId !== sessionId) return
      registry.addRootTarget({ ...target, owner: durable.owner })
      reconcileTargetOwnership({ targetIds: [durable.id], tabIds: [target.tabId] })
    },
    close: () => close,
  }
}

function sendUpgradeError(options: {
  readonly socket: stream.Duplex
  readonly status: 400 | 403 | 404 | 409 | 503
  readonly message: string
}): void {
  const statusText = options.status === 400 ? "Bad Request" : options.status === 403 ? "Forbidden" : options.status === 409 ? "Conflict" : options.status === 503 ? "Service Unavailable" : "Not Found"
  options.socket.write(
    `HTTP/1.1 ${options.status} ${statusText}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${options.message}`,
  )
  options.socket.destroy()
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return Buffer.from(data)
}
