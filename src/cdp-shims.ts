import { WebSocket } from "ws"
import type { CdpEvent, JsonObject, TargetInfo } from "./protocol.ts"
import { getObject, sendCdpEvent } from "./relay-helpers.ts"
import type { ChildTarget, ConnectedTarget } from "./relay-types.ts"
import { shouldExposeChildTarget, type TargetRegistry } from "./target-registry.ts"

export type ClientCdpSessionAlias =
  | { readonly kind: "browser" }
  | {
    readonly kind: "target"
    readonly tabId: number
    readonly targetId: string
    readonly chromeSessionId?: string
  }

export type ClientTargetAnnouncements = {
  readonly sessions: Set<string>
  readonly targets: Map<string, { readonly sessionId: string; readonly parentSessionId?: string }>
  readonly sessionTargets: Map<string, string>
}

export function createClientTargetAnnouncements(): ClientTargetAnnouncements {
  return { sessions: new Set(), targets: new Map(), sessionTargets: new Map() }
}

export function chromeSessionIdForClientRequest(options: {
  readonly alias: { readonly chromeSessionId?: string } | undefined
  readonly requestedSessionId: string | undefined
  readonly rootSessionId: string | undefined
}): string | undefined {
  if (options.alias) {
    return options.alias.chromeSessionId
  }
  return options.requestedSessionId && options.requestedSessionId !== options.rootSessionId
    ? options.requestedSessionId
    : undefined
}

export function removeClientTargetAliases(
  clients: Iterable<Map<string, ClientCdpSessionAlias>>,
  matches: (alias: Extract<ClientCdpSessionAlias, { readonly kind: "target" }>) => boolean,
): void {
  for (const aliases of clients) {
    for (const [aliasId, alias] of aliases) {
      if (alias.kind === "target" && matches(alias)) {
        aliases.delete(aliasId)
      }
    }
  }
}

export function hasAnnouncedSession(state: ClientTargetAnnouncements | undefined, sessionId: string): boolean {
  return state?.sessions.has(sessionId) ?? false
}

export function removeAnnouncedSession(state: ClientTargetAnnouncements | undefined, sessionId: string): void {
  if (!state) {
    return
  }
  state.sessions.delete(sessionId)
  const targetId = state.sessionTargets.get(sessionId)
  state.sessionTargets.delete(sessionId)
  if (targetId && state.targets.get(targetId)?.sessionId === sessionId) {
    state.targets.delete(targetId)
  }
}

export function sendAttachedToTarget(options: {
  readonly socket: WebSocket
  readonly clientAnnouncements: ReadonlyMap<WebSocket, ClientTargetAnnouncements>
  readonly target: ConnectedTarget
  readonly onDuplicateTarget?: (duplicate: { readonly targetId: string; readonly oldSessionId: string; readonly newSessionId: string }) => void
}): void {
  const announcements = options.clientAnnouncements.get(options.socket)
  const targetId = options.target.targetInfo.targetId
  const existing = announcements?.targets.get(targetId)
  if (existing?.sessionId === options.target.sessionId) {
    return
  }
  if (existing) {
    options.onDuplicateTarget?.({ targetId, oldSessionId: existing.sessionId, newSessionId: options.target.sessionId })
    removeAnnouncedSession(announcements, existing.sessionId)
    sendCdpEvent(options.socket, {
      ...(existing.parentSessionId === undefined ? {} : { sessionId: existing.parentSessionId }),
      method: "Target.detachedFromTarget",
      params: { sessionId: existing.sessionId, targetId },
    })
  }
  removeAnnouncedSession(announcements, options.target.sessionId)
  announcements?.sessions.add(options.target.sessionId)
  announcements?.targets.set(targetId, { sessionId: options.target.sessionId })
  announcements?.sessionTargets.set(options.target.sessionId, targetId)
  sendCdpEvent(options.socket, {
    method: "Target.attachedToTarget",
    params: {
      sessionId: options.target.sessionId,
      targetInfo: { ...options.target.targetInfo, attached: true },
      waitingForDebugger: false,
    },
  })
}

export function sendAttachedToChildTarget(options: {
  readonly socket: WebSocket
  readonly clientAnnouncements: ReadonlyMap<WebSocket, ClientTargetAnnouncements>
  readonly target: ChildTarget
  readonly onDuplicateTarget?: (duplicate: { readonly targetId: string; readonly oldSessionId: string; readonly newSessionId: string }) => void
}): void {
  const announcements = options.clientAnnouncements.get(options.socket)
  const targetId = options.target.targetInfo.targetId
  const existing = announcements?.targets.get(targetId)
  if (existing?.sessionId === options.target.sessionId) {
    return
  }
  if (existing) {
    options.onDuplicateTarget?.({ targetId, oldSessionId: existing.sessionId, newSessionId: options.target.sessionId })
    removeAnnouncedSession(announcements, existing.sessionId)
    sendCdpEvent(options.socket, {
      ...(existing.parentSessionId === undefined ? {} : { sessionId: existing.parentSessionId }),
      method: "Target.detachedFromTarget",
      params: { sessionId: existing.sessionId, targetId },
    })
  }
  removeAnnouncedSession(announcements, options.target.sessionId)
  announcements?.sessions.add(options.target.sessionId)
  announcements?.targets.set(targetId, { sessionId: options.target.sessionId, parentSessionId: options.target.parentSessionId })
  announcements?.sessionTargets.set(options.target.sessionId, targetId)
  sendCdpEvent(options.socket, {
    sessionId: options.target.parentSessionId,
    method: "Target.attachedToTarget",
    params: {
      sessionId: options.target.sessionId,
      targetInfo: { ...options.target.targetInfo, attached: true },
      waitingForDebugger: options.target.waitingForDebugger,
    },
  })
}

export function replayChildTargetsForParent(options: {
  readonly socket: WebSocket
  readonly parentSessionId: string
  readonly registry: TargetRegistry
  readonly clientAnnouncements: ReadonlyMap<WebSocket, ClientTargetAnnouncements>
  readonly onDuplicateTarget?: (duplicate: { readonly targetId: string; readonly oldSessionId: string; readonly newSessionId: string }) => void
}): void {
  for (const target of options.registry.childTargets.values()) {
    if (target.parentSessionId === options.parentSessionId && shouldExposeChildTarget(target)) {
      replayFrameEventsForChild({ socket: options.socket, registry: options.registry, target })
      sendAttachedToChildTarget({
        socket: options.socket,
        clientAnnouncements: options.clientAnnouncements,
        target,
        ...(options.onDuplicateTarget ? { onDuplicateTarget: options.onDuplicateTarget } : {}),
      })
      replayChildFrameNavigation({ socket: options.socket, registry: options.registry, target })
    }
  }
}

export function replayFrameEventsForChild(options: { readonly socket: WebSocket; readonly registry: TargetRegistry; readonly target: ChildTarget }): void {
  if (options.target.targetInfo.type !== "iframe") {
    return
  }
  const frameEvents = options.registry.tabFrameEvents.get(options.target.tabId)?.get(options.target.targetInfo.targetId)
  if (!frameEvents) {
    return
  }
  if (frameEvents.attached) {
    sendCdpEvent(options.socket, { sessionId: options.target.parentSessionId, method: "Page.frameAttached", params: frameEvents.attached })
  }
  if (frameEvents.navigated) {
    sendCdpEvent(options.socket, { sessionId: options.target.parentSessionId, method: "Page.frameNavigated", params: frameEvents.navigated })
  }
}

export function replayChildFrameNavigation(options: { readonly socket: WebSocket; readonly registry: TargetRegistry; readonly target: ChildTarget }): void {
  const navigationParams = childFrameNavigationParams({ registry: options.registry, target: options.target })
  if (!navigationParams) {
    return
  }
  // Stock Playwright does not apply Page.getFrameTree to child iframe sessions;
  // replay the current navigation on the child session so reconnects do not
  // leave OOPIF frames with an empty URL.
  sendCdpEvent(options.socket, { sessionId: options.target.sessionId, method: "Page.frameNavigated", params: navigationParams })
}

export function childFrameNavigationParams(options: { readonly registry: TargetRegistry; readonly target: ChildTarget }): JsonObject | undefined {
  if (options.target.targetInfo.type !== "iframe") {
    return undefined
  }
  const frameEvents = options.registry.findFrameEventsForChild(options.target, getObject)
  const navigated = frameEvents?.navigated
  const frame = getObject(navigated?.frame)
  if (navigated && frame) {
    return {
      ...navigated,
      frame: {
        ...frame,
        id: options.target.targetInfo.targetId,
        url: options.target.targetInfo.url || (typeof frame.url === "string" ? frame.url : ""),
        ...(options.target.targetInfo.parentFrameId ? { parentId: options.target.targetInfo.parentFrameId } : {}),
      },
    }
  }
  if (!options.target.targetInfo.url) {
    return undefined
  }
  const gatedAPIFeatures: string[] = []
  return {
    frame: {
      id: options.target.targetInfo.targetId,
      loaderId: options.target.targetInfo.targetId,
      url: options.target.targetInfo.url,
      domainAndRegistry: "",
      securityOrigin: new URL(options.target.targetInfo.url).origin,
      mimeType: "text/html",
      adFrameStatus: { adFrameType: "none" },
      secureContextType: "Secure",
      crossOriginIsolatedContextType: "NotIsolated",
      gatedAPIFeatures,
      ...(options.target.targetInfo.parentFrameId ? { parentId: options.target.targetInfo.parentFrameId } : {}),
    },
  }
}

export function replayTargetCreated(options: { readonly socket: WebSocket; readonly targetInfos: readonly TargetInfo[] }): void {
  for (const targetInfo of options.targetInfos) {
    sendCdpEvent(options.socket, { method: "Target.targetCreated", params: { targetInfo } })
  }
}
