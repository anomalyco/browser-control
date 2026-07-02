import { WebSocket } from "ws"
import type { CdpEvent, JsonObject, TargetInfo } from "./protocol.ts"
import { getObject, sendCdpEvent } from "./relay-helpers.ts"
import type { ChildTarget, ConnectedTarget } from "./relay-types.ts"
import type { TargetRegistry } from "./target-registry.ts"

export function sendAttachedToTarget(options: {
  readonly socket: WebSocket
  readonly clientAttachedSessions: ReadonlyMap<WebSocket, Set<string>>
  readonly target: ConnectedTarget
}): void {
  const attachedSessions = options.clientAttachedSessions.get(options.socket)
  if (attachedSessions?.has(options.target.sessionId)) {
    return
  }
  attachedSessions?.add(options.target.sessionId)
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
  readonly clientAttachedSessions: ReadonlyMap<WebSocket, Set<string>>
  readonly target: ChildTarget
}): void {
  const attachedSessions = options.clientAttachedSessions.get(options.socket)
  if (attachedSessions?.has(options.target.sessionId)) {
    return
  }
  attachedSessions?.add(options.target.sessionId)
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
  readonly clientAttachedSessions: ReadonlyMap<WebSocket, Set<string>>
}): void {
  for (const target of options.registry.childTargets.values()) {
    if (target.parentSessionId === options.parentSessionId) {
      replayFrameEventsForChild({ socket: options.socket, registry: options.registry, target })
      sendAttachedToChildTarget({ socket: options.socket, clientAttachedSessions: options.clientAttachedSessions, target })
      replayChildFrameNavigation({ socket: options.socket, registry: options.registry, target })
    }
  }
}

export function replayFrameEventsForChild(options: { readonly socket: WebSocket; readonly registry: TargetRegistry; readonly target: ChildTarget }): void {
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
