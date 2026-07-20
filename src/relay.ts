import http from "node:http"
import stream from "node:stream"
import crypto from "node:crypto"
import { Clock, Config, Effect, Fiber, Semaphore } from "effect"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import {
  chromeSessionIdForClientRequest,
  createClientTargetAnnouncements,
  hasAnnouncedSession,
  removeAnnouncedSession,
  removeClientTargetAliases,
  replayChildFrameNavigation,
  replayChildTargetsForParent,
  replayTargetCreated,
  sendAttachedToChildTarget,
  sendAttachedToTarget,
  type ClientCdpSessionAlias,
} from "./cdp-shims.ts"
import { canClientSeeTarget } from "./cdp-visibility.ts"
import { ExtensionRpc } from "./extension-rpc.ts"
import { createHttpRequestHandler } from "./http-api.ts"
import type { CdpEvent, CdpRequest, JsonObject, PageStatus } from "./protocol.ts"
import { extensionProtocolCompatibility, isCdpRequest, isExtensionEvent, isExtensionResponse, parseJsonObject } from "./protocol.ts"
import {
  closeHttpServer,
  closeWebSocketServer,
  defaultHost,
  defaultPort,
  formatHostForUrl,
  getObject,
  getTargetInfo,
  headerValue,
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
import { defaultSessionCatalogPath, SessionCatalog } from "./session-catalog.ts"
import { BrowserControlSessions } from "./session-manager.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { appendManagedRelayProcessLog } from "./relay-log.ts"
import { boundedToken, runtimeFailureKind, summarizeDiagnosticUrl, summarizeRuntimeEvaluate } from "./runtime-diagnostics.ts"
import { resolveTargetInfoTarget, shouldExposeChildTarget, TargetRegistry, type RootTargetChange, type TargetOwnershipChange } from "./target-registry.ts"
import { browserControlVersion } from "./version.ts"

export type { RelayServer } from "./relay-types.ts"

export const startRelay = Effect.fn("Relay.start")(function* (options: {
  readonly host?: string
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
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

const makeRelay = Effect.fnUntraced(function* (options: {
  readonly host?: string
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
} = {}) {
  const host = options.host ?? defaultHost
  const port = options.port ?? defaultPort
  const releaseTargetGraceMs = Math.max(0, options.releaseTargetGraceMs ?? 10_000)
  const browserId = crypto.randomUUID()
  const endpointUrl = `http://${formatHostForUrl(host)}:${port}`
  const allowAnyChromeExtension = browserControlVersion === "0.0.0-dev"
  const sessionCatalog = options.sessionCatalogPath === null
    ? undefined
    : new SessionCatalog(options.sessionCatalogPath ?? defaultSessionCatalogPath(port))
  let catalogWritesEnabled = false
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
  let relayClosing = false
  let extensionGeneration = 0
  const extensionRpc = new ExtensionRpc()
  const sendToExtension = Effect.fnUntraced(function* (command: Parameters<ExtensionRpc["send"]>[0]) {
    return yield* extensionRpc.send(command)
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
  const recordingRelay = new RecordingRelay({
    sendToExtension: (command) => {
      return Effect.runPromise(extensionRpc.send(command))
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
  const clearLiveExtensionState = (reason: string) => {
    void recordingRelay.cleanupAll(reason).catch(() => {})
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
      onSessionsChanged: async (entries) => {
        if (catalogWritesEnabled) await sessionCatalog?.save(entries)
      },
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
    const clientHasOwnedTarget = registry.listRootTargets().some((target) => target.browserControlSessionId === sessionId)
    return resolveExactHandoffTarget({
      targetId: selectedPage.targetId,
      targets: registry.listRootTargets(),
      isVisible: (target) => canClientSeeTarget({
        clientSessionId: sessionId,
        targetOwnerSessionId: target.browserControlSessionId,
        targetOwner: target.owner,
        clientHasOwnedTarget,
      }),
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
  function refreshTabPresentation(tabId: number): void {
    refreshPageStatus(tabId)
    const target = registry.tabTargets.get(tabId)
    const method = target && pageStatusSessionId(target) ? "tabs.group" : "tabs.ungroup"
    Effect.runPromise(Effect.ignore(sendToExtension({ method, params: { tabId } }))).catch(() => {})
  }
  const relayRequestHandler = createHttpRequestHandler({
    host,
    port,
    browserId,
    relayInstance: { id: browserId, startedAt: new Date().toISOString(), pid: process.pid },
    registry,
    recordingRelay,
    sessions,
    extensionStatus: () => {
      return {
        connected: extensionRpc.connected,
        version: extensionRpc.version ?? null,
        protocolVersion: extensionRpc.protocolVersion ?? null,
        protocolCompatible: extensionRpc.protocolCompatible ?? null,
        protocolLegacy: extensionRpc.protocolLegacy ?? null,
        cdpClients: cdpClients.size,
      }
    },
  })
  let relayReady = false
  const httpServer = http.createServer((request, response) => {
    if (!relayReady) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "1" })
      response.end(JSON.stringify({ error: "Browser Control relay is starting", code: "relay-starting" }))
      return
    }
    relayRequestHandler(request, response)
  })

  const debugEnabled = yield* Config.boolean("BROWSER_CONTROL_DEBUG").pipe(Config.withDefault(false))
  const debugLog = debugEnabled ? (line: string) => console.error(`[bc ${new Date().toISOString().slice(11, 23)}] ${line}`) : undefined
  const contextDebugLog = debugLog ? (line: string) => debugLog(`[bc:ctx] ${line}`) : undefined
  const websocketServer = new WebSocketServer({ noServer: true })
  const cdpClients = new Set<WebSocket>()
  const cdpClientAnnouncements = new Map<WebSocket, ReturnType<typeof createClientTargetAnnouncements>>()
  const cdpClientBrowserControlSessionIds = new Map<WebSocket, string>()
  const cdpClientSessionAliases = new Map<WebSocket, Map<string, ClientCdpSessionAlias>>()
  const runtimeContextWaiters = new Set<(event: CdpEvent) => void>()
  let nextTargetSessionId = 1
  let nextClientSessionAliasId = 1
  let autoAttachParams: JsonObject | undefined
  let idleRuntimeResetGeneration = 0
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
    yield* closeWebSocketServer(websocketServer).pipe(logCloseError("Failed to close websocket server"))
    yield* closeHttpServer(httpServer).pipe(logCloseError("Failed to close http server"))
  })

  httpServer.on("upgrade", (request, socket, head) => {
    if (!relayReady) {
      sendUpgradeError({ socket, status: 404, message: "Browser Control relay is starting" })
      return
    }
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host, port })
    if (hostError) {
      sendUpgradeError({ socket, status: 403, message: hostError })
      return
    }
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
    if (requestUrl.pathname === "/extension") {
      const originError = validateWebSocketOrigin({ origin, requireChromeExtension: true, allowAnyChromeExtension })
      if (originError) {
        sendUpgradeError({ socket, status: 403, message: originError })
        return
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request)
      })
      return
    }
    if (requestUrl.pathname.startsWith("/devtools/browser/")) {
      const originError = validateWebSocketOrigin({ origin, allowAnyChromeExtension })
      if (originError) {
        sendUpgradeError({ socket, status: 403, message: originError })
        return
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request)
      })
      return
    }
    socket.destroy()
  })

  websocketServer.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    if (requestUrl.pathname === "/extension") {
      let handshaken = false
      let socketGeneration = 0
      const announcedRootTabIds = new Set<number>()
      socket.on("message", (data, isBinary) => {
        try {
          if (!handshaken) {
            const acceptedGeneration = isBinary ? undefined : acceptExtensionHello(socket, data.toString())
            if (acceptedGeneration === undefined) {
              socket.close(4002, "Extension hello required")
              return
            }
            socketGeneration = acceptedGeneration
            handshaken = true
            return
          }
          if (!extensionRpc.isCurrent(socket) || !extensionRpc.acceptsEvents) {
            return
          }
          if (isBinary) {
            recordingRelay.handleBinaryData(rawDataToBuffer(data))
            return
          }
          handleExtensionMessage(socket, data.toString(), socketGeneration, announcedRootTabIds)
        } catch (error) {
          console.error("Extension message handling failed", error)
        }
      })
      socket.on("close", () => {
        if (extensionRpc.disconnectIfCurrent(socket)) {
          clearLiveExtensionState("Extension disconnected")
        }
      })
      return
    }

    cdpClients.add(socket)
    idleRuntimeResetGeneration++
    cdpClientAnnouncements.set(socket, createClientTargetAnnouncements())
    cdpClientSessionAliases.set(socket, new Map())
    const browserControlSessionId = requestUrl.searchParams.get("browserControlSessionId") ?? headerValue(request.headers["browser-control-session-id"])
    if (browserControlSessionId) {
      cdpClientBrowserControlSessionIds.set(socket, browserControlSessionId)
    }
    debugLog?.(`client+ ${browserControlSessionId ?? "raw"} total=${cdpClients.size}`)
    socket.on("message", (data) => {
      Effect.runPromise(handleCdpMessage(socket, data.toString())).catch((error: unknown) => {
        sendCdpResponse(socket, {
          id: 0,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    })
    socket.on("close", () => {
      debugLog?.(`client- ${cdpClientBrowserControlSessionIds.get(socket) ?? "raw"} total=${cdpClients.size - 1}`)
      cdpClients.delete(socket)
      cdpClientAnnouncements.delete(socket)
      cdpClientBrowserControlSessionIds.delete(socket)
      cdpClientSessionAliases.delete(socket)
      if (cdpClients.size === 0) {
        const generation = ++idleRuntimeResetGeneration
        Effect.runPromise(disableRuntimeForIdleTargets(generation).pipe(Effect.ignore)).catch((error: unknown) => {
          console.error("Failed to reset idle runtime domains", error)
        })
      }
    })
  })

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
    if (!protocol.compatible && extensionRpc.connected) {
      socket.close(4003, "Extension protocol incompatible")
      return extensionGeneration
    }
    extensionGeneration += 1
    clearLiveExtensionState("Extension replaced")
    extensionRpc.replaceSocket(socket)
    extensionRpc.markHandshake(
      typeof message.params?.version === "string" ? message.params.version : undefined,
      message.params?.protocolVersion,
    )
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
    if (extensionMethod === "recording.data") {
      recordingRelay.handleRecordingData(message)
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

    debugLog?.(`cdp<- ${cdpClientBrowserControlSessionIds.get(socket) ?? "raw"} #${message.id} ${message.method} ${message.sessionId ?? ""}`)
    yield* Effect.matchEffect(routeCdpCommand(socket, message), {
      onFailure: (error) => {
        return Effect.sync(() => {
          const runtimeEvaluation = isRuntimeEvaluationMethod(message.method)
          const errorDetail = runtimeEvaluation ? runtimeFailureKind(error) : error.message
          debugLog?.(`cdp-> ${cdpClientBrowserControlSessionIds.get(socket) ?? "raw"} #${message.id} ${message.method} ERROR ${errorDetail}`)
          if (runtimeEvaluation) {
            const tabId = message.sessionId ? registry.tabIdForSession(message.sessionId) : firstVisibleRootTarget(socket)?.tabId
            contextDebugLog?.(`evaluation-failed method=${message.method} failure=${runtimeFailureKind(error)} client=${boundedToken(cdpClientBrowserControlSessionIds.get(socket) ?? "raw")} ${targetDiagnosticIdentity(tabId ? targetForCdpSession(tabId, message.sessionId) : undefined)} ${summarizeRuntimeEvaluate(message.params)}`)
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
          debugLog?.(`cdp-> ${cdpClientBrowserControlSessionIds.get(socket) ?? "raw"} #${message.id} ${message.method} ok`)
          const resultObject = getObject(result)
          const exceptionDetails = isRuntimeEvaluationMethod(message.method) ? getObject(resultObject?.exceptionDetails) : undefined
          if (exceptionDetails) {
            const tabId = message.sessionId ? registry.tabIdForSession(message.sessionId) : firstVisibleRootTarget(socket)?.tabId
            contextDebugLog?.(`evaluation-exception method=${message.method} exceptionId=${boundedToken(typeof exceptionDetails.exceptionId === "number" || typeof exceptionDetails.exceptionId === "string" ? String(exceptionDetails.exceptionId) : undefined)} line=${typeof exceptionDetails.lineNumber === "number" ? exceptionDetails.lineNumber : "none"} column=${typeof exceptionDetails.columnNumber === "number" ? exceptionDetails.columnNumber : "none"} client=${boundedToken(cdpClientBrowserControlSessionIds.get(socket) ?? "raw")} ${targetDiagnosticIdentity(tabId ? targetForCdpSession(tabId, message.sessionId) : undefined)} ${summarizeRuntimeEvaluate(message.params)}`)
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
    const clientBrowserControlSessionId = cdpClientBrowserControlSessionIds.get(socket)
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
        replayTargetCreated({ socket, targetInfos: visibleTargetInfos(socket) })
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && !message.sessionId) {
      autoAttachParams = message.params
      for (const target of registry.targets.values()) {
        if (!canSeeTarget(socket, target)) continue
        yield* Effect.ignore(sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} }))
        sendAttachedToTarget({ socket, clientAnnouncements: cdpClientAnnouncements, target, onDuplicateTarget: logDuplicateTargetAnnouncement })
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && message.sessionId && registry.targets.has(message.sessionId)) {
      const target = registry.targets.get(message.sessionId)
      if (!target) {
        return yield* Effect.fail(new Error(`Target not found: ${message.sessionId}`))
      }
      const result = yield* sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} })
      replayChildTargetsForParent({ socket, parentSessionId: target.sessionId, registry, clientAnnouncements: cdpClientAnnouncements, onDuplicateTarget: logDuplicateTargetAnnouncement })
      return result
    }
    if (message.method === "Target.getTargets") {
      return {
        targetInfos: visibleTargetInfos(socket),
      }
    }
    if (message.method === "Target.attachToBrowserTarget") {
      const aliasId = `bc-client-browser-${nextClientSessionAliasId++}`
      cdpClientSessionAliases.get(socket)?.set(aliasId, { kind: "browser" })
      return { sessionId: aliasId }
    }
    if (message.method === "Target.attachToTarget") {
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target = registry.targetsByTargetId.get(targetId)
      if (target && canSeeTarget(socket, target)) {
        if (hasAnnouncedSession(cdpClientAnnouncements.get(socket), target.sessionId)) {
          return { sessionId: createClientSessionAlias(socket, target) }
        }
        sendAttachedToTarget({ socket, clientAnnouncements: cdpClientAnnouncements, target, onDuplicateTarget: logDuplicateTargetAnnouncement })
        return { sessionId: target.sessionId }
      }
      const childTarget = registry.childTargetsByTargetId.get(targetId)
      if (childTarget && canSeeTabId(socket, childTarget.tabId)) {
        if (hasAnnouncedSession(cdpClientAnnouncements.get(socket), childTarget.sessionId)) {
          return { sessionId: createClientSessionAlias(socket, childTarget) }
        }
        sendAttachedToChildTarget({ socket, clientAnnouncements: cdpClientAnnouncements, target: childTarget, onDuplicateTarget: logDuplicateTargetAnnouncement })
        replayChildFrameNavigation({ socket, registry, target: childTarget })
        return { sessionId: childTarget.sessionId }
      }
      return yield* Effect.fail(new Error(`Target not found: ${targetId}`))
    }
    if (message.method === "Target.getTargetInfo") {
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const sessionAlias = message.sessionId ? cdpClientSessionAliases.get(socket)?.get(message.sessionId) : undefined
      const aliasedTargetId = sessionAlias?.kind === "target" ? sessionAlias.targetId : undefined
      const target = resolveTargetInfoTarget({
        registry,
        ...(targetId ? { targetId } : {}),
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        ...(aliasedTargetId ? { aliasedTargetId } : {}),
        fallback: () => firstVisibleRootTarget(socket),
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
        const browserControlSessionId = cdpClientBrowserControlSessionIds.get(socket)
        const target = yield* createAndAttachTab({ url, active: false, ...(browserControlSessionId ? { browserControlSessionId } : {}) })
        return { targetId: target.targetInfo.targetId }
      }
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target = registry.targetsByTargetId.get(targetId)
      if (!target) {
        return { success: false }
      }
      yield* closeTargetByTargetId(targetId)
      return { success: true }
    }
    if (message.method === "Target.detachFromTarget") {
      const childSessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined
      if (childSessionId) {
        if (cdpClientSessionAliases.get(socket)?.delete(childSessionId)) {
          return {}
        }
        removeAnnouncedSession(cdpClientAnnouncements.get(socket), childSessionId)
      }
      return {}
    }
    const normalizedMessage = removeDefaultLightColorSchemeEmulation(message)
    if (message.method === "Runtime.enable" && message.sessionId) {
      const sessionId = message.sessionId
      const sessionAlias = cdpClientSessionAliases.get(socket)?.get(sessionId)
      const alias = sessionAlias?.kind === "target" ? sessionAlias : undefined
      const tabId = alias?.tabId ?? registry.tabIdForSession(sessionId)
      if (!tabId) {
        return yield* Effect.fail(new Error(`Unknown CDP session ${sessionId} for ${message.method}`))
      }
      const rootSessionId = registry.tabTargets.get(tabId)?.sessionId
      const routedSessionId = chromeSessionIdForClientRequest({
        alias,
        requestedSessionId: sessionId,
        rootSessionId,
      })
      const chromeSessionId = routedSessionId ? { sessionId: routedSessionId } : {}
      const contextSessionId = routedSessionId ?? rootSessionId ?? sessionId
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
    const sessionAlias = message.sessionId ? cdpClientSessionAliases.get(socket)?.get(message.sessionId) : undefined
    const alias = sessionAlias?.kind === "target" ? sessionAlias : undefined
    const tabId = alias?.tabId ?? (message.sessionId ? registry.tabIdForSession(message.sessionId) : firstVisibleRootTarget(socket)?.tabId)
    if (!tabId) {
      return yield* Effect.fail(new Error(message.sessionId ? `Unknown CDP session ${message.sessionId} for ${message.method}` : `No attached tab for ${message.method}`))
    }
    const rootSessionId = registry.tabTargets.get(tabId)?.sessionId
    const chromeSessionId = chromeSessionIdForClientRequest({
      alias,
      requestedSessionId: message.sessionId,
      rootSessionId,
    })
    const result = yield* sendDebuggerCommand({
      tabId,
      method: normalizedMessage.method,
      params: normalizedMessage.params ?? {},
      ...(chromeSessionId === undefined ? {} : { sessionId: chromeSessionId }),
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

  function createClientSessionAlias(socket: WebSocket, target: ConnectedTarget | ChildTarget): string {
    const aliasId = `bc-client-session-${nextClientSessionAliasId++}`
    const rootSessionId = registry.tabTargets.get(target.tabId)?.sessionId
    cdpClientSessionAliases.get(socket)?.set(aliasId, {
      kind: "target",
      tabId: target.tabId,
      targetId: target.targetInfo.targetId,
      ...(target.sessionId === rootSessionId ? {} : { chromeSessionId: target.sessionId }),
    })
    return aliasId
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
    })
  })

  const attachTabUnlocked = Effect.fnUntraced(function* (options: {
    readonly tabId: number
    readonly owner: "relay" | "user"
    readonly browserControlSessionId?: string
    readonly alreadyAttached?: boolean
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
    return yield* finishAttachedTarget(registry.stageRootTarget(candidate))
  })

  const finishAttachedTarget = Effect.fnUntraced(function* (target: ConnectedTarget) {
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
    yield* Effect.ignore(sendToExtension({
      method: committedTarget.browserControlSessionId ? "tabs.group" : "tabs.ungroup",
      params: { tabId },
    }))
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
          if (generation !== extensionGeneration) {
            detachTargetState(tabId, { preserveSessionTarget: true, updateExtension: false })
            return false
          }
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
            detachTargetState(tabId, { preserveSessionTarget: true, updateExtension: false })
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
      if (generation !== idleRuntimeResetGeneration || cdpClients.size !== 0) {
        return Effect.void
      }
      return runRuntimeResetCommand({ phase: "idle-client-disconnect", tabId: target.tabId, method: "Runtime.disable", params: {} }).pipe(Effect.asVoid)
    })
    yield* Effect.forEach(Array.from(registry.childTargets.values()), (target) => {
      if (generation !== idleRuntimeResetGeneration || cdpClients.size !== 0) {
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
      Effect.runPromise(Effect.ignore(sendToExtension({ method: "tabs.ungroup", params: { tabId } }))).catch(() => {})
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
    removeClientTargetAliases(cdpClientSessionAliases.values(), (alias) => alias.tabId === tabId)
    mainFrameIdsByTab.delete(tabId)
    ghostCursorPositionsByTab.delete(tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === tabId) {
        suppressedChildSessions.delete(sessionId)
      }
    }
    contextDebugLog?.(`target-detached kind=root ${targetDiagnosticIdentity(detached.target)}`)
    sendEventToTargetViewers(detached.target.sessionId, {
      method: "Target.targetDestroyed",
      params: { targetId: detached.target.targetInfo.targetId },
    })
    sendEventToTargetViewers(detached.target.sessionId, {
      method: "Target.detachedFromTarget",
      params: { sessionId: detached.target.sessionId, targetId: detached.target.targetInfo.targetId },
    })
    for (const announcements of cdpClientAnnouncements.values()) {
      removeAnnouncedSession(announcements, detached.target.sessionId)
      for (const childSessionId of detached.childSessionIds) {
        removeAnnouncedSession(announcements, childSessionId)
      }
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
    removeClientTargetAliases(cdpClientSessionAliases.values(), (alias) => alias.tabId === change.target.tabId)
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
      removeClientTargetAliases(cdpClientSessionAliases.values(), (alias) => alias.targetId === detached.targetInfo.targetId)
    }
    if (!notifyClients) {
      for (const announcements of cdpClientAnnouncements.values()) {
        removeAnnouncedSession(announcements, sessionId)
      }
    }
  }

  function canSeeTarget(socket: WebSocket, target: ConnectedTarget): boolean {
    const clientSessionId = cdpClientBrowserControlSessionIds.get(socket)
    return canClientSeeTarget({
      clientSessionId,
      targetOwnerSessionId: target.browserControlSessionId,
      targetOwner: target.owner,
      clientHasOwnedTarget: clientHasOwnedTarget(clientSessionId),
    })
  }

  function clientHasOwnedTarget(clientSessionId: string | undefined): boolean {
    return clientSessionId ? registry.listRootTargets().some((candidate) => candidate.browserControlSessionId === clientSessionId) : false
  }

  function canSeeTabId(socket: WebSocket, tabId: number): boolean {
    const rootTarget = registry.tabTargets.get(tabId)
    return rootTarget ? canSeeTarget(socket, rootTarget) : true
  }

  function firstVisibleRootTarget(socket: WebSocket): ConnectedTarget | undefined {
    return Array.from(registry.targets.values()).find((target) => {
      return canSeeTarget(socket, target)
    })
  }

  // Deliver a session-scoped event only to clients that have been told about
  // the tab's root target. Broadcasting to every client lets concurrently
  // connected sandboxes attach to each other's pages and interfere.
  function sendEventToTargetViewers(rootSessionId: string, event: CdpEvent): void {
    const target = registry.targets.get(rootSessionId)
    for (const client of cdpClients) {
      if (!hasAnnouncedSession(cdpClientAnnouncements.get(client), rootSessionId)) {
        continue
      }
      if (target && !canSeeTarget(client, target)) {
        detachAnnouncedSession(client, rootSessionId)
        continue
      }
      sendCdpEvent(client, event)
    }
  }

  function pruneInvisibleAnnouncementsForSession(browserControlSessionId: string): void {
    for (const client of cdpClients) {
      if (cdpClientBrowserControlSessionIds.get(client) === browserControlSessionId) {
        pruneInvisibleAnnouncementsForClient(client)
      }
    }
  }

  function pruneInvisibleAnnouncementsForClient(client: WebSocket): void {
    const announcements = cdpClientAnnouncements.get(client)
    if (!announcements) {
      return
    }
    for (const announced of Array.from(announcements.targets.values())) {
      const rootTarget = registry.targets.get(announced.sessionId)
      if (rootTarget) {
        if (!canSeeTarget(client, rootTarget)) {
          detachAnnouncedSession(client, announced.sessionId)
        }
        continue
      }
      const childTarget = registry.childTargets.get(announced.sessionId)
      if (childTarget && !canSeeTabId(client, childTarget.tabId)) {
        detachAnnouncedSession(client, announced.sessionId)
      }
    }
  }

  function reconcileTargetOwnership(change: TargetOwnershipChange): void {
    for (const client of cdpClients) {
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
    const announcements = cdpClientAnnouncements.get(client)
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
      if (canSeeTarget(client, target)) {
        sendAttachedToTarget({ socket: client, clientAnnouncements: cdpClientAnnouncements, target, onDuplicateTarget: logDuplicateTargetAnnouncement })
      }
    }
  }

  function announceAttachedChildTarget(rootSessionId: string, target: ChildTarget): void {
    for (const client of cdpClients) {
      if (hasAnnouncedSession(cdpClientAnnouncements.get(client), rootSessionId)) {
        sendAttachedToChildTarget({ socket: client, clientAnnouncements: cdpClientAnnouncements, target, onDuplicateTarget: logDuplicateTargetAnnouncement })
      }
    }
  }

  function visibleTargetInfos(socket: WebSocket) {
    return registry.allTargetInfos({
      isRestrictedTarget,
      isVisibleTarget: (target) => {
        return canSeeTabId(socket, target.tabId) && ("owner" in target || shouldExposeChildTarget(target))
      },
    })
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

  yield* Effect.catch(listenHttpServer({ server: httpServer, host, port }), (error) => {
    return Effect.gen(function* () {
      yield* cleanup()
      return yield* Effect.fail(error)
    })
  })

  yield* Effect.catch(
    Effect.gen(function* () {
      const restoredSessions = yield* Effect.tryPromise({
        try: () => sessionCatalog?.load() ?? Promise.resolve([]),
        catch: (cause) => cause instanceof Error ? cause : new Error("Load Browser Control session catalog", { cause }),
      })
      yield* Effect.try({
        try: () => sessions.restore(restoredSessions),
        catch: (cause) => cause instanceof Error ? cause : new Error("Restore Browser Control sessions", { cause }),
      })
      catalogWritesEnabled = true
      relayReady = true
    }),
    (error) => Effect.gen(function* () {
      yield* cleanup()
      return yield* Effect.fail(error)
    }),
  )

  return {
    url: endpointUrl,
    close: () => {
      return close
    },
  }
})

function sendUpgradeError(options: {
  readonly socket: stream.Duplex
  readonly status: 400 | 403 | 404
  readonly message: string
}): void {
  const statusText = options.status === 400 ? "Bad Request" : options.status === 403 ? "Forbidden" : "Not Found"
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
