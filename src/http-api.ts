import http from "node:http"
import { Effect, Schema } from "effect"
import * as AuthProfile from "./auth-profile.ts"
import { AuthenticatedOriginError } from "./authenticated-origin.ts"
import { NetworkCaptureError } from "./network-capture.ts"
import {
  HttpRouteError,
  formatHostForUrl,
  headerValue,
  optionalSessionId,
  readJsonBody,
  requiredSessionId,
  sendJson,
  validateBrowserFetchSite,
  validateHostHeader,
} from "./relay-helpers.ts"
import { selectTarget, TargetSelectionError } from "./execute.ts"
import {
  AuthProfileRequest,
  AuthenticatedJsonRequest,
  AuthRefreshRequest,
  AuthRunRequest,
  BrowserProfileNameRequest,
  ExecuteRequest,
  NetworkSessionRequest,
  NetworkStartRequest,
  NetworkStopRequest,
  RecordingStartRequest,
  RecordingTargetRequest,
  RelayShutdownRequest,
  SessionAdoptRequest,
  SessionIdRequest,
  SessionEnsureRequest,
  SessionNewRequest,
  type ExtensionStatus,
  type TargetSummary,
} from "./relay-schema.ts"
import { SessionError } from "./session-manager.ts"
import type { RecordingStartOptions, RecordingTargetOptions } from "./recording-relay.ts"
import type { RelayProfiles, RelayProfileRuntime } from "./relay.ts"
import { TargetOwnershipError, type TargetRegistry } from "./target-registry.ts"
import { browserControlBuildId, browserControlVersion } from "./version.ts"
import { RelayShutdown, RelayShutdownError } from "./relay-shutdown.ts"

export function createHttpRequestHandler(options: {
  readonly host: string
  readonly port: number
  readonly browserId: string
  readonly relayInstance: { readonly id: string; readonly startedAt: string; readonly pid: number; readonly managed: boolean }
  readonly shutdown: RelayShutdown
  readonly profiles: RelayProfiles
  readonly extensionStatus?: () => Pick<ExtensionStatus, "connected" | "version" | "protocolVersion" | "protocolCompatible" | "protocolLegacy" | "rejectedConnections" | "cdpClients" | "profiles">
}): (request: http.IncomingMessage, response: http.ServerResponse) => void {
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
    const observational = request.method === "GET" || pathname === "/network/status" || pathname === "/auth/status"
    const run = (effect: Effect.Effect<void, Error>, settle = false): void => {
      runRequestEffect(response, observational ? effect : options.shutdown.track(settle ? Effect.uninterruptible(effect) : effect))
    }
    if (pathname === "/" || pathname === "/version") {
      sendJson(response, {
        version: browserControlVersion,
        buildId: browserControlBuildId,
        instanceId: options.relayInstance.id,
        startedAt: options.relayInstance.startedAt,
        pid: options.relayInstance.pid,
        managed: options.relayInstance.managed,
        shutdownProtocol: 2,
      })
      return
    }
    if (pathname === "/shutdown" && request.method === "POST") {
      runRequestEffect(response, Effect.gen(function* () {
        const body = yield* decodeRequest(RelayShutdownRequest, yield* readJsonBody(request), "relay shutdown")
        yield* options.shutdown.request(body)
        sendJson(response, { stopping: true })
      }))
      return
    }
    if (pathname === "/json/version") {
      runRequestEffect(response, Effect.sync(() => {
        const browserControlSessionId = headerValue(request.headers["browser-control-session-id"])
        const profileId = requestUrl.searchParams.get("profileId") ?? headerValue(request.headers["browser-control-profile-id"])
        const runtime = options.profiles.select({
          ...(browserControlSessionId ? { sessionId: browserControlSessionId } : {}),
          ...(profileId ? { profileId } : {}),
        })
        const webSocketDebuggerUrl = new URL(`ws://${formatHostForUrl(options.host)}:${options.port}/devtools/browser/${options.browserId}`)
        webSocketDebuggerUrl.searchParams.set("profileId", runtime.profileId)
        if (browserControlSessionId) {
          webSocketDebuggerUrl.searchParams.set("browserControlSessionId", browserControlSessionId)
        }
        sendJson(response, {
          Browser: `Browser-Control/${browserControlVersion}`,
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: webSocketDebuggerUrl.toString(),
        })
      }))
      return
    }
    if (pathname === "/json/list") {
      sendJson(response, options.profiles.list().flatMap((runtime) => targetSummaries(runtime)))
      return
    }
    if (pathname === "/extension/status") {
      const runtimes = options.profiles.list()
      const statuses = runtimes.map((runtime) => runtime.extensionStatus())
      const connected = statuses.filter((status) => status.connected)
      const primary = connected.length === 1 ? connected[0] : statuses.length === 1 ? statuses[0] : undefined
      const extensionStatus: Pick<ExtensionStatus, "connected" | "version" | "protocolVersion" | "protocolCompatible" | "protocolLegacy" | "rejectedConnections" | "cdpClients" | "profiles"> = options.extensionStatus?.() ?? {
        connected: connected.length > 0,
        version: primary?.version ?? null,
        protocolVersion: primary?.protocolVersion ?? null,
        protocolCompatible: connected.length > 0 ? connected.every((status) => status.protocolCompatible === true) : null,
        protocolLegacy: connected.length > 0 ? connected.some((status) => status.protocolLegacy === true) : null,
        rejectedConnections: statuses.reduce((count, status) => count + status.rejectedConnections, 0),
        cdpClients: statuses.reduce((count, status) => count + status.cdpClients, 0),
        profiles: runtimes.map((runtime, index) => ({
          id: runtime.profileId,
          ...(runtime.profileName === undefined ? {} : { name: runtime.profileName }),
          connected: statuses[index]!.connected,
          version: statuses[index]!.version,
          activeTargets: runtime.registry.rootTargetCount(),
        })),
      }
      sendJson(response, {
        connected: extensionStatus.connected,
        version: extensionStatus.version,
        ...(extensionStatus.protocolVersion === undefined ? {} : { protocolVersion: extensionStatus.protocolVersion }),
        ...(extensionStatus.protocolCompatible === undefined ? {} : { protocolCompatible: extensionStatus.protocolCompatible }),
        ...(extensionStatus.protocolLegacy === undefined ? {} : { protocolLegacy: extensionStatus.protocolLegacy }),
        ...(extensionStatus.rejectedConnections === undefined ? {} : { rejectedConnections: extensionStatus.rejectedConnections }),
        ...(extensionStatus.cdpClients === undefined ? {} : { cdpClients: extensionStatus.cdpClients }),
        ...(extensionStatus.profiles === undefined ? {} : { profiles: extensionStatus.profiles }),
        activeTargets: options.profiles.list().reduce((count, runtime) => count + runtime.registry.rootTargetCount(), 0),
        childTargets: options.profiles.list().reduce((count, runtime) => count + runtime.registry.childTargets.size, 0),
        sessions: options.profiles.list().flatMap((runtime) => runtime.sessions.listSummaries()),
        targets: options.profiles.list().flatMap((runtime) => targetSummaries(runtime)),
      })
      return
    }
    if (pathname === "/profiles/name" && request.method === "POST") {
      run(Effect.gen(function* () {
        const body = yield* decodeRequest(BrowserProfileNameRequest, yield* readJsonBody(request), "profile name")
        const runtime = options.profiles.select({ profileId: body.profileId })
        const profile = yield* Effect.tryPromise({
          try: () => runtime.renameProfile(body.name),
          catch: (cause) => cause instanceof Error ? cause : new Error("Rename browser profile", { cause }),
        })
        sendJson(response, profile)
      }), true)
      return
    }
    if (pathname.startsWith("/recording/")) {
      run(handleRecordingRequest({ request, response, pathname, requestUrl, profiles: options.profiles }), true)
      return
    }
    if (pathname.startsWith("/network/")) {
      run(handleNetworkRequest({ request, response, pathname, profiles: options.profiles }))
      return
    }
    if (pathname.startsWith("/auth/")) {
      run(handleAuthRequest({ request, response, pathname, profiles: options.profiles }), pathname === "/auth/run")
      return
    }
    if (pathname.startsWith("/v1/")) {
      run(handleClientRequest({
        request,
        response,
        pathname,
        profiles: options.profiles,
      }))
      return
    }
    if (pathname.startsWith("/cli/")) {
      run(handleCliRequest({
        request,
        response,
        pathname,
        profiles: options.profiles,
      }))
      return
    }
    response.writeHead(404)
    response.end("Not found")
  }
}

function handleClientRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly profiles: RelayProfiles
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/v1/sessions/ensure" && options.request.method === "POST") {
      const request = yield* decodeRequest(SessionEnsureRequest, yield* readJsonBody(options.request), "session ensure")
      const { sessions } = yield* options.profiles.bind({ sessionId: request.id, ...(request.profileId ? { profileId: request.profileId } : {}) })
      sendJson(options.response, {
        session: yield* sessions.ensure(request.id, {
          ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
        }),
      })
      return
    }
    if (options.pathname === "/v1/authenticated-origin/json" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthenticatedJsonRequest, yield* readJsonBody(options.request), "authenticated origin")
      options.response.setHeader("cache-control", "no-store")
      const { sessions } = yield* options.profiles.bind({ sessionId: request.sessionId })
      sendJson(options.response, yield* sessions.authenticatedJson(request))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function handleNetworkRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly profiles: RelayProfiles
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/network/start" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkStartRequest, yield* readJsonBody(options.request), "network start")
      const { sessionId, ...captureOptions } = request
      const { sessions } = yield* options.profiles.bind({ sessionId })
      const result = yield* sessions.networkStart(sessionId, captureOptions)
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/network/status" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkSessionRequest, yield* readJsonBody(options.request), "network status")
      const { sessions } = options.profiles.select({ sessionId: request.sessionId })
      sendJson(options.response, yield* sessions.networkStatus(request.sessionId))
      return
    }
    if (options.pathname === "/network/stop" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkStopRequest, yield* readJsonBody(options.request), "network stop")
      const { sessionId, ...stopOptions } = request
      const { sessions } = yield* options.profiles.bind({ sessionId })
      sendJson(options.response, yield* sessions.networkStop(sessionId, stopOptions))
      return
    }
    if (options.pathname === "/network/cancel" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkSessionRequest, yield* readJsonBody(options.request), "network cancel")
      const { sessions } = yield* options.profiles.bind({ sessionId: request.sessionId })
      sendJson(options.response, yield* sessions.networkCancel(request.sessionId))
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
  readonly profiles: RelayProfiles
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
      const { sessions } = yield* options.profiles.bind({ sessionId })
      sendJson(options.response, yield* sessions.authRefresh(sessionId, refreshOptions))
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
  readonly profiles: RelayProfiles
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/recording/start" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingStartRequest, body, "recording start")
      const { registry, recordingRelay } = recordingProfile(options.profiles, request)
      const { tabId, sessionId, profileId: _profileId, ...recordingOptions } = request
      const target = resolveAttachedRecordingTarget({ registry, tabId, sessionId })
      const startOptions: RecordingStartOptions = {
        ...recordingOptions,
        tabId: target.tabId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        owner: target.owner,
      }
      const result = yield* Effect.tryPromise({
        try: () => recordingRelay.startRecording(startOptions),
        catch: (cause) => new Error(formatCauseMessage({ label: "start recording", cause }), { cause }),
      })
      sendJson(options.response, result, result.success ? 200 : 500)
      return
    }
    if (options.pathname === "/recording/stop" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingTargetRequest, body, "recording stop")
      const { registry, recordingRelay } = recordingProfile(options.profiles, request)
      const target = recordingTargetFromValues({ registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* Effect.tryPromise({
        try: () => recordingRelay.stopRecording(target),
        catch: (cause) => new Error(formatCauseMessage({ label: "stop recording", cause }), { cause }),
      })
      sendJson(options.response, result, result.success ? 200 : 500)
      return
    }
    if (options.pathname === "/recording/status" && options.request.method === "GET") {
      const searchParams = options.requestUrl.searchParams
      const { registry, recordingRelay } = recordingProfile(options.profiles, {
        ...(searchParams.get("profileId") ? { profileId: searchParams.get("profileId")! } : {}),
        ...(searchParams.get("sessionId") ? { sessionId: searchParams.get("sessionId")! } : {}),
        ...(searchParams.get("tabId") ? { tabId: optionalInteger(Number(searchParams.get("tabId")), "tabId")! } : {}),
      })
      const target = recordingTargetFromQuery({ registry, searchParams })
      const result = yield* Effect.tryPromise({
        try: () => recordingRelay.statusRecording(target),
        catch: (cause) => new Error(formatCauseMessage({ label: "recording status", cause }), { cause }),
      })
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/recording/cancel" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingTargetRequest, body, "recording cancel")
      const { registry, recordingRelay } = recordingProfile(options.profiles, request)
      const target = recordingTargetFromValues({ registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* Effect.tryPromise({
        try: () => recordingRelay.cancelRecording(target),
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
  readonly profiles: RelayProfiles
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/cli/sessions" && options.request.method === "GET") {
      sendJson(options.response, { sessions: options.profiles.list().flatMap((runtime) => runtime.sessions.listSummaries()) })
      return
    }
    if (options.pathname === "/cli/session/new" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionNewRequest, body, "session new")
      const id = optionalSessionId(request.id)
      const { sessions } = yield* options.profiles.bind({ ...(id ? { sessionId: id } : {}), ...(request.profileId ? { profileId: request.profileId } : {}) })
      const session = yield* sessions.create(id, { readOnly: request.readOnly === true })
      sendJson(options.response, { session: sessions.summary(session.id) })
      return
    }
    if (options.pathname === "/cli/session/delete" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionIdRequest, body, "session delete")
      const id = requiredSessionId(request.id)
      const owner = options.profiles.list().find((runtime) => runtime.sessions.sessions.has(id))
      const runtime = owner?.profileId === "unbound" && owner.sessions.sessions.get(id)?.target
        ? yield* options.profiles.bind({ sessionId: id })
        : owner
      const deleted = runtime ? yield* runtime.sessions.delete(id) : false
      sendJson(options.response, { deleted, id })
      return
    }
    if (options.pathname === "/cli/session/reset" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionIdRequest, body, "session reset")
      const id = requiredSessionId(request.id)
      const owner = options.profiles.list().find((runtime) => runtime.sessions.sessions.has(id))
      const runtime = owner?.profileId === "unbound" && owner.sessions.sessions.get(id)?.target
        ? yield* options.profiles.bind({ sessionId: id })
        : owner
      const session = runtime ? yield* runtime.sessions.reset(id) : undefined
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
      const { sessions, registry } = yield* options.profiles.bind({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        ...(request.profileId ? { profileId: request.profileId } : {}),
      })
      const selectedTarget = selectTarget({
        targets: registry.listRootTargets(),
        selection: request.targetSelection,
        getUrl: (target) => target.targetInfo.url,
      })
      if (!selectedTarget) {
        throw new Error("No page matched target selection")
      }
      const adoptedTargetId = selectedTarget.targetInfo.targetId
      const { session, adoptedUrl } = yield* sessions.adopt({
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
      const { sessions } = yield* options.profiles.bind({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        ...(request.profileId ? { profileId: request.profileId } : {}),
      })
      const { result, session } = yield* sessions.execute({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        code: request.code,
        createIfMissing: request.createIfMissing,
        ...(request.targetSelection ? { targetSelection: request.targetSelection } : {}),
      })
      const { setupFailed: _setupFailed, ...wireResult } = result
      sendJson(options.response, { ...wireResult, session })
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function targetSummaries(runtime: RelayProfileRuntime): TargetSummary[] {
  return runtime.registry.listRootTargets().map((target) => {
      return {
        id: target.targetInfo.targetId,
        profileId: runtime.profileId,
        ...(runtime.profileName === undefined ? {} : { profileName: runtime.profileName }),
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

function recordingProfile(profiles: RelayProfiles, options: {
  readonly profileId?: string
  readonly tabId?: number
  readonly sessionId?: string
}): RelayProfileRuntime {
  if (options.profileId) return profiles.select({ profileId: options.profileId })
  const runtimes = profiles.list()
  if (runtimes.filter((runtime) => runtime.profileId !== "unbound").length > 1) {
    throw new HttpRouteError({ message: "Recording target identifiers are browser-profile-local; provide profileId when multiple profiles are known", status: 409, code: "profile-ambiguous" })
  }
  const matches = runtimes.filter((runtime) => {
    const byTab = options.tabId === undefined ? undefined : runtime.registry.getRootTargetByTabId(options.tabId)
    const bySession = options.sessionId === undefined ? undefined : runtime.registry.getRootTargetBySessionId(options.sessionId)
    if (options.tabId !== undefined && options.sessionId !== undefined) return byTab !== undefined && byTab === bySession
    return byTab !== undefined || bySession !== undefined
  })
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new HttpRouteError({ message: "Recording target matches multiple browser profiles; provide profileId", status: 409, code: "profile-ambiguous" })
  }
  if (runtimes.length === 1) return runtimes[0]!
  if (options.tabId !== undefined || options.sessionId !== undefined) {
    throw new HttpRouteError({ message: "Recording target not found in a unique browser profile; provide profileId", status: 404, code: "target-not-found" })
  }
  return profiles.select({})
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
  return recordingTargetFromValues({
    registry: options.registry,
    tabId: tabIdText ? Number(tabIdText) : undefined,
    sessionId: options.searchParams.get("sessionId") ?? undefined,
  })
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

function relayHttpError(error: unknown): HttpRouteError {
  if (error instanceof RelayShutdownError) {
    return new HttpRouteError({ message: error.message, status: 409, code: error.reason === "busy" ? "relay-busy" : "invalid-request" })
  }
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
  if (error instanceof AuthenticatedOriginError) {
    return new HttpRouteError({
      message: error.message,
      status: error.reason === "invalid-request" ? 400 : 500,
      code: error.reason === "invalid-request" ? "invalid-request" : "setup-failed",
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
