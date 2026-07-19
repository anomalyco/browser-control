import http from "node:http"
import { Effect, Schema } from "effect"
import * as AuthProfile from "./auth-profile.ts"
import { NetworkCaptureError } from "./network-capture.ts"
import {
  HttpRouteError,
  formatHostForUrl,
  headerValue,
  optionalSessionId,
  parseTargetSelection,
  readJsonBody,
  requiredSessionId,
  sendJson,
  validateBrowserFetchSite,
  validateHostHeader,
} from "./relay-helpers.ts"
import { selectTarget, TargetSelectionError } from "./execute.ts"
import {
  AuthProfileRequest,
  AuthRefreshRequest,
  AuthRunRequest,
  ExecuteRequest,
  NetworkSessionRequest,
  NetworkStartRequest,
  NetworkStopRequest,
  RecordingStartRequest,
  RecordingTargetRequest,
  SessionAdoptRequest,
  SessionIdRequest,
  SessionNewRequest,
  type TargetSummary,
} from "./relay-schema.ts"
import { SessionError, type BrowserControlSessions } from "./session-manager.ts"
import type { RecordingRelay, RecordingStartOptions, RecordingTargetOptions } from "./recording-relay.ts"
import { TargetOwnershipError, type TargetRegistry } from "./target-registry.ts"
import { browserControlBuildId, browserControlVersion } from "./version.ts"

export function createHttpRequestHandler(options: {
  readonly host: string
  readonly port: number
  readonly browserId: string
  readonly extensionStatus: () => { readonly connected: boolean; readonly version: string | null; readonly cdpClients?: number }
  readonly recordingRelay: RecordingRelay
  readonly registry: TargetRegistry
  readonly sessions: BrowserControlSessions
}): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  options.sessions.setUserAttachedPageUrlsProvider(() =>
    options.registry.listRootTargets()
      .filter((target) => target.owner === "user")
      .map((target) => target.targetInfo.url || "about:blank")
  )
  return (request, response) => {
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host: options.host, port: options.port })
    if (hostError) {
      sendJson(response, { error: hostError }, 403)
      return
    }
    const fetchSiteError = validateBrowserFetchSite(request)
    if (fetchSiteError) {
      sendJson(response, { error: fetchSiteError }, 403)
      return
    }
    const requestUrl = new URL(request.url ?? "/", `http://${formatHostForUrl(options.host)}:${options.port}`)
    const pathname = requestUrl.pathname.replace(/\/$/, "") || "/"
    if (pathname === "/" || pathname === "/version") {
      sendJson(response, { version: browserControlVersion, buildId: browserControlBuildId })
      return
    }
    if (pathname === "/json/version") {
      const browserControlSessionId = headerValue(request.headers["browser-control-session-id"])
      const webSocketDebuggerUrl = new URL(`ws://${formatHostForUrl(options.host)}:${options.port}/devtools/browser/${options.browserId}`)
      if (browserControlSessionId) {
        webSocketDebuggerUrl.searchParams.set("browserControlSessionId", browserControlSessionId)
      }
      sendJson(response, {
        Browser: `Browser-Control/${browserControlVersion}`,
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: webSocketDebuggerUrl.toString(),
      })
      return
    }
    if (pathname === "/json/list") {
      sendJson(response, targetSummaries(options.registry))
      return
    }
    if (pathname === "/extension/status") {
      const extensionStatus = options.extensionStatus()
      sendJson(response, {
        connected: extensionStatus.connected,
        version: extensionStatus.version,
        ...(extensionStatus.cdpClients === undefined ? {} : { cdpClients: extensionStatus.cdpClients }),
        activeTargets: options.registry.rootTargetCount(),
        childTargets: options.registry.childTargets.size,
        sessions: options.sessions.listSummaries(),
        targets: targetSummaries(options.registry),
      })
      return
    }
    if (pathname.startsWith("/recording/")) {
      runRequestEffect(response, handleRecordingRequest({ request, response, pathname, requestUrl, registry: options.registry, recordingRelay: options.recordingRelay }))
      return
    }
    if (pathname.startsWith("/network/")) {
      runRequestEffect(response, handleNetworkRequest({ request, response, pathname, sessions: options.sessions }))
      return
    }
    if (pathname.startsWith("/auth/")) {
      runRequestEffect(response, handleAuthRequest({ request, response, pathname, sessions: options.sessions }))
      return
    }
    if (pathname.startsWith("/cli/")) {
      runRequestEffect(response, handleCliRequest({
        request,
        response,
        pathname,
        sessions: options.sessions,
        registry: options.registry,
      }))
      return
    }
    response.writeHead(404)
    response.end("Not found")
  }
}

function handleNetworkRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: BrowserControlSessions
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/network/start" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkStartRequest, yield* readJsonBody(options.request), "network start")
      const { sessionId, ...captureOptions } = request
      const result = yield* options.sessions.networkStart(sessionId, captureOptions)
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/network/status" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkSessionRequest, yield* readJsonBody(options.request), "network status")
      sendJson(options.response, yield* options.sessions.networkStatus(request.sessionId))
      return
    }
    if (options.pathname === "/network/stop" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkStopRequest, yield* readJsonBody(options.request), "network stop")
      const { sessionId, ...stopOptions } = request
      sendJson(options.response, yield* options.sessions.networkStop(sessionId, stopOptions))
      return
    }
    if (options.pathname === "/network/cancel" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkSessionRequest, yield* readJsonBody(options.request), "network cancel")
      sendJson(options.response, yield* options.sessions.networkCancel(request.sessionId))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function handleAuthRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: BrowserControlSessions
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/auth/status" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthProfileRequest, yield* readJsonBody(options.request), "auth status")
      sendJson(options.response, yield* AuthProfile.status(request.name))
      return
    }
    if (options.pathname === "/auth/refresh" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthRefreshRequest, yield* readJsonBody(options.request), "auth refresh")
      const { sessionId, ...refreshOptions } = request
      sendJson(options.response, yield* options.sessions.authRefresh(sessionId, refreshOptions))
      return
    }
    if (options.pathname === "/auth/run" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthRunRequest, yield* readJsonBody(options.request), "auth run")
      sendJson(options.response, yield* AuthProfile.run(request))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function runRequestEffect(response: http.ServerResponse, effect: Effect.Effect<void, Error>): void {
  const controller = new AbortController()
  const onClose = () => controller.abort()
  response.once("close", onClose)
  Effect.runPromise(effect, { signal: controller.signal }).catch((error: unknown) => {
    if (response.destroyed || response.writableEnded) return
    const routeError = relayHttpError(error)
    sendJson(response, {
      error: routeError.message,
      code: routeError.code,
    }, routeError.status)
  }).finally(() => {
    response.off("close", onClose)
  })
}

function handleRecordingRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly requestUrl: URL
  readonly registry: TargetRegistry
  readonly recordingRelay: RecordingRelay
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/recording/start" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingStartRequest, body, "recording start")
      const target = resolveAttachedRecordingTarget({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const startOptions: RecordingStartOptions = {
        tabId: target.tabId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        owner: target.owner,
        outputPath: request.outputPath,
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(request.frameRate === undefined ? {} : { frameRate: request.frameRate }),
        ...(request.audio === undefined ? {} : { audio: request.audio }),
        ...(request.videoBitsPerSecond === undefined ? {} : { videoBitsPerSecond: request.videoBitsPerSecond }),
        ...(request.audioBitsPerSecond === undefined ? {} : { audioBitsPerSecond: request.audioBitsPerSecond }),
        ...(request.maxDurationMs === undefined ? {} : { maxDurationMs: request.maxDurationMs }),
      }
      const result = yield* Effect.tryPromise({
        try: () => options.recordingRelay.startRecording(startOptions),
        catch: (cause) => new Error(formatCauseMessage({ label: "start recording", cause }), { cause }),
      })
      sendJson(options.response, result, result.success ? 200 : 500)
      return
    }
    if (options.pathname === "/recording/stop" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingTargetRequest, body, "recording stop")
      const target = recordingTargetFromValues({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* Effect.tryPromise({
        try: () => options.recordingRelay.stopRecording(target),
        catch: (cause) => new Error(formatCauseMessage({ label: "stop recording", cause }), { cause }),
      })
      sendJson(options.response, result, result.success ? 200 : 500)
      return
    }
    if (options.pathname === "/recording/status" && options.request.method === "GET") {
      const target = recordingTargetFromQuery({ registry: options.registry, searchParams: options.requestUrl.searchParams })
      const result = yield* Effect.tryPromise({
        try: () => options.recordingRelay.statusRecording(target),
        catch: (cause) => new Error(formatCauseMessage({ label: "recording status", cause }), { cause }),
      })
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/recording/cancel" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingTargetRequest, body, "recording cancel")
      const target = recordingTargetFromValues({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* Effect.tryPromise({
        try: () => options.recordingRelay.cancelRecording(target),
        catch: (cause) => new Error(formatCauseMessage({ label: "cancel recording", cause }), { cause }),
      })
      sendJson(options.response, result, result.success ? 200 : 500)
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function formatCauseMessage(options: { readonly label: string; readonly cause: unknown }): string {
  if (options.cause instanceof Error && options.cause.message) {
    return `${options.label}: ${options.cause.message}`
  }
  if (typeof options.cause === "string" && options.cause) {
    return `${options.label}: ${options.cause}`
  }
  return options.label
}

function handleCliRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: BrowserControlSessions
  readonly registry: TargetRegistry
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/cli/sessions" && options.request.method === "GET") {
      sendJson(options.response, { sessions: options.sessions.listSummaries() })
      return
    }
    if (options.pathname === "/cli/session/new" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionNewRequest, body, "session new")
      const session = options.sessions.createNew(optionalSessionId(request.id), { readOnly: request.readOnly === true })
      sendJson(options.response, { session: options.sessions.summary(session.id) })
      return
    }
    if (options.pathname === "/cli/session/delete" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionIdRequest, body, "session delete")
      const id = requiredSessionId(request.id)
      const deleted = yield* options.sessions.delete(id)
      if (!deleted) {
        sendJson(options.response, { error: `Session not found: ${id}`, code: "session-not-found" }, 404)
        return
      }
      sendJson(options.response, { deleted: true, id })
      return
    }
    if (options.pathname === "/cli/session/reset" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionIdRequest, body, "session reset")
      const id = requiredSessionId(request.id)
      const session = yield* options.sessions.reset(id)
      if (!session) {
        sendJson(options.response, { error: `Session not found: ${id}`, code: "session-not-found" }, 404)
        return
      }
      sendJson(options.response, { session })
      return
    }
    if (options.pathname === "/cli/session/adopt" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionAdoptRequest, body, "session adopt")
      const requestedSessionId = optionalSessionId(request.sessionId)
      const targetSelection = parseTargetSelection(request.targetSelection)
      if (!targetSelection) {
        throw new Error("targetSelection is required")
      }
      const selectedTarget = selectTarget({
        targets: options.registry.listRootTargets(),
        selection: targetSelection,
        getUrl: (target) => target.targetInfo.url,
      })
      if (!selectedTarget) {
        throw new Error("No page matched target selection")
      }
      const adoptedTargetId = selectedTarget.targetInfo.targetId
      const { session, adoptedUrl } = yield* options.sessions.adopt({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        createIfMissing: request.createIfMissing,
        targetId: adoptedTargetId,
        targetUrl: selectedTarget.targetInfo.url,
      })
      sendJson(options.response, { session, adoptedUrl, adoptedTargetId })
      return
    }
    if (options.pathname === "/cli/execute" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(ExecuteRequest, body, "execute")
      const requestedSessionId = optionalSessionId(request.sessionId)
      const targetSelection = parseTargetSelection(request.targetSelection)
      const { result, session } = yield* options.sessions.execute({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        code: request.code,
        createIfMissing: request.createIfMissing,
        ...(targetSelection ? { targetSelection } : {}),
      })
      const { setupFailed: _setupFailed, ...wireResult } = result
      sendJson(options.response, { ...wireResult, session })
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function targetSummaries(registry: TargetRegistry): TargetSummary[] {
  return registry.listRootTargets().map((target) => {
      return {
        id: target.targetInfo.targetId,
        type: target.targetInfo.type,
        title: target.targetInfo.title,
        url: target.targetInfo.url,
        tabId: target.tabId,
        sessionId: target.sessionId,
        ...(target.browserControlSessionId ? { browserControlSessionId: target.browserControlSessionId } : {}),
        owner: target.owner,
        ...(target.crashed ? { crashed: true } : {}),
      }
  })
}

function decodeRequest<A>(schema: Schema.ConstraintDecoder<A>, body: unknown, label: string): Effect.Effect<A, Error> {
  return Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((cause) => new HttpRouteError({
      message: `Invalid ${label} request: ${cause.message}`,
      status: 400,
      code: "invalid-request",
    })),
  )
}

function resolveAttachedRecordingTarget(options: {
  readonly registry: TargetRegistry
  readonly tabId: unknown
  readonly sessionId: unknown
}): { readonly tabId: number; readonly sessionId?: string; readonly owner: "relay" | "user" } {
  const tabId = optionalInteger(options.tabId, "tabId")
  if (tabId !== undefined) {
    const target = options.registry.getRootTargetByTabId(tabId)
    if (!target) {
      throw new HttpRouteError({ message: `No attached tab found for tabId ${tabId}`, status: 404, code: "target-not-found" })
    }
    return { tabId, sessionId: target.sessionId, owner: target.owner }
  }
  const sessionId = typeof options.sessionId === "string" && options.sessionId ? options.sessionId : undefined
  if (sessionId) {
    const target = options.registry.getRootTargetBySessionId(sessionId)
    if (!target) {
      throw new HttpRouteError({ message: `No attached tab found for sessionId ${sessionId}`, status: 404, code: "target-not-found" })
    }
    return { tabId: target.tabId, sessionId: target.sessionId, owner: target.owner }
  }
  const targets = options.registry.listRootTargets()
  if (targets.length === 0) {
    throw new HttpRouteError({ message: "No attached tab available for recording", status: 404, code: "target-not-found" })
  }
  if (targets.length > 1) {
    throw new HttpRouteError({ message: "Multiple attached tabs available; provide sessionId or tabId", status: 409, code: "target-ambiguous" })
  }
  const target = targets[0]
  if (!target) {
    throw new HttpRouteError({ message: "No attached tab available for recording", status: 404, code: "target-not-found" })
  }
  return { tabId: target.tabId, sessionId: target.sessionId, owner: target.owner }
}

function recordingTargetFromValues(options: { readonly registry: TargetRegistry; readonly tabId: unknown; readonly sessionId: unknown }): RecordingTargetOptions {
  const tabId = optionalInteger(options.tabId, "tabId")
  const sessionId = typeof options.sessionId === "string" && options.sessionId ? options.sessionId : undefined
  const target = sessionId ? options.registry.getRootTargetBySessionId(sessionId) : undefined
  return {
    ...(tabId === undefined ? {} : { tabId }),
    ...(target?.sessionId ? { sessionId: target.sessionId } : sessionId ? { sessionId } : {}),
  }
}

function recordingTargetFromQuery(options: { readonly registry: TargetRegistry; readonly searchParams: URLSearchParams }): RecordingTargetOptions {
  const tabIdText = options.searchParams.get("tabId")
  const sessionId = options.searchParams.get("sessionId") ?? undefined
  const tabId = tabIdText ? optionalInteger(Number(tabIdText), "tabId") : undefined
  const target = sessionId ? options.registry.getRootTargetBySessionId(sessionId) : undefined
  return {
    ...(tabId === undefined ? {} : { tabId }),
    ...(target?.sessionId ? { sessionId: target.sessionId } : sessionId ? { sessionId } : {}),
  }
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpRouteError({ message: `${field} must be an integer`, status: 400, code: "invalid-request" })
  }
  return value
}

export function relayHttpError(error: unknown): HttpRouteError {
  if (error instanceof HttpRouteError) {
    return error
  }
  if (error instanceof SessionError) {
    switch (error.reason) {
      case "already-exists":
        return new HttpRouteError({ message: error.message, status: 409, code: "session-already-exists" })
      case "inactive":
        return new HttpRouteError({ message: error.message, status: 409, code: "session-inactive" })
      case "invalid-request":
        return new HttpRouteError({ message: error.message, status: 400, code: "invalid-request" })
      case "not-found":
        return new HttpRouteError({ message: error.message, status: 404, code: "session-not-found" })
      case "target-owned":
        return new HttpRouteError({ message: error.message, status: 409, code: "target-owned" })
      case "timeout":
        return new HttpRouteError({ message: error.message, status: 409, code: "session-timeout" })
      case "setup-failed":
        return new HttpRouteError({ message: error.message, status: 500, code: "setup-failed" })
    }
  }
  if (error instanceof NetworkCaptureError) {
    return new HttpRouteError({
      message: error.message,
      status: error.reason === "invalid-options" ? 400 : error.reason === "already-active" || error.reason === "inactive" ? 409 : 500,
      code: error.reason === "invalid-options" ? "invalid-request" : error.reason === "already-active" || error.reason === "inactive" ? "capture-conflict" : "internal",
    })
  }
  if (error instanceof AuthProfile.AuthProfileError) {
    return new HttpRouteError({
      message: error.message,
      status: error.reason === "invalid-name" ? 400 : error.reason === "not-found" ? 404 : 500,
      code: error.reason === "invalid-name" ? "invalid-request" : error.reason === "not-found" ? "auth-profile-not-found" : "internal",
    })
  }
  if (error instanceof TargetSelectionError) {
    return new HttpRouteError({
      message: error.message,
      status: error.reason === "invalid" ? 400 : error.reason === "not-found" ? 404 : 409,
      code: error.reason === "invalid" ? "invalid-request" : error.reason === "not-found" ? "target-not-found" : "target-ambiguous",
    })
  }
  if (error instanceof TargetOwnershipError) {
    return new HttpRouteError({
      message: error.message,
      status: error.reason === "not-found" ? 404 : 409,
      code: error.reason === "not-found" ? "target-not-found" : error.reason === "owned" ? "target-owned" : "target-changed",
    })
  }
  return new HttpRouteError({
    message: error instanceof Error ? error.message : String(error),
    status: 500,
    code: "internal",
  })
}
