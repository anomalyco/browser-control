import http from "node:http"
import { AsyncLocalStorage } from "node:async_hooks"
import stream from "node:stream"
import crypto from "node:crypto"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { Clock, Config, Effect, Fiber, Semaphore } from "effect"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import {
  hasAnnouncedSession,
  removeAnnouncedSession,
  replayChildFrameNavigation,
  replayChildTargetsForParent,
  replayTargetCreated,
  sendAttachedToChildTarget,
  sendAttachedToTarget,
} from "./cdp-shims.ts"
import { CdpClientPool } from "./cdp-client-pool.ts"
import { CdpRouter, isRootRoutableBrowserContextMethod } from "./cdp-router.ts"
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
import { ghostCursorClientSource, ghostCursorMouseActionExpression, ghostCursorRestoreExpression, inputDispatchMouseEventToGhostCursorAction } from "./ghost-cursor.ts"
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
import { boundedToken, runtimeFailureKind, summarizeDiagnosticUrl, summarizeRuntimeEvaluate } from "./runtime-diagnostics.ts"
import { shouldExposeChildTarget, TargetRegistry, type RootTargetChange, type TargetOwnershipChange } from "./target-registry.ts"
import { browserControlVersion } from "./version.ts"
import type { BrowserProfileSummary } from "./relay-schema.ts"

export type { RelayServer } from "./relay-types.ts"

export const startRelay = Effect.fn("Relay.start")(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
  readonly shutdown?: () => void
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
  readonly shutdown?: () => void
} = {}) {
  const host = defaultHost
  const port = options.port ?? defaultPort
  const browserId = crypto.randomUUID()
  const endpointUrl = `http://${formatHostForUrl(host)}:${port}`
  const debugEnabled = yield* Config.boolean("BROWSER_CONTROL_DEBUG").pipe(Config.withDefault(false))
  const managed = options.shutdown !== undefined
    && (yield* Config.boolean("BROWSER_CONTROL_MANAGED_RELAY").pipe(Config.withDefault(false)))
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
  const createProfile = (profileId: string, profileName?: string): ProfileRuntime => {
    const existing = runtimes.get(profileId)
    if (existing) return existing
    const runtime = makeProfileRuntime({
      endpointUrl,
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
    shutdown: options.shutdown ?? (() => {}),
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
    if (!extension) {
      try {
        const profileId = requestUrl.searchParams.get("profileId") ?? headerValue(request.headers["browser-control-profile-id"])
        selected = profiles.select({ ...(profileId !== undefined ? { profileId } : {}), ...(sessionId ? { sessionId } : {}) }) as ProfileRuntime
      } catch (error) {
        sendUpgradeError({ socket, status: error instanceof HttpRouteError && error.status === 404 ? 404 : 409, message: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (selected) {
        selected.acceptCdp(websocket, sessionId)
        return
      }
      const helloTimeout = setTimeout(() => websocket.close(4002, "Extension hello required"), 10_000)
      websocket.once("close", () => clearTimeout(helloTimeout))
      websocket.once("message", (data, isBinary) => {
        clearTimeout(helloTimeout)
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
  readonly acceptCdp: (socket: WebSocket, sessionId: string | undefined) => void
  readonly reconcileTransferredTarget: (sessionId: string) => void
  readonly isInventoryPending: () => boolean
  readonly close: () => Effect.Effect<void>
}

function makeProfileRuntime(options: {
  readonly endpointUrl: string
  readonly profileId: string
  readonly profileName?: string
  readonly releaseTargetGraceMs: number
  readonly debugEnabled: boolean
  readonly restoredSessions: readonly PersistedSession[]
  readonly onSessionsChanged: (entries: readonly PersistedSession[]) => Promise<void>
  readonly isSessionIdTaken: (id: string) => boolean
}): ProfileRuntime {
  const { endpointUrl, releaseTargetGraceMs } = options
  let profileName = options.profileName
  const registry = new TargetRegistry()
  const rootLifecycleSemaphores = new Map<number, Semaphore.Semaphore>()
  type RootReconciliationWorker = {
    attachIfMissing: boolean
    generation: number
    pending: boolean
    promise: Promise<boolean>
    verificationRetries: number
  }
  const rootReconciliationWorkers = new Map<string, RootReconciliationWorker>()
  type TabGroupingMethod = "tabs.group" | "tabs.ungroup"
  const pendingTabGrouping = new Map<number, TabGroupingMethod>()
  const tabGroupingWorkers = new Map<number, Promise<void>>()
  let relayClosing = false
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
    const result = yield* extensionRpc.send(command)
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
  class ProfileRecordingRelay extends RecordingRelay {
    override startRecording(...args: Parameters<RecordingRelay["startRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => super.startRecording(...args))
    }
    override stopRecording(...args: Parameters<RecordingRelay["stopRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => super.stopRecording(...args))
    }
    override statusRecording(...args: Parameters<RecordingRelay["statusRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => super.statusRecording(...args))
    }
    override cancelRecording(...args: Parameters<RecordingRelay["cancelRecording"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => super.cancelRecording(...args))
    }
    override cleanupAll(...args: Parameters<RecordingRelay["cleanupAll"]>) {
      return connectionEpoch.run(connectionEpoch.getStore() ?? extensionGeneration, () => super.cleanupAll(...args))
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
    (id) =>
      new ExecuteSandbox({
        endpointUrl,
        sessionId: id,
        onDefaultTargetChange: (target) => {
          sessions.updateTarget(id, target)
        },
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
    const worker = (async () => {
      while (true) {
        const next = pendingTabGrouping.get(tabId)
        if (!next) return
        pendingTabGrouping.delete(tabId)
        await Effect.runPromise(Effect.ignore(sendToExtension({ method: next, params: { tabId } })))
      }
    })().finally(() => {
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
  const cdpClients = new CdpClientPool<WebSocket>()
  const cdpRouter = new CdpRouter(cdpClients, registry)
  const runtimeContextWaiters = new Set<(event: CdpEvent) => void>()
  let nextTargetSessionId = 1
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

  const runRuntimeResetCommand = Effect.fnUntraced(function* (options: {
    readonly phase: string
    readonly tabId: number
    readonly sessionId?: string
    readonly method: "Runtime.disable" | "Runtime.enable"
    readonly params: JsonObject
  }) {
    const target = targetForCdpSession(options.tabId, options.sessionId)
    contextDebugLog?.(`runtime-reset phase=${options.phase} command=${options.method} ${targetDiagnosticIdentity(target)}`)
    return yield* Effect.matchEffect(
      sendDebuggerCommand({
        tabId: options.tabId,
        method: options.method,
        params: options.params,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      }),
      {
        onFailure: (error) => Effect.sync(() => {
          contextDebugLog?.(`runtime-reset phase=${options.phase} command=${options.method} outcome=failed failure=${runtimeFailureKind(error)} ${targetDiagnosticIdentity(target)}`)
          return false
        }),
        onSuccess: () => Effect.sync(() => {
          contextDebugLog?.(`runtime-reset phase=${options.phase} command=${options.method} outcome=ok ${targetDiagnosticIdentity(target)}`)
          return true
        }),
      },
    )
  })

  const cleanup = Effect.fnUntraced(function* () {
    relayClosing = true
    handoffs.cancelAll()
    extensionRpc.rejectPending(new Error("Relay closed"))
    yield* Effect.promise(() => Promise.allSettled(
      Array.from(rootReconciliationWorkers.values(), (worker) => worker.promise),
    )).pipe(Effect.asVoid)
    yield* Effect.tryPromise(() => recordingRelay.cleanupAll("Relay closed")).pipe(Effect.ignore)
    yield* sessions.closeAll()
    for (const socket of cdpClients) {
      socket.close()
    }
    extensionRpc.close()
    rootLifecycleSemaphores.clear()
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

  function acceptCdp(socket: WebSocket, browserControlSessionId: string | undefined): void {
    cdpClients.register(socket, browserControlSessionId)
    debugLog?.(`client+ ${browserControlSessionId ?? "raw"} total=${cdpClients.size}`)
    socket.on("message", (data) => {
      connectionEpoch.run(extensionGeneration, () => Effect.runPromise(handleCdpMessage(socket, data.toString()))).catch((error: unknown) => {
        sendCdpResponse(socket, {
          id: 0,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    })
    socket.on("close", () => {
      debugLog?.(`client- ${cdpClients.sessionId(socket) ?? "raw"} total=${cdpClients.size - 1}`)
      const idleGeneration = cdpClients.unregister(socket)
      if (idleGeneration !== undefined) {
        Effect.runPromise(disableRuntimeForIdleTargets(idleGeneration).pipe(Effect.ignore)).catch((error: unknown) => {
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
      const workers = Array.from(rootReconciliationWorkers.values())
        .filter((worker) => worker.generation === generation)
        .map((worker) => worker.promise)
      void Promise.all(workers).then((reconciled) => {
        if (!extensionRpc.isCurrent(socket) || generation !== extensionGeneration) return
        if (reconciled.every(Boolean)) {
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
        queueRootReconciliation(tabId, true, 0, "Debugger re-announce failed", generation)
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
          queueRootReconciliation(tabId, false, 3, "Failed to reconcile ambiguous debugger detach")
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
        if (registry.childTargets.has(childSessionId)) {
          registry.updateChildTargetInfo(targetInfo)
        }
        const parentSessionId = sourceSessionId ?? target.sessionId
        if (!registry.childTargets.has(childSessionId)) {
          const childTarget: ChildTarget = {
            tabId,
            sessionId: childSessionId,
            parentSessionId,
            targetInfo,
            waitingForDebugger: params?.waitingForDebugger === true,
          }
          registry.addChildTarget(childTarget)
          contextDebugLog?.(`target-attached kind=child parentSession=${boundedToken(parentSessionId)} ${targetDiagnosticIdentity(childTarget)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
        }
        const childTarget = registry.childTargets.get(childSessionId)
        if (childTarget && shouldExposeChildTarget(childTarget)) {
          attachedChildTarget = childTarget
        }
      }
    }
    if (method === "Target.detachedFromTarget") {
      const childSessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined
      if (childSessionId) {
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
          detachChildTargetState(childTarget.sessionId, true)
        }
        return
      }
      const changed = registry.updateConnectedTargetInfo({ tabId, targetInfo })
      if (!changed) {
        const currentRoot = registry.routingRootTarget(tabId)
        if (targetInfo.type === "page" && currentRoot && currentRoot.targetInfo.targetId !== targetInfo.targetId) {
          queueRootReconciliation(tabId, false, 1, "Failed to reconcile changed root target info")
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
    notifyRuntimeContextWaiters(event)
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
    Effect.runPromise(toggleTab(tabId)).catch((error: unknown) => {
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
        sendAttachedToTarget({ socket, announcements: cdpClients.announcements(socket), target, onDuplicateTarget: logDuplicateTargetAnnouncement })
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && message.sessionId && registry.targets.has(message.sessionId)) {
      const target = cdpRouter.rootForSession(socket, message.sessionId)
      if (!target) {
        return yield* Effect.fail(new Error(`Target not found: ${message.sessionId}`))
      }
      const result = yield* sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} })
      replayChildTargetsForParent({ socket, parentSessionId: target.sessionId, registry, announcements: cdpClients.announcements(socket), onDuplicateTarget: logDuplicateTargetAnnouncement })
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
      if (target && "owner" in target) {
        if (hasAnnouncedSession(cdpClients.announcements(socket), target.sessionId)) {
          return { sessionId: cdpClients.createTargetAlias(socket, target, target.sessionId) }
        }
        sendAttachedToTarget({ socket, announcements: cdpClients.announcements(socket), target, onDuplicateTarget: logDuplicateTargetAnnouncement })
        return { sessionId: target.sessionId }
      }
      if (target) {
        if (hasAnnouncedSession(cdpClients.announcements(socket), target.sessionId)) {
          return { sessionId: cdpClients.createTargetAlias(socket, target, target.parentSessionId) }
        }
        sendAttachedToChildTarget({ socket, announcements: cdpClients.announcements(socket), target, onDuplicateTarget: logDuplicateTargetAnnouncement })
        replayChildFrameNavigation({ socket, registry, target })
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
        if (cdpClients.deleteAlias(socket, childSessionId)) {
          return {}
        }
        removeAnnouncedSession(cdpClients.announcements(socket), childSessionId)
      }
      return {}
    }
    const normalizedMessage = removeDefaultLightColorSchemeEmulation(message)
    if (message.method === "Runtime.enable" && message.sessionId) {
      const sessionId = message.sessionId
      const route = cdpRouter.session(socket, sessionId)
      if (!route) {
        return yield* Effect.fail(new Error(`Unknown CDP session ${sessionId} for ${message.method}`))
      }
      const { tabId } = route
      const chromeSessionId = route.chromeSessionId ? { sessionId: route.chromeSessionId } : {}
      const contextSessionId = route.chromeSessionId ?? route.rootSessionId ?? sessionId
      contextDebugLog?.(`runtime-enable phase=client-request ${targetDiagnosticIdentity(targetForCdpSession(tabId, sessionId))}`)
      // Register the waiter before sending the enable so context events that
      // arrive during the command round trip are not missed.
      const contextWaiter = yield* Effect.forkChild(waitForDefaultRuntimeContext(contextSessionId), { startImmediately: true })
      const result = yield* sendDebuggerCommand({
        tabId,
        method: normalizedMessage.method,
        params: normalizedMessage.params ?? {},
        ...chromeSessionId,
      })
      const seenDefaultContext = yield* Fiber.join(contextWaiter)
      contextDebugLog?.(`runtime-enable phase=client-request defaultContextSeen=${seenDefaultContext} ${targetDiagnosticIdentity(targetForCdpSession(tabId, sessionId))}`)
      if (!seenDefaultContext) {
        // Chrome considered Runtime already enabled on the shared debugger
        // attachment, so it acknowledged the enable without re-emitting
        // Runtime.executionContextCreated and Playwright would wait forever
        // for an execution context. Kick a disable/enable cycle to force
        // re-emission; verified live to unstick hung page.evaluate calls.
        const retryWaiter = yield* Effect.forkChild(waitForDefaultRuntimeContext(contextSessionId), { startImmediately: true })
        contextDebugLog?.(`runtime-reset phase=missing-default-context attempt=start ${targetDiagnosticIdentity(targetForCdpSession(tabId, sessionId))}`)
        yield* runRuntimeResetCommand({ phase: "missing-default-context", tabId, method: "Runtime.disable", params: {}, ...chromeSessionId })
        yield* runRuntimeResetCommand({ phase: "missing-default-context", tabId, method: "Runtime.enable", params: normalizedMessage.params ?? {}, ...chromeSessionId })
        const retrySeenDefaultContext = yield* Fiber.join(retryWaiter)
        contextDebugLog?.(`runtime-reset phase=missing-default-context attempt=complete defaultContextSeen=${retrySeenDefaultContext} ${targetDiagnosticIdentity(targetForCdpSession(tabId, sessionId))}`)
      }
      return result
    }
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
    const result = yield* sendDebuggerCommand({
      tabId,
      method: normalizedMessage.method,
      params: normalizedMessage.params ?? {},
      ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }),
    })
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
    yield* attachTab({ tabId, owner: "user" })
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
    return yield* attachTab({
      tabId,
      owner: "relay",
      ...(options.browserControlSessionId ? { browserControlSessionId: options.browserControlSessionId } : {}),
      ...(options.autoAttachParams ? { autoAttachParams: options.autoAttachParams } : {}),
    })
  })

  const attachTabUnlocked = Effect.fnUntraced(function* (options: {
    readonly tabId: number
    readonly owner: "relay" | "user"
    readonly browserControlSessionId?: string
    readonly alreadyAttached?: boolean
    readonly autoAttachParams?: JsonObject
  }) {
    const { tabId } = options
    if (!options.alreadyAttached) {
      yield* sendToExtension({ method: "debugger.attach", params: { tabId } })
    }
    yield* sendDebuggerCommand({ tabId, method: "Page.enable", params: {} })
    yield* injectGhostCursor(tabId).pipe(Effect.ignore)
    const targetInfoResult = yield* sendDebuggerCommand({ tabId, method: "Target.getTargetInfo", params: {} })
    const targetInfo = getTargetInfo(targetInfoResult.targetInfo)
    if (!targetInfo) {
      return yield* Effect.fail(new Error("Target.getTargetInfo did not return targetInfo"))
    }
    const restoredTarget = options.browserControlSessionId
      ? undefined
      : sessions.persistedTargetOwner(targetInfo.targetId)
    const browserControlSessionId = options.browserControlSessionId ?? restoredTarget?.sessionId
    const sessionId = `bc-tab-${nextTargetSessionId++}`
    const candidate: ConnectedTarget = {
      tabId,
      sessionId,
      targetInfo,
      owner: restoredTarget?.owner ?? options.owner,
      ...(browserControlSessionId ? { browserControlSessionId } : {}),
    }
    return yield* finishAttachedTarget(registry.stageRootTarget(candidate), options.autoAttachParams)
  })

  const finishAttachedTarget = Effect.fnUntraced(function* (target: ConnectedTarget, autoAttachParams?: JsonObject) {
    const tabId = target.tabId
    yield* sendDebuggerCommand({
      tabId,
      method: "Target.setAutoAttach",
      params: autoAttachParams ?? {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
    })
    const currentTargetInfoResult = yield* sendDebuggerCommand({ tabId, method: "Target.getTargetInfo", params: {} })
    const currentTargetInfo = getTargetInfo(currentTargetInfoResult.targetInfo)
    if (!currentTargetInfo || currentTargetInfo.targetId !== target.targetInfo.targetId) {
      return yield* Effect.fail(new Error(`Root target changed while preparing ${target.targetInfo.targetId}`))
    }
    const change = registry.commitStagedRootTarget(tabId, target.sessionId)
    if (!change) return yield* Effect.fail(new Error(`Staged root target changed before commit: ${target.targetInfo.targetId}`))
    const committedTarget = change.target
    if (change.kind === "replaced") reconcileRootReplacement(change)
    mainFrameIdsByTab.set(tabId, committedTarget.targetInfo.targetId)
    contextDebugLog?.(`target-attached kind=root ${targetDiagnosticIdentity(committedTarget)} ${summarizeDiagnosticUrl(committedTarget.targetInfo.url)}`)
    if (committedTarget.browserControlSessionId) {
      pruneInvisibleAnnouncementsForSession(committedTarget.browserControlSessionId)
    }
    if (extensionRpc.connected) {
      refreshTabGrouping(tabId)
    }
    yield* Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: true } }))
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
    announceAttachedTarget(committedTarget)
    for (const child of registry.childTargets.values()) {
      if (child.tabId === tabId && child.parentSessionId === committedTarget.sessionId && shouldExposeChildTarget(child)) {
        announceAttachedChildTarget(committedTarget.sessionId, child)
      }
    }
    return committedTarget
  })

  const attachTab = Effect.fnUntraced(function* (options: {
    readonly tabId: number
    readonly owner: "relay" | "user"
    readonly browserControlSessionId?: string
    readonly alreadyAttached?: boolean
    readonly expectedExtensionGeneration?: number
    readonly autoAttachParams?: JsonObject
  }) {
    const semaphore = rootLifecycleSemaphores.get(options.tabId) ?? Semaphore.makeUnsafe(1)
    rootLifecycleSemaphores.set(options.tabId, semaphore)
    return yield* semaphore.withPermit(Effect.gen(function* () {
      if (relayClosing) return yield* Effect.fail(new Error("Relay is closing"))
      if (options.expectedExtensionGeneration !== undefined && options.expectedExtensionGeneration !== extensionGeneration) {
        return yield* Effect.fail(new Error("Extension changed before target reconciliation acquired its permit"))
      }
      return yield* attachTabUnlocked(options)
    }))
  })

  const reconcileAttachedRootUnlocked = Effect.fnUntraced(function* (tabId: number) {
    const expected = registry.tabTargets.get(tabId)
    const staged = registry.stagedRootTarget(tabId)
    if (!expected && !staged) return
    let targetInfo: ReturnType<typeof getTargetInfo> | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = yield* Effect.result(sendDebuggerCommand({ tabId, method: "Target.getTargetInfo", params: {} }))
      if (result._tag === "Success") {
        targetInfo = getTargetInfo(result.success.targetInfo)
        break
      }
      if (attempt === 0) yield* Effect.sleep("50 millis")
    }
    if (relayClosing) return
    if (!targetInfo) return
    if (
      registry.tabTargets.get(tabId)?.sessionId !== expected?.sessionId ||
      registry.stagedRootTarget(tabId)?.sessionId !== staged?.sessionId
    ) return
    if (staged?.targetInfo.targetId === targetInfo.targetId) {
      yield* finishAttachedTarget(staged)
      return
    }
    if (!staged && expected?.targetInfo.targetId === targetInfo.targetId) return
    const ownerSource = expected ?? staged
    if (!ownerSource) return
    yield* attachTabUnlocked({
      tabId,
      owner: ownerSource.owner,
      alreadyAttached: true,
      ...(ownerSource.browserControlSessionId ? { browserControlSessionId: ownerSource.browserControlSessionId } : {}),
    })
  })

  const reconcileAttachedRoot = Effect.fnUntraced(function* (tabId: number, expectedExtensionGeneration?: number) {
    const semaphore = rootLifecycleSemaphores.get(tabId) ?? Semaphore.makeUnsafe(1)
    rootLifecycleSemaphores.set(tabId, semaphore)
    yield* semaphore.withPermit(Effect.gen(function* () {
      if (relayClosing) return
      if (expectedExtensionGeneration !== undefined && expectedExtensionGeneration !== extensionGeneration) {
        return yield* Effect.fail(new Error("Extension changed before target reconciliation acquired its permit"))
      }
      yield* reconcileAttachedRootUnlocked(tabId)
    }))
  })

  function queueRootReconciliation(
    tabId: number,
    attachIfMissing: boolean,
    verificationRetries: number,
    errorMessage: string,
    generation = extensionGeneration,
  ): void {
    if (relayClosing) return
    const workerKey = `${generation}:${tabId}`
    const existing = rootReconciliationWorkers.get(workerKey)
    if (existing) {
      existing.pending = true
      existing.attachIfMissing ||= attachIfMissing
      existing.verificationRetries = Math.max(existing.verificationRetries, verificationRetries)
      return
    }
    const worker: RootReconciliationWorker = {
      attachIfMissing,
      generation,
      pending: false,
      promise: Promise.resolve(true),
      verificationRetries,
    }
    worker.promise = (async () => {
      let retries = 0
      let reconciled = true
      do {
        if (generation !== extensionGeneration) return false
        worker.pending = false
        const mayAttach = worker.attachIfMissing
        worker.attachIfMissing = false
        try {
          if (registry.tabTargets.has(tabId)) {
            await Effect.runPromise(reconcileAttachedRoot(tabId, generation))
          } else if (mayAttach && !relayClosing) {
            await Effect.runPromise(attachTab({
              tabId,
              owner: "user",
              alreadyAttached: true,
              expectedExtensionGeneration: generation,
            }))
          }
          if (generation !== extensionGeneration) return false
          retries = 0
          if (worker.verificationRetries > 0 && !relayClosing) {
            const retryDelayMs = 50 * (4 - worker.verificationRetries)
            worker.verificationRetries -= 1
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
            worker.pending = true
          }
        } catch (error) {
          console.error(errorMessage, error)
          if (generation !== extensionGeneration) {
            reconciled = false
          } else if (retries < 2 && !relayClosing) {
            retries += 1
            worker.attachIfMissing ||= mayAttach
            await new Promise((resolve) => setTimeout(resolve, 100 * retries))
            worker.pending = true
          } else {
            reconciled = false
          }
        }
      } while (worker.pending && !relayClosing)
      return reconciled
    })().finally(() => {
      if (rootReconciliationWorkers.get(workerKey) === worker) {
        rootReconciliationWorkers.delete(workerKey)
      }
      if (!registry.tabTargets.has(tabId)) rootLifecycleSemaphores.delete(tabId)
    })
    rootReconciliationWorkers.set(workerKey, worker)
  }

  const injectGhostCursor = Effect.fnUntraced(function* (tabId: number) {
    yield* sendDebuggerCommand({
      tabId,
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: ghostCursorClientSource },
    })
    yield* sendDebuggerCommand({
      tabId,
      method: "Runtime.evaluate",
      params: { expression: ghostCursorClientSource },
    })
  })

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

  const disableRuntimeForIdleTargets = Effect.fnUntraced(function* (generation: number) {
    yield* Effect.forEach(Array.from(registry.targets.values()), (target) => {
      if (!cdpClients.isCurrentIdleGeneration(generation)) {
        return Effect.void
      }
      return runRuntimeResetCommand({ phase: "idle-client-disconnect", tabId: target.tabId, method: "Runtime.disable", params: {} }).pipe(Effect.asVoid)
    })
    yield* Effect.forEach(Array.from(registry.childTargets.values()), (target) => {
      if (!cdpClients.isCurrentIdleGeneration(generation)) {
        return Effect.void
      }
      return runRuntimeResetCommand({ phase: "idle-client-disconnect", tabId: target.tabId, sessionId: target.sessionId, method: "Runtime.disable", params: {} }).pipe(Effect.asVoid)
    })
  })

  function detachTargetState(tabId: number, options: {
    readonly preserveSessionTarget?: boolean
    readonly updateExtension?: boolean
  } = {}): void {
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
    cdpClients.removeTargetAliases((alias) => alias.tabId === tabId)
    mainFrameIdsByTab.delete(tabId)
    ghostCursorPositionsByTab.delete(tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === tabId) {
        suppressedChildSessions.delete(sessionId)
      }
    }
    contextDebugLog?.(`target-detached kind=root ${targetDiagnosticIdentity(detached.target)}`)
    for (const client of cdpClients) {
      for (const childSessionId of detached.childSessionIds) {
        detachAnnouncedSession(client, childSessionId)
      }
    }
    sendEventToTargetViewers(detached.target.sessionId, {
      method: "Target.targetDestroyed",
      params: { targetId: detached.target.targetInfo.targetId },
    })
    sendEventToTargetViewers(detached.target.sessionId, {
      method: "Target.detachedFromTarget",
      params: { sessionId: detached.target.sessionId, targetId: detached.target.targetInfo.targetId },
    })
    for (const client of cdpClients) {
      const announcements = cdpClients.announcements(client)
      removeAnnouncedSession(announcements, detached.target.sessionId)
    }
  }

  function reconcileRootReplacement(change: Extract<RootTargetChange, { readonly kind: "replaced" }>): void {
    handoffs.rebindTarget({
      tabId: change.target.tabId,
      previousTargetId: change.previous.targetInfo.targetId,
      previousTargetSessionId: change.previous.sessionId,
      targetId: change.target.targetInfo.targetId,
      targetSessionId: change.target.sessionId,
    })
    sessions.markTargetReplaced(change.previous.targetInfo.targetId, change.target.targetInfo.targetId)
    cdpClients.removeTargetAliases((alias) => alias.tabId === change.target.tabId)
    mainFrameIdsByTab.delete(change.target.tabId)
    ghostCursorPositionsByTab.delete(change.target.tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === change.target.tabId) suppressedChildSessions.delete(sessionId)
    }
    for (const client of cdpClients) {
      for (const childSessionId of change.childSessionIds) detachAnnouncedSession(client, childSessionId)
      detachAnnouncedSession(client, change.previous.sessionId)
    }
    contextDebugLog?.(`target-replaced kind=root old=${targetDiagnosticIdentity(change.previous)} new=${targetDiagnosticIdentity(change.target)}`)
  }

  function detachChildTargetState(sessionId: string, notifyClients = false): void {
    if (notifyClients) {
      for (const client of cdpClients) {
        detachAnnouncedSession(client, sessionId)
      }
    }
    const detached = registry.detachChildTargetState(sessionId)
    if (detached) {
      cdpClients.removeTargetAliases((alias) => alias.targetId === detached.targetInfo.targetId)
    }
    if (!notifyClients) {
      for (const client of cdpClients) {
        removeAnnouncedSession(cdpClients.announcements(client), sessionId)
      }
    }
  }

  // Deliver a session-scoped event only to clients that have been told about
  // the tab's root target. Broadcasting to every client lets concurrently
  // connected sandboxes attach to each other's pages and interfere.
  function sendEventToTargetViewers(rootSessionId: string, event: CdpEvent): void {
    const target = registry.targets.get(rootSessionId)
    for (const client of cdpClients) {
      if (!hasAnnouncedSession(cdpClients.announcements(client), rootSessionId)) {
        continue
      }
      if (target && !cdpRouter.canSeeTarget(client, target)) {
        detachAnnouncedSession(client, rootSessionId)
        continue
      }
      sendCdpEvent(client, event)
    }
  }

  function pruneInvisibleAnnouncementsForSession(browserControlSessionId: string): void {
    for (const client of cdpClients) {
      if (cdpClients.sessionId(client) === browserControlSessionId) {
        pruneInvisibleAnnouncementsForClient(client)
      }
    }
  }

  function pruneInvisibleAnnouncementsForClient(client: WebSocket): void {
    const announcements = cdpClients.announcements(client)
    for (const announced of Array.from(announcements.targets.values())) {
      const rootTarget = registry.targets.get(announced.sessionId)
      if (rootTarget) {
        if (!cdpRouter.canSeeTarget(client, rootTarget)) {
          cdpClients.removeClientTargetAliases(client, (alias) => alias.tabId === rootTarget.tabId)
          detachAnnouncedSession(client, announced.sessionId)
        }
        continue
      }
      const childTarget = registry.childTargets.get(announced.sessionId)
      if (childTarget && !cdpRouter.canSeeTab(client, childTarget.tabId)) {
        cdpClients.removeClientTargetAliases(client, (alias) => alias.tabId === childTarget.tabId)
        detachAnnouncedSession(client, announced.sessionId)
      }
    }
  }

  function reconcileTargetOwnership(change: TargetOwnershipChange): void {
    for (const client of cdpClients) {
      cdpRouter.pruneInvisibleAliases(client, change.tabIds)
      pruneInvisibleAnnouncementsForClient(client)
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

  function detachAnnouncedSession(client: WebSocket, sessionId: string): void {
    const announcements = cdpClients.announcements(client)
    const targetId = announcements?.sessionTargets.get(sessionId)
    const announced = targetId ? announcements?.targets.get(targetId) : undefined
    removeAnnouncedSession(announcements, sessionId)
    if (targetId && announced) {
      sendCdpEvent(client, {
        ...(announced.parentSessionId === undefined ? {} : { sessionId: announced.parentSessionId }),
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId },
      })
    }
  }

  function logDuplicateTargetAnnouncement(duplicate: { readonly targetId: string; readonly oldSessionId: string; readonly newSessionId: string }): void {
    console.error(`Deduped duplicate target announcement for ${duplicate.targetId}: ${duplicate.oldSessionId} -> ${duplicate.newSessionId}`)
  }

  function announceAttachedTarget(target: ConnectedTarget): void {
    for (const client of cdpClients) {
      if (cdpRouter.canSeeTarget(client, target)) {
        sendAttachedToTarget({ socket: client, announcements: cdpClients.announcements(client), target, onDuplicateTarget: logDuplicateTargetAnnouncement })
      }
    }
  }

  function announceAttachedChildTarget(rootSessionId: string, target: ChildTarget): void {
    for (const client of cdpClients) {
      if (hasAnnouncedSession(cdpClients.announcements(client), rootSessionId)) {
        sendAttachedToChildTarget({ socket: client, announcements: cdpClients.announcements(client), target, onDuplicateTarget: logDuplicateTargetAnnouncement })
      }
    }
  }

  // Resolves true once a default Runtime.executionContextCreated event arrives
  // for the session, or false when none arrives within the wait window.
  function waitForDefaultRuntimeContext(sessionId: string): Effect.Effect<boolean> {
    return Effect.callback<boolean>((resume) => {
      const timeout = setTimeout(() => {
        runtimeContextWaiters.delete(onEvent)
        resume(Effect.succeed(false))
      }, 3_000)
      const onEvent = (event: CdpEvent) => {
        if (event.sessionId !== sessionId || event.method !== "Runtime.executionContextCreated") {
          return
        }
        const context = getObject(event.params?.context)
        const auxData = getObject(context?.auxData)
        if (auxData?.isDefault !== true) {
          return
        }
        clearTimeout(timeout)
        runtimeContextWaiters.delete(onEvent)
        resume(Effect.succeed(true))
      }
      runtimeContextWaiters.add(onEvent)
      return Effect.sync(() => {
        clearTimeout(timeout)
        runtimeContextWaiters.delete(onEvent)
      })
    })
  }

  function notifyRuntimeContextWaiters(event: CdpEvent): void {
    for (const waiter of runtimeContextWaiters) {
      waiter(event)
    }
  }

  sessions.restore(options.restoredSessions)
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
  readonly status: 400 | 403 | 404 | 409
  readonly message: string
}): void {
  const statusText = options.status === 400 ? "Bad Request" : options.status === 403 ? "Forbidden" : options.status === 409 ? "Conflict" : "Not Found"
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
