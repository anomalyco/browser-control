export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export type CdpRequest = {
  readonly id: number
  readonly method: string
  readonly params?: JsonObject
  readonly sessionId?: string
}

export type CdpResponse = {
  readonly id: number
  readonly result?: JsonObject
  readonly error?: {
    readonly message: string
  }
  readonly sessionId?: string
}

export type CdpEvent = {
  readonly method: string
  readonly params?: JsonObject
  readonly sessionId?: string
}

export type TargetInfo = {
  readonly targetId: string
  readonly type: "page" | "iframe"
  readonly title: string
  readonly url: string
  readonly attached: boolean
  readonly canAccessOpener: boolean
  readonly browserContextId?: string
  readonly openerId?: string
  readonly parentFrameId?: string
}

export type PageStatus = {
  readonly state: "attached" | "running" | "waiting"
  readonly owner: "session" | "user"
  readonly sessionId?: string
  readonly readOnly?: boolean
  readonly message?: string
  readonly handoffId?: string
}

export type ExtensionCommand = {
  readonly id: number
  readonly method:
    | "ping"
    | "debugger.attach"
    | "debugger.detach"
    | "debugger.sendCommand"
    | "tabs.create"
    | "tabs.remove"
    | "tabs.group"
    | "action.setAttached"
    | "action.setBadge"
    | "pageStatus.set"
    | "pageStatus.clear"
    | "runtime.reload"
    | "recording.start"
    | "recording.stop"
    | "recording.status"
    | "recording.cancel"
  readonly params?: JsonObject
}

export type ExtensionResponse = {
  readonly id: number
  readonly result?: JsonObject
  readonly error?: string
}

export type ExtensionEvent = {
  readonly method:
    | "hello"
    | "toolbar.clicked"
    | "handoff.completed"
    | "debugger.event"
    | "debugger.attached"
    | "debugger.detached"
    | "tabs.removed"
    | "pong"
    | "log"
    | "recording.data"
    | "recording.cancelled"
    | "pageStatus.requested"
  readonly params?: JsonObject
}

export function parseJsonObject(input: string): JsonObject {
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object")
  }
  return parsed as JsonObject
}

export function isCdpRequest(input: JsonObject): input is CdpRequest {
  return typeof input.id === "number" && typeof input.method === "string"
}

export function isExtensionResponse(input: JsonObject): input is ExtensionResponse {
  return typeof input.id === "number"
}

export function isExtensionEvent(input: JsonObject): input is ExtensionEvent {
  return typeof input.method === "string"
}
