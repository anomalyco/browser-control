import http from "node:http"
import stream from "node:stream"
import { Config, Effect, Fiber } from "effect"
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
import { isCdpRequest, isExtensionEvent, isExtensionResponse, parseJsonObject } from "./protocol.ts"
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
  HandoffRegistry,
  resolveExactHandoffTarget,
  toolbarClickAction,
  type HandoffCancellationReason,
  type HandoffOutcome,
} from "./handoff.ts"
import { ExecuteSandbox, type HandoffPageTarget } from "./execute.ts"
import { makePageStatus } from "./page-status.ts"
import { appendJournalEntry, defaultJournalBaseDir, makeJournalEntry } from "./session-journal.ts"
import { BrowserControlSessions } from "./session-manager.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { boundedToken, runtimeFailureKind, summarizeDiagnosticUrl, summarizeRuntimeEvaluate } from "./runtime-diagnostics.ts"
import { shouldExposeChildTarget, TargetRegistry, type TargetOwnershipChange } from "./target-registry.ts"

export type { RelayServer } from "./relay-types.ts"

export const startRelay = Effect.fn("Relay.start")(function* (options: { readonly host?: string; readonly port?: number } = {}) {
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
  console.error(`[browser-control relay] ${kind}; ${disposition}\n${errorText}`)
  if (debugEnvironmentEnabled(process.env.BROWSER_CONTROL_DEBUG)) {
    console.error(`[browser-control relay] ${kind} detail`, detail)
  }
}

function debugEnvironmentEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

const makeRelay = Effect.fnUntraced(function* (options: { readonly host?: string; readonly port?: number } = {}) {
  const host = options.host ?? defaultHost
  const port = options.port ?? defaultPort
  const browserId = crypto.randomUUID()
  const endpointUrl = `http://${formatHostForUrl(host)}:${port}`
  const registry = new TargetRegistry()
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
    setActivityForTarget(target, "waiting", waitingBadge(options.message), {
      sessionId: options.sessionId,
      message: options.message,
      handoffId: wait.id,
    })
    let outcome: HandoffOutcome | undefined
    try {
      outcome = await wait.outcome
      return outcome
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
        requestHandoff: ({ message, timeoutMs, target }) => requestHandoff({ sessionId: id, message, timeoutMs, target }),
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
        void appendJournalEntry({ baseDir: journalBaseDir, entry }).catch((error: unknown) => {
          console.error("Failed to append session journal entry", error)
        })
      },
      onTargetOwnershipChange: (change) => {
        reconcileTargetOwnership(change)
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

  function sendPageStatus(
    target: ConnectedTarget,
    state: PageStatus["state"],
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): void {
    const sessionId = options.sessionId ?? pageStatusSessionId(target)
    const status = makePageStatus({
      state,
      targetOwner: target.owner,
      ...(sessionId ? { sessionId, readOnly: sessions.isReadOnly(sessionId) } : {}),
      ...(options.message ? { message: options.message } : {}),
      ...(options.handoffId ? { handoffId: options.handoffId } : {}),
    })
    Effect.runPromise(Effect.ignore(sendToExtension({
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
    }))).catch(() => {})
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
  const httpServer = http.createServer(createHttpRequestHandler({
    host,
    port,
    browserId,
    registry,
    recordingRelay,
    sessions,
    extensionStatus: () => {
      return { connected: extensionRpc.connected, version: extensionRpc.version ?? null, cdpClients: cdpClients.size }
    },
  }))

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
    handoffs.cancelAll()
    extensionRpc.rejectPending(new Error("Relay closed"))
    yield* Effect.tryPromise(() => recordingRelay.cleanupAll("Relay closed")).pipe(Effect.ignore)
    yield* sessions.closeAll()
    for (const socket of cdpClients) {
      socket.close()
    }
    extensionRpc.close()
    yield* closeWebSocketServer(websocketServer).pipe(logCloseError("Failed to close websocket server"))
    yield* closeHttpServer(httpServer).pipe(logCloseError("Failed to close http server"))
  })

  httpServer.on("upgrade", (request, socket, head) => {
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host, port })
    if (hostError) {
      sendUpgradeError({ socket, status: 403, message: hostError })
      return
    }
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
    if (requestUrl.pathname === "/extension") {
      const originError = validateWebSocketOrigin({ origin, requireChromeExtension: true })
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
      const originError = validateWebSocketOrigin({ origin })
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
      extensionRpc.replaceSocket(socket)
      socket.on("message", (data, isBinary) => {
        try {
          if (isBinary) {
            recordingRelay.handleBinaryData(rawDataToBuffer(data))
            return
          }
          handleExtensionMessage(data.toString())
        } catch (error) {
          console.error("Extension message handling failed", error)
        }
      })
      socket.on("close", () => {
        if (extensionRpc.disconnectIfCurrent(socket)) {
          void recordingRelay.cleanupAll("Extension disconnected").catch(() => {})
          for (const target of registry.listRootTargets()) {
            cancelTargetHandoffs(target, "target-detached")
            sessions.releaseAdoptedTarget(target.targetInfo.targetId)
          }
          registry.clear()
          suppressedChildSessions.clear()
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

  function handleExtensionMessage(raw: string): void {
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
      extensionRpc.markReady(typeof message.params?.version === "string" ? message.params.version : undefined)
      return
    }
    if (extensionMethod === "debugger.attached") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      if (tabId && !registry.tabTargets.has(tabId)) {
        Effect.runPromise(attachTab({ tabId, owner: "user" })).catch((error: unknown) => {
          console.error("Debugger re-announce failed", error)
        })
      }
      return
    }
    if (extensionMethod === "toolbar.clicked") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      if (tabId) {
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
    const target = registry.tabTargets.get(tabId)
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
        yield* Effect.ignore(sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} }))
        if (canSeeTarget(socket, target)) {
          sendAttachedToTarget({ socket, clientAnnouncements: cdpClientAnnouncements, target, onDuplicateTarget: logDuplicateTargetAnnouncement })
        }
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
      const target =
        registry.targetsByTargetId.get(targetId) ??
        registry.childTargetsByTargetId.get(targetId) ??
        (aliasedTargetId ? registry.targetsByTargetId.get(aliasedTargetId) ?? registry.childTargetsByTargetId.get(aliasedTargetId) : undefined) ??
        (message.sessionId ? registry.targets.get(message.sessionId) ?? registry.childTargets.get(message.sessionId) : undefined) ??
        firstVisibleRootTarget(socket)
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

  const attachTab = Effect.fnUntraced(function* (options: {
    readonly tabId: number
    readonly owner: "relay" | "user"
    readonly browserControlSessionId?: string
  }) {
    const { tabId } = options
    yield* sendToExtension({ method: "debugger.attach", params: { tabId } })
    yield* sendDebuggerCommand({ tabId, method: "Page.enable", params: {} })
    yield* injectGhostCursor(tabId).pipe(Effect.ignore)
    const targetInfoResult = yield* sendDebuggerCommand({ tabId, method: "Target.getTargetInfo", params: {} })
    const targetInfo = getTargetInfo(targetInfoResult.targetInfo)
    if (!targetInfo) {
      return yield* Effect.fail(new Error("Target.getTargetInfo did not return targetInfo"))
    }
    const sessionId = `bc-tab-${nextTargetSessionId++}`
    const target: ConnectedTarget = {
      tabId,
      sessionId,
      targetInfo,
      owner: options.owner,
      ...(options.browserControlSessionId ? { browserControlSessionId: options.browserControlSessionId } : {}),
    }
    registry.addRootTarget(target)
    mainFrameIdsByTab.set(tabId, targetInfo.targetId)
    contextDebugLog?.(`target-attached kind=root ${targetDiagnosticIdentity(target)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
    if (options.browserControlSessionId) {
      pruneInvisibleAnnouncementsForSession(options.browserControlSessionId)
    }
    yield* sendDebuggerCommand({
      tabId,
      method: "Target.setAutoAttach",
      params: autoAttachParams ?? {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
    })
    yield* Effect.ignore(sendToExtension({
      method: options.browserControlSessionId ? "tabs.group" : "tabs.ungroup",
      params: { tabId },
    }))
    yield* Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: true } }))
    sendPageStatus(target, options.browserControlSessionId && sessions.isExecuting(options.browserControlSessionId) ? "running" : "attached")
    announceAttachedTarget(target)
    return target
  })

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

  function detachTargetState(tabId: number): void {
    Effect.runPromise(Effect.ignore(sendToExtension({ method: "pageStatus.clear", params: { tabId } }))).catch(() => {})
    Effect.runPromise(Effect.ignore(sendToExtension({ method: "tabs.ungroup", params: { tabId } }))).catch(() => {})
    Effect.runPromise(Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: false } }))).catch(() => {})
    void recordingRelay.abortRecordingForTab({ tabId, reason: "Tab detached" }).catch((error: unknown) => {
      console.error("Failed to abort recording for detached tab", error)
    })
    const detached = registry.detachRootTargetState(tabId)
    if (!detached) {
      return
    }
    cancelTargetHandoffs(detached.target, "target-detached")
    sessions.markTargetDetached(detached.target.targetInfo.targetId)
    sessions.releaseAdoptedTarget(detached.target.targetInfo.targetId)
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
      const target = registry.tabTargets.get(tabId)
      if (!target) {
        continue
      }
      Effect.runPromise(Effect.ignore(sendToExtension({
        method: target.browserControlSessionId ? "tabs.group" : "tabs.ungroup",
        params: { tabId },
      }))).catch(() => {})
      refreshPageStatus(tabId)
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
