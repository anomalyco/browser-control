import http from "node:http"
import stream from "node:stream"
import { Effect, Fiber } from "effect"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import {
  createClientTargetAnnouncements,
  hasAnnouncedSession,
  removeAnnouncedSession,
  replayChildFrameNavigation,
  replayChildTargetsForParent,
  replayTargetCreated,
  sendAttachedToChildTarget,
  sendAttachedToTarget,
} from "./cdp-shims.ts"
import { canClientSeeTarget } from "./cdp-visibility.ts"
import { ExtensionRpc } from "./extension-rpc.ts"
import { createHttpRequestHandler } from "./http-api.ts"
import type { CdpEvent, CdpRequest, JsonObject } from "./protocol.ts"
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
import { ghostCursorClientSource, ghostCursorMouseActionExpression, inputDispatchMouseEventToGhostCursorAction } from "./ghost-cursor.ts"
import { guardCdpMethod } from "./cdp-guardrails.ts"
import { HandoffRegistry, type HandoffOutcome } from "./handoff.ts"
import { ExecuteSandbox } from "./execute.ts"
import { appendJournalEntry, defaultJournalBaseDir, makeJournalEntry } from "./session-journal.ts"
import { BrowserControlSessions } from "./session-manager.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { TargetRegistry } from "./target-registry.ts"

export type { RelayServer } from "./relay-types.ts"

export function startRelay(options: { readonly host?: string; readonly port?: number } = {}) {
  return Effect.gen(function* () {
    yield* installRelayProcessGuard
    return yield* Effect.acquireRelease(makeRelay(options), (server) => {
      return server.close()
    })
  })
}

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
  if (process.env.BROWSER_CONTROL_DEBUG) {
    console.error(`[browser-control relay] ${kind} detail`, detail)
  }
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
  const journalBaseDir = defaultJournalBaseDir()
  const attachedBadge = { text: "ON", color: "#7c3aed", title: "Detach from Browser Control" }
  const executingBadge = { text: "RUN", color: "#f59e0b", title: "Browser Control is running a script" }
  const setBadgeForSessionTabs = (browserControlSessionId: string, badge: { readonly text: string; readonly color: string; readonly title: string }) => {
    for (const target of registry.listRootTargets()) {
      if (target.browserControlSessionId !== browserControlSessionId) {
        continue
      }
      // Best-effort: older shims without action.setBadge just reject the command.
      Effect.runPromise(Effect.ignore(sendToExtension({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } }))).catch(() => {})
    }
  }
  const requestHandoff = async (options: { readonly sessionId: string; readonly message: string; readonly timeoutMs: number }): Promise<HandoffOutcome> => {
    setBadgeForSessionTabs(options.sessionId, { text: "WAIT", color: "#2563eb", title: `Browser Control is waiting for you: ${options.message}` })
    try {
      return await handoffs.wait(options)
    } finally {
      setBadgeForSessionTabs(options.sessionId, sessions.isExecuting(options.sessionId) ? executingBadge : attachedBadge)
    }
  }
  const sessions: BrowserControlSessions = new BrowserControlSessions(
    endpointUrl,
    (id) =>
      new ExecuteSandbox({
        endpointUrl,
        sessionId: id,
        requestHandoff: ({ message, timeoutMs }) => requestHandoff({ sessionId: id, message, timeoutMs }),
      }),
    {
      onExecuteStateChange: (sessionId, executing) => {
        setBadgeForSessionTabs(sessionId, executing ? executingBadge : attachedBadge)
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
          handoffs: record.result.aftermath?.handoffs,
        })
        void appendJournalEntry({ baseDir: journalBaseDir, entry }).catch((error: unknown) => {
          console.error("Failed to append session journal entry", error)
        })
      },
    },
  )
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

  const debugLog = process.env.BROWSER_CONTROL_DEBUG ? (line: string) => console.error(`[bc ${new Date().toISOString().slice(11, 23)}] ${line}`) : undefined
  const websocketServer = new WebSocketServer({ noServer: true })
  const cdpClients = new Set<WebSocket>()
  const cdpClientAnnouncements = new Map<WebSocket, ReturnType<typeof createClientTargetAnnouncements>>()
  const cdpClientBrowserControlSessionIds = new Map<WebSocket, string>()
  const runtimeContextWaiters = new Set<(event: CdpEvent) => void>()
  let nextTargetSessionId = 1
  let autoAttachParams: JsonObject | undefined
  let idleRuntimeResetGeneration = 0

  const cleanup = Effect.fnUntraced(function* () {
    handoffs.cancelAll()
    recordingRelay.cleanupAll("Relay closed")
    extensionRpc.rejectPending(new Error("Relay closed"))
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
          recordingRelay.cleanupAll("Extension disconnected")
          registry.clear()
        }
      })
      return
    }

    cdpClients.add(socket)
    idleRuntimeResetGeneration++
    cdpClientAnnouncements.set(socket, createClientTargetAnnouncements())
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
    if (extensionMethod === "debugger.detached") {
      const tabId = typeof message.params?.tabId === "number" ? message.params.tabId : undefined
      const detachedSessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined
      const reason = typeof message.params?.reason === "string" ? message.params.reason : undefined
      if (detachedSessionId) {
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
    let shouldBroadcast = true
    let attachedChildTarget: ChildTarget | undefined

    if (method === "Target.attachedToTarget") {
      const childSessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (childSessionId && targetInfo) {
        if (isRestrictedTarget(targetInfo)) {
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
        if (registry.childTargets.has(childSessionId)) {
          registry.updateChildTargetInfo(targetInfo)
          shouldBroadcast = false
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
          attachedChildTarget = childTarget
        }
      }
    }
    if (method === "Target.detachedFromTarget") {
      const childSessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined
      if (childSessionId) {
        detachChildTargetState(childSessionId)
      }
    }
    if (method === "Target.targetInfoChanged") {
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (targetInfo) {
        registry.updateConnectedTargetInfo({ tabId, targetInfo })
      }
    }
    if (method === "Page.frameNavigated") {
      const frame = getObject(params?.frame)
      if (typeof frame?.url === "string" && typeof frame.parentId !== "string" && (sourceSessionId === undefined || sourceSessionId === target.sessionId)) {
        registry.updateTargetUrl(tabId, frame.url)
      }
      if (typeof frame?.id === "string" && typeof frame.parentId === "string" && params) {
        registry.rememberFrameEvent({ tabId, frameId: frame.id, navigated: params })
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
      const browserControlSessionId = target.browserControlSessionId
      // A pending handoff owns the click: resume the waiting script instead of
      // toggling attachment.
      if (browserControlSessionId && handoffs.resolveForSession(browserControlSessionId)) {
        return
      }
      if (handoffs.resolveIfSingle()) {
        return
      }
      // Never yank a tab out from under a running script; the user can click
      // again once the execute call finishes.
      if (browserControlSessionId && sessions.isExecuting(browserControlSessionId)) {
        console.error(`Ignored toolbar detach for tab ${tabId}: session ${browserControlSessionId} is executing`)
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
          debugLog?.(`cdp-> ${cdpClientBrowserControlSessionIds.get(socket) ?? "raw"} #${message.id} ${message.method} ERROR ${error.message}`)
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
    if (message.method === "Target.attachToTarget") {
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target = registry.targetsByTargetId.get(targetId)
      if (target && canSeeTarget(socket, target)) {
        sendAttachedToTarget({ socket, clientAnnouncements: cdpClientAnnouncements, target, onDuplicateTarget: logDuplicateTargetAnnouncement })
        return { sessionId: target.sessionId }
      }
      const childTarget = registry.childTargetsByTargetId.get(targetId)
      if (childTarget && canSeeTabId(socket, childTarget.tabId)) {
        sendAttachedToChildTarget({ socket, clientAnnouncements: cdpClientAnnouncements, target: childTarget, onDuplicateTarget: logDuplicateTargetAnnouncement })
        replayChildFrameNavigation({ socket, registry, target: childTarget })
        return { sessionId: childTarget.sessionId }
      }
      return yield* Effect.fail(new Error(`Target not found: ${targetId}`))
    }
    if (message.method === "Target.getTargetInfo") {
      const targetId = typeof message.params?.targetId === "string" ? message.params.targetId : ""
      const target =
        registry.targetsByTargetId.get(targetId) ??
        registry.childTargetsByTargetId.get(targetId) ??
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
        removeAnnouncedSession(cdpClientAnnouncements.get(socket), childSessionId)
      }
      return {}
    }
    const normalizedMessage = removeDefaultLightColorSchemeEmulation(message)
    if (message.method === "Runtime.enable" && message.sessionId) {
      const sessionId = message.sessionId
      const tabId = registry.tabIdForSession(sessionId)
      if (!tabId) {
        return yield* Effect.fail(new Error(`Unknown CDP session ${sessionId} for ${message.method}`))
      }
      const rootSessionId = registry.tabTargets.get(tabId)?.sessionId
      const chromeSessionId = sessionId !== rootSessionId ? { sessionId } : {}
      // Register the waiter before sending the enable so context events that
      // arrive during the command round trip are not missed.
      const contextWaiter = yield* Effect.forkChild(waitForDefaultRuntimeContext(sessionId), { startImmediately: true })
      const result = yield* sendDebuggerCommand({
        tabId,
        method: normalizedMessage.method,
        params: normalizedMessage.params ?? {},
        ...chromeSessionId,
      })
      const seenDefaultContext = yield* Fiber.join(contextWaiter)
      if (!seenDefaultContext) {
        // Chrome considered Runtime already enabled on the shared debugger
        // attachment, so it acknowledged the enable without re-emitting
        // Runtime.executionContextCreated and Playwright would wait forever
        // for an execution context. Kick a disable/enable cycle to force
        // re-emission; verified live to unstick hung page.evaluate calls.
        const retryWaiter = yield* Effect.forkChild(waitForDefaultRuntimeContext(sessionId), { startImmediately: true })
        yield* Effect.ignore(sendDebuggerCommand({ tabId, method: "Runtime.disable", params: {}, ...chromeSessionId }))
        yield* Effect.ignore(sendDebuggerCommand({ tabId, method: "Runtime.enable", params: normalizedMessage.params ?? {}, ...chromeSessionId }))
        yield* Fiber.join(retryWaiter)
      }
      return result
    }
    const tabId = message.sessionId ? registry.tabIdForSession(message.sessionId) : firstVisibleRootTarget(socket)?.tabId
    if (!tabId) {
      return yield* Effect.fail(new Error(message.sessionId ? `Unknown CDP session ${message.sessionId} for ${message.method}` : `No attached tab for ${message.method}`))
    }
    const rootSessionId = registry.tabTargets.get(tabId)?.sessionId
    const chromeSessionId = message.sessionId && message.sessionId !== rootSessionId ? message.sessionId : undefined
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
      method: "tabs.group",
      params: { tabId, ...(options.browserControlSessionId ? { title: `bc:${options.browserControlSessionId}` } : {}) },
    }))
    yield* Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: true } }))
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
      return sendDebuggerCommand({ tabId: target.tabId, method: "Runtime.disable", params: {} }).pipe(Effect.ignore)
    })
    yield* Effect.forEach(Array.from(registry.childTargets.values()), (target) => {
      if (generation !== idleRuntimeResetGeneration || cdpClients.size !== 0) {
        return Effect.void
      }
      return sendDebuggerCommand({ tabId: target.tabId, sessionId: target.sessionId, method: "Runtime.disable", params: {} }).pipe(Effect.ignore)
    })
  })

  function detachTargetState(tabId: number): void {
    void recordingRelay.abortRecordingForTab({ tabId, reason: "Tab detached" }).catch((error: unknown) => {
      console.error("Failed to abort recording for detached tab", error)
    })
    const detached = registry.detachRootTargetState(tabId)
    if (!detached) {
      return
    }
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

  function detachChildTargetState(sessionId: string): void {
    registry.detachChildTargetState(sessionId)
    for (const announcements of cdpClientAnnouncements.values()) {
      removeAnnouncedSession(announcements, sessionId)
    }
  }

  function canSeeTarget(socket: WebSocket, target: ConnectedTarget): boolean {
    return canClientSeeTarget({
      clientSessionId: cdpClientBrowserControlSessionIds.get(socket),
      targetOwnerSessionId: target.browserControlSessionId,
    })
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
    for (const client of cdpClients) {
      if (hasAnnouncedSession(cdpClientAnnouncements.get(client), rootSessionId)) {
        sendCdpEvent(client, event)
      }
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
        return canSeeTabId(socket, target.tabId)
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
