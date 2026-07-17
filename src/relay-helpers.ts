import http from "node:http"
import { Effect, Schema } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import type { ExecuteTargetSelection } from "./execute.ts"
import type { CdpEvent, CdpResponse, JsonObject, TargetInfo } from "./protocol.ts"
import { parseJsonObject } from "./protocol.ts"
import type { BrowserControlSession } from "./relay-types.ts"
import { RelayErrorCode } from "./relay-schema.ts"

export const defaultHost = "127.0.0.1"
export const defaultPort = 19989

const maxCliBodyBytes = 1_000_000

export class HttpRouteError extends Schema.TaggedErrorClass<HttpRouteError>()(
  "HttpApi.HttpRouteError",
  { message: Schema.String, status: Schema.Number, code: RelayErrorCode },
) {}

export function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`
  }
  return host
}

export function validateHostHeader(options: {
  readonly hostHeader: string | undefined
  readonly host: string
  readonly port: number
}): string | undefined {
  const parsed = parseHostHeader(options.hostHeader)
  if (!parsed) {
    return "Invalid Host header"
  }
  if (parsed.port !== undefined && parsed.port !== options.port) {
    return "Invalid Host header port"
  }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", normalizeHostname(options.host)])
  if (!allowedHosts.has(parsed.hostname)) {
    return "Invalid Host header"
  }
  return undefined
}

export function validateBrowserFetchSite(request: http.IncomingMessage): string | undefined {
  const secFetchSite = request.headers["sec-fetch-site"]
  const value = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite
  if (!value || value === "same-origin" || value === "none") {
    return undefined
  }
  return "Cross-origin browser requests are not allowed"
}

export function validateWebSocketOrigin(options: {
  readonly origin: string | undefined
  readonly requireChromeExtension?: boolean
}): string | undefined {
  if (!options.origin) {
    return undefined
  }
  if (options.origin.startsWith("chrome-extension://")) {
    return undefined
  }
  if (options.requireChromeExtension) {
    return "Extension WebSocket origin must be chrome-extension://"
  }
  return "WebSocket origin is not allowed"
}

function normalizeHostname(host: string): string {
  const value = host.trim().toLowerCase()
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1)
  }
  return value
}

function parseHostHeader(hostHeader: string | undefined): { readonly hostname: string; readonly port?: number } | undefined {
  const value = hostHeader?.trim().toLowerCase()
  if (!value) {
    return undefined
  }
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]")
    if (closingBracket === -1) {
      return undefined
    }
    const hostname = value.slice(1, closingBracket)
    const rest = value.slice(closingBracket + 1)
    if (!hostname) {
      return undefined
    }
    if (!rest) {
      return { hostname }
    }
    if (!rest.startsWith(":")) {
      return undefined
    }
    const port = parsePort(rest.slice(1))
    return port === undefined ? undefined : { hostname, port }
  }
  if (value === "::1") {
    return { hostname: "::1" }
  }
  const colonCount = value.split(":").length - 1
  if (colonCount > 1) {
    return undefined
  }
  if (colonCount === 0) {
    return { hostname: value }
  }
  const [hostname, portText] = value.split(":")
  if (!hostname || portText === undefined) {
    return undefined
  }
  const port = parsePort(portText)
  return port === undefined ? undefined : { hostname, port }
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined
  }
  return port
}

export function listenHttpServer(options: {
  readonly server: http.Server
  readonly host: string
  readonly port: number
}): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    const onError = (error: Error) => {
      resume(Effect.fail(error))
    }
    options.server.once("error", onError)
    options.server.listen(options.port, options.host, () => {
      options.server.off("error", onError)
      resume(Effect.void)
    })
    return Effect.sync(() => {
      options.server.off("error", onError)
    })
  })
}

export function closeHttpServer(server: http.Server): Effect.Effect<void, Error> {
  if (!server.listening) {
    return Effect.void
  }
  return Effect.callback<void, Error>((resume) => {
    server.close((error?: Error) => {
      if (error) {
        resume(Effect.fail(new Error("close http server", { cause: error })))
        return
      }
      resume(Effect.void)
    })
    return Effect.void
  })
}

export function closeWebSocketServer(server: WebSocketServer): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    server.close((error?: Error) => {
      const nodeError = error as NodeJS.ErrnoException | undefined
      if (nodeError?.code === "ERR_SERVER_NOT_RUNNING") {
        resume(Effect.void)
        return
      }
      if (error) {
        resume(Effect.fail(new Error("close websocket server", { cause: error })))
        return
      }
      resume(Effect.void)
    })
    return Effect.void
  })
}

export function logCloseError(message: string) {
  return (effect: Effect.Effect<void, Error>): Effect.Effect<void> => {
    return Effect.catch(effect, (error) => {
      return Effect.sync(() => {
        console.error(message, error)
      })
    })
  }
}

export function sendJson(response: http.ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

export function readJsonBody(request: http.IncomingMessage): Effect.Effect<JsonObject, Error> {
  const contentType = request.headers["content-type"]
  const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType
  if (!contentTypeValue?.toLowerCase().includes("application/json")) {
    return Effect.fail(new HttpRouteError({ message: "Content-Type must be application/json", status: 415, code: "invalid-request" }))
  }
  return Effect.callback<JsonObject, Error>((resume) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let completed = false
    const onData = (chunk: Buffer) => {
      if (completed) {
        return
      }
      totalBytes += chunk.byteLength
      if (totalBytes > maxCliBodyBytes) {
        completed = true
        request.destroy(new Error(`Request body exceeds ${maxCliBodyBytes} bytes`))
        resume(Effect.fail(new HttpRouteError({ message: `Request body exceeds ${maxCliBodyBytes} bytes`, status: 413, code: "invalid-request" })))
        return
      }
      chunks.push(chunk)
    }
    const onError = (error: Error) => {
      if (completed) {
        return
      }
      completed = true
      resume(Effect.fail(new Error("read request body", { cause: error })))
    }
    const onAbort = () => {
      if (completed) {
        return
      }
      completed = true
      resume(Effect.fail(new Error("request body aborted")))
    }
    const onClose = () => {
      if (completed || request.complete) {
        return
      }
      completed = true
      resume(Effect.fail(new Error("request closed before body completed")))
    }
    const onEnd = () => {
      if (completed) {
        return
      }
      completed = true
      const text = Buffer.concat(chunks).toString("utf8")
      if (!text.trim()) {
        resume(Effect.succeed({}))
        return
      }
      try {
        resume(Effect.succeed(parseJsonObject(text)))
      } catch (error) {
        resume(Effect.fail(new HttpRouteError({ message: "Invalid JSON body", status: 400, code: "invalid-request" })))
      }
    }
    request.on("data", onData)
    request.on("error", onError)
    request.on("aborted", onAbort)
    request.on("close", onClose)
    request.on("end", onEnd)
    return Effect.sync(() => {
      request.off("data", onData)
      request.off("error", onError)
      request.off("aborted", onAbort)
      request.off("close", onClose)
      request.off("end", onEnd)
    })
  })
}

export function optionalSessionId(value: JsonObject[string] | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined
  }
  const id = value.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw new HttpRouteError({
      message: "Session ids must use lowercase letters, numbers, and dashes, and be at most 63 characters",
      status: 400,
      code: "invalid-request",
    })
  }
  return id
}

export function requiredSessionId(value: JsonObject[string] | undefined): string {
  const id = optionalSessionId(value)
  if (!id) {
    throw new HttpRouteError({ message: "sessionId is required", status: 400, code: "invalid-request" })
  }
  return id
}

export function requiredString(value: JsonObject[string] | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`)
  }
  return value
}

export function requiredBoolean(value: JsonObject[string] | undefined, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} is required`)
  }
  return value
}

export function parseTargetSelection(value: JsonObject[string] | undefined): ExecuteTargetSelection | undefined {
  if (value === undefined) {
    return undefined
  }
  const object = getObject(value)
  if (!object) {
    throw new HttpRouteError({ message: "targetSelection must be an object", status: 400, code: "invalid-request" })
  }
  const urlIncludes = typeof object.urlIncludes === "string" && object.urlIncludes ? object.urlIncludes : undefined
  if (object.index !== undefined && (typeof object.index !== "number" || !Number.isInteger(object.index))) {
    throw new HttpRouteError({ message: "targetSelection.index must be a non-negative integer", status: 400, code: "invalid-request" })
  }
  const index = typeof object.index === "number" ? object.index : undefined
  if (index !== undefined && index < 0) {
    throw new HttpRouteError({ message: "targetSelection.index must be a non-negative integer", status: 400, code: "invalid-request" })
  }
  if (urlIncludes && index !== undefined) {
    throw new HttpRouteError({ message: "Use only one target selector", status: 400, code: "invalid-request" })
  }
  return {
    ...(urlIncludes ? { urlIncludes } : {}),
    ...(index !== undefined ? { index } : {}),
  }
}

export function generateSessionId(existing: ReadonlyMap<string, BrowserControlSession>): string {
  const adjectives = ["amber", "brisk", "calm", "clever", "cosmic", "gentle", "lucky", "quiet", "rapid", "tidy"]
  const nouns = ["badger", "comet", "falcon", "otter", "panda", "raven", "sparrow", "tiger", "walrus", "wombat"]
  for (let attempt = 0; attempt < 100; attempt++) {
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)] ?? "calm"
    const noun = nouns[Math.floor(Math.random() * nouns.length)] ?? "otter"
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0")
    const id = `${adjective}-${noun}-${suffix}`
    if (!existing.has(id)) {
      return id
    }
  }
  return `session-${Date.now().toString(36)}`
}

export function sendCdpResponse(socket: WebSocket, response: CdpResponse): void {
  socket.send(JSON.stringify(response))
}

export function sendCdpEvent(socket: WebSocket, event: CdpEvent): void {
  socket.send(JSON.stringify(event))
}

export function getObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as JsonObject
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value) {
    return value
  }
  return undefined
}

export function getTargetInfo(value: unknown): TargetInfo | undefined {
  const object = getObject(value)
  if (!object) {
    return undefined
  }
  if (typeof object.targetId !== "string" || typeof object.url !== "string") {
    return undefined
  }
  if (object.type !== "page" && object.type !== "iframe" && object.type !== "worker") {
    return undefined
  }
  const type = object.type
  return {
    targetId: object.targetId,
    type,
    title: typeof object.title === "string" ? object.title : object.url,
    url: object.url,
    attached: true,
    canAccessOpener: typeof object.canAccessOpener === "boolean" ? object.canAccessOpener : false,
    ...(typeof object.browserContextId === "string" ? { browserContextId: object.browserContextId } : {}),
    ...(typeof object.openerId === "string" ? { openerId: object.openerId } : {}),
    ...(typeof object.parentFrameId === "string" ? { parentFrameId: object.parentFrameId } : {}),
  }
}

export function isRestrictedTarget(targetInfo: TargetInfo): boolean {
  if (targetInfo.type !== "page" && targetInfo.type !== "iframe" && targetInfo.type !== "worker") {
    return true
  }
  if (!targetInfo.url) {
    return false
  }
  const blockedPrefixes = ["chrome://", "chrome-extension://", "chrome-untrusted://", "devtools://", "edge://", "brave://"]
  return blockedPrefixes.some((prefix) => {
    return targetInfo.url.startsWith(prefix)
  })
}
