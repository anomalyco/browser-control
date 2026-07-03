import http from "node:http"
import { Effect, Schema } from "effect"
import {
  HttpRouteError,
  formatHostForUrl,
  headerValue,
  optionalSessionId,
  parseTargetSelection,
  readJsonBody,
  requiredBoolean,
  requiredSessionId,
  requiredString,
  sendJson,
  validateBrowserFetchSite,
  validateHostHeader,
} from "./relay-helpers.ts"
import { selectTarget } from "./execute.ts"
import { SessionAdoptRequest } from "./relay-schema.ts"
import type { BrowserControlSessions } from "./session-manager.ts"
import type { RecordingMode, RecordingRelay, RecordingStartOptions, RecordingTargetOptions } from "./recording-relay.ts"
import type { TargetRegistry } from "./target-registry.ts"
import { browserControlVersion } from "./version.ts"

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
      sendJson(response, { version: browserControlVersion })
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
      Effect.runPromise(handleRecordingRequest({ request, response, pathname, requestUrl, registry: options.registry, recordingRelay: options.recordingRelay })).catch((error: unknown) => {
        sendJson(response, {
          error: error instanceof Error ? error.message : String(error),
        }, error instanceof HttpRouteError ? error.status : 500)
      })
      return
    }
    if (pathname.startsWith("/cli/")) {
      Effect.runPromise(handleCliRequest({ request, response, pathname, sessions: options.sessions, registry: options.registry })).catch((error: unknown) => {
        sendJson(response, {
          error: error instanceof Error ? error.message : String(error),
        }, error instanceof HttpRouteError ? error.status : 500)
      })
      return
    }
    response.writeHead(404)
    response.end("Not found")
  }
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
      const target = resolveAttachedRecordingTarget({ registry: options.registry, tabId: body.tabId, sessionId: body.sessionId })
      const outputPath = requiredString(body.outputPath, "outputPath")
      const frameRate = optionalNumber(body.frameRate)
      const videoBitsPerSecond = optionalNumber(body.videoBitsPerSecond)
      const audioBitsPerSecond = optionalNumber(body.audioBitsPerSecond)
      const maxDurationMs = optionalNumber(body.maxDurationMs)
      const mode = optionalRecordingMode(body.mode)
      const startOptions: RecordingStartOptions = {
        tabId: target.tabId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        owner: target.owner,
        outputPath,
        ...(mode === undefined ? {} : { mode }),
        ...(frameRate === undefined ? {} : { frameRate }),
        ...(typeof body.audio === "boolean" ? { audio: body.audio } : {}),
        ...(videoBitsPerSecond === undefined ? {} : { videoBitsPerSecond }),
        ...(audioBitsPerSecond === undefined ? {} : { audioBitsPerSecond }),
        ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
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
      const target = recordingTargetFromValues({ registry: options.registry, tabId: body.tabId, sessionId: body.sessionId })
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
      const target = recordingTargetFromValues({ registry: options.registry, tabId: body.tabId, sessionId: body.sessionId })
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
      const session = options.sessions.createNew(optionalSessionId(body.id), { readOnly: body.readOnly === true })
      sendJson(options.response, { session: options.sessions.summary(session.id) })
      return
    }
    if (options.pathname === "/cli/session/delete" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const id = requiredSessionId(body.id)
      const adoptedTargetId = options.sessions.adoptedTargetId(id)
      const deleted = yield* options.sessions.delete(id)
      if (!deleted) {
        sendJson(options.response, { error: `Session not found: ${id}` }, 404)
        return
      }
      releaseSessionTargets(options.registry, id, adoptedTargetId ? [adoptedTargetId] : [])
      sendJson(options.response, { deleted: true, id })
      return
    }
    if (options.pathname === "/cli/session/reset" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const id = requiredSessionId(body.id)
      const adoptedTargetId = options.sessions.adoptedTargetId(id)
      const session = yield* options.sessions.reset(id)
      if (!session) {
        sendJson(options.response, { error: `Session not found: ${id}` }, 404)
        return
      }
      releaseSessionTargets(options.registry, id, adoptedTargetId ? [adoptedTargetId] : [])
      sendJson(options.response, { session })
      return
    }
    if (options.pathname === "/cli/session/adopt" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* Schema.decodeUnknownEffect(SessionAdoptRequest)(body).pipe(
        Effect.mapError((cause) => new Error(`Invalid session adopt request: ${cause.message}`)),
      )
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
      const { session, adoptedUrl, releasedTargetIds } = yield* options.sessions.adopt({
        sessionId: request.sessionId,
        createIfMissing: request.createIfMissing,
        targetId: adoptedTargetId,
        targetUrl: selectedTarget.targetInfo.url,
      })
      releaseSessionTargets(options.registry, request.sessionId, releasedTargetIds)
      sendJson(options.response, { session, adoptedUrl, adoptedTargetId })
      return
    }
    if (options.pathname === "/cli/execute" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const sessionId = requiredSessionId(body.sessionId)
      const code = requiredString(body.code, "code")
      const createIfMissing = requiredBoolean(body.createIfMissing, "createIfMissing")
      const targetSelection = parseTargetSelection(body.targetSelection)
      const { result, session } = yield* options.sessions.execute({ sessionId, code, createIfMissing, ...(targetSelection ? { targetSelection } : {}) })
      sendJson(options.response, { ...result, session })
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function targetSummaries(registry: TargetRegistry) {
  return registry.listRootTargets().map((target) => {
      return {
        id: target.targetInfo.targetId,
        type: target.targetInfo.type,
        title: target.targetInfo.title,
        url: target.targetInfo.url,
        tabId: target.tabId,
        sessionId: target.sessionId,
        browserControlSessionId: target.browserControlSessionId,
        owner: target.owner,
      }
  })
}

export function releaseSessionTargets(registry: TargetRegistry, browserControlSessionId: string, targetIds: readonly string[]): void {
  const releaseTargetIds = new Set(targetIds)
  if (releaseTargetIds.size === 0) {
    return
  }
  for (const target of registry.listRootTargets()) {
    if (target.browserControlSessionId !== browserControlSessionId) {
      continue
    }
    if (!releaseTargetIds.has(target.targetInfo.targetId)) {
      continue
    }
    const { browserControlSessionId: _released, ...releasedTarget } = target
    registry.addRootTarget(releasedTarget)
  }
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
      throw new HttpRouteError(`No attached tab found for tabId ${tabId}`, 404)
    }
    return { tabId, sessionId: target.sessionId, owner: target.owner }
  }
  const sessionId = typeof options.sessionId === "string" && options.sessionId ? options.sessionId : undefined
  if (sessionId) {
    const target = options.registry.getRootTargetBySessionId(sessionId)
    if (!target) {
      throw new HttpRouteError(`No attached tab found for sessionId ${sessionId}`, 404)
    }
    return { tabId: target.tabId, sessionId: target.sessionId, owner: target.owner }
  }
  const targets = options.registry.listRootTargets()
  if (targets.length === 0) {
    throw new HttpRouteError("No attached tab available for recording", 404)
  }
  if (targets.length > 1) {
    throw new HttpRouteError("Multiple attached tabs available; provide sessionId or tabId", 400)
  }
  const target = targets[0]
  if (!target) {
    throw new HttpRouteError("No attached tab available for recording", 404)
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

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpRouteError("Expected finite number", 400)
  }
  return value
}

function optionalRecordingMode(value: unknown): RecordingMode | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === "auto" || value === "tab-capture" || value === "cdp") {
    return value
  }
  throw new HttpRouteError("mode must be auto, tab-capture, or cdp", 400)
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpRouteError(`${field} must be an integer`, 400)
  }
  return value
}
