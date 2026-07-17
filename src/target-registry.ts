import type { JsonObject, TargetInfo } from "./protocol.ts"
import type { ChildTarget, ConnectedTarget, StoredFrameEvents } from "./relay-types.ts"

export type ConnectedTargetInfoUpdate =
  | { readonly kind: "root"; readonly target: ConnectedTarget }
  | { readonly kind: "child"; readonly target: ChildTarget }

export function shouldExposeChildTarget(target: ChildTarget): boolean {
  return target.targetInfo.type !== "page" || target.targetInfo.url !== ""
}

export class TargetRegistry {
  readonly targets = new Map<string, ConnectedTarget>()
  readonly tabTargets = new Map<number, ConnectedTarget>()
  readonly targetsByTargetId = new Map<string, ConnectedTarget>()
  readonly childSessionTabs = new Map<string, number>()
  readonly childTargets = new Map<string, ChildTarget>()
  readonly childTargetsByTargetId = new Map<string, ChildTarget>()
  readonly tabFrameEvents = new Map<number, Map<string, StoredFrameEvents>>()

  clear(): void {
    this.targets.clear()
    this.tabTargets.clear()
    this.targetsByTargetId.clear()
    this.childSessionTabs.clear()
    this.childTargets.clear()
    this.childTargetsByTargetId.clear()
    this.tabFrameEvents.clear()
  }

  addRootTarget(target: ConnectedTarget): void {
    const existingForTab = this.tabTargets.get(target.tabId)
    if (existingForTab) {
      this.targets.delete(existingForTab.sessionId)
      this.targetsByTargetId.delete(existingForTab.targetInfo.targetId)
    }
    const existingForTargetId = this.targetsByTargetId.get(target.targetInfo.targetId)
    if (existingForTargetId) {
      this.targets.delete(existingForTargetId.sessionId)
      this.tabTargets.delete(existingForTargetId.tabId)
    }
    this.targets.set(target.sessionId, target)
    this.tabTargets.set(target.tabId, target)
    this.targetsByTargetId.set(target.targetInfo.targetId, target)
  }

  addChildTarget(target: ChildTarget): void {
    const existingForSession = this.childTargets.get(target.sessionId)
    if (existingForSession) {
      this.childTargetsByTargetId.delete(existingForSession.targetInfo.targetId)
    }
    const existingForTargetId = this.childTargetsByTargetId.get(target.targetInfo.targetId)
    if (existingForTargetId) {
      this.childSessionTabs.delete(existingForTargetId.sessionId)
      this.childTargets.delete(existingForTargetId.sessionId)
    }
    this.childSessionTabs.set(target.sessionId, target.tabId)
    this.childTargets.set(target.sessionId, target)
    this.childTargetsByTargetId.set(target.targetInfo.targetId, target)
  }

  rootTargetCount(): number {
    return this.targets.size
  }

  listRootTargets(): ConnectedTarget[] {
    return Array.from(this.targets.values())
  }

  getRootTargetByTabId(tabId: number): ConnectedTarget | undefined {
    return this.tabTargets.get(tabId)
  }

  getRootTargetBySessionId(sessionId: string): ConnectedTarget | undefined {
    return this.targets.get(sessionId) ?? this.listRootTargets().find((target) => {
      return target.browserControlSessionId === sessionId
    })
  }

  detachRootTargetState(tabId: number): { readonly target: ConnectedTarget; readonly childSessionIds: string[] } | undefined {
    const target = this.tabTargets.get(tabId)
    if (!target) {
      return undefined
    }
    this.targets.delete(target.sessionId)
    this.tabTargets.delete(tabId)
    this.targetsByTargetId.delete(target.targetInfo.targetId)
    this.tabFrameEvents.delete(tabId)
    const childSessionIds = Array.from(this.childSessionTabs.entries())
      .filter(([, childTabId]) => {
        return childTabId === tabId
      })
      .map(([sessionId]) => {
        this.detachChildTargetState(sessionId)
        return sessionId
      })
    return { target, childSessionIds }
  }

  detachChildTargetState(sessionId: string): ChildTarget | undefined {
    const target = this.childTargets.get(sessionId)
    this.childSessionTabs.delete(sessionId)
    this.childTargets.delete(sessionId)
    if (target) {
      this.childTargetsByTargetId.delete(target.targetInfo.targetId)
    }
    return target
  }

  updateTargetUrl(tabId: number, url: string): void {
    const target = this.tabTargets.get(tabId)
    if (!target) {
      return
    }
    this.addRootTarget({ ...target, targetInfo: { ...target.targetInfo, title: url, url }, crashed: false })
  }

  markRootTargetCrashed(tabId: number): ConnectedTarget | undefined {
    const target = this.tabTargets.get(tabId)
    if (!target) {
      return undefined
    }
    const crashed: ConnectedTarget = { ...target, crashed: true }
    this.addRootTarget(crashed)
    return crashed
  }

  updateConnectedTargetInfo(options: { readonly tabId: number; readonly targetInfo: TargetInfo }): ConnectedTargetInfoUpdate | undefined {
    if (this.childTargetsByTargetId.has(options.targetInfo.targetId)) {
      this.updateChildTargetInfo(options.targetInfo)
      const target = this.childTargetsByTargetId.get(options.targetInfo.targetId)
      return target ? { kind: "child", target } : undefined
    }
    const root = this.tabTargets.get(options.tabId)
    if (root?.targetInfo.targetId !== options.targetInfo.targetId) {
      return undefined
    }
    this.updateRootTargetInfo(options.tabId, options.targetInfo)
    const target = this.tabTargets.get(options.tabId)
    return target ? { kind: "root", target } : undefined
  }

  updateRootTargetInfo(tabId: number, targetInfo: TargetInfo): void {
    const target = this.tabTargets.get(tabId)
    if (!target) {
      return
    }
    const updated: ConnectedTarget = { ...target, targetInfo }
    this.targets.set(updated.sessionId, updated)
    this.tabTargets.set(tabId, updated)
    this.targetsByTargetId.delete(target.targetInfo.targetId)
    this.targetsByTargetId.set(targetInfo.targetId, updated)
  }

  updateChildTargetInfo(targetInfo: TargetInfo): void {
    const target = this.childTargetsByTargetId.get(targetInfo.targetId)
    if (!target) {
      return
    }
    const updated: ChildTarget = { ...target, targetInfo }
    this.childTargets.set(updated.sessionId, updated)
    this.childTargetsByTargetId.delete(target.targetInfo.targetId)
    this.childTargetsByTargetId.set(targetInfo.targetId, updated)
  }

  rememberFrameEvent(options: {
    readonly tabId: number
    readonly frameId: string
    readonly attached?: JsonObject
    readonly navigated?: JsonObject
  }): void {
    const frameEvents = this.tabFrameEvents.get(options.tabId) ?? new Map<string, StoredFrameEvents>()
    const existing = frameEvents.get(options.frameId)
    const attached = options.attached ?? existing?.attached
    const navigated = options.navigated ?? existing?.navigated
    const next: StoredFrameEvents = {
      frameId: options.frameId,
      ...(attached ? { attached } : {}),
      ...(navigated ? { navigated } : {}),
    }
    frameEvents.set(options.frameId, next)
    this.tabFrameEvents.set(options.tabId, frameEvents)
  }

  tabIdForSession(sessionId: string | undefined): number | undefined {
    if (!sessionId) {
      return undefined
    }
    const target = this.targets.get(sessionId)
    if (target) {
      return target.tabId
    }
    return this.childSessionTabs.get(sessionId)
  }

  allTargetInfos(options: {
    readonly isRestrictedTarget: (targetInfo: TargetInfo) => boolean
    readonly isVisibleTarget?: (target: ConnectedTarget | ChildTarget) => boolean
  }): TargetInfo[] {
    return [...this.targets.values(), ...this.childTargets.values()]
      .filter((target) => {
        return options.isVisibleTarget?.(target) ?? true
      })
      .map((target) => {
        return target.targetInfo
      })
      .filter((targetInfo) => {
        return !options.isRestrictedTarget(targetInfo)
      })
      .map((targetInfo) => {
        return { ...targetInfo, attached: true }
      })
  }

  findFrameEventsForChild(target: ChildTarget, getObject: (value: unknown) => JsonObject | undefined): StoredFrameEvents | undefined {
    const frameEvents = this.tabFrameEvents.get(target.tabId)
    if (!frameEvents) {
      return undefined
    }
    const exactMatch = frameEvents.get(target.targetInfo.targetId)
    if (exactMatch) {
      return exactMatch
    }
    return Array.from(frameEvents.values()).find((candidate) => {
      const frame = getObject(candidate.navigated?.frame)
      if (!frame) {
        return false
      }
      const parentMatches = !target.targetInfo.parentFrameId || frame.parentId === target.targetInfo.parentFrameId
      const urlMatches = !target.targetInfo.url || frame.url === target.targetInfo.url
      return parentMatches && urlMatches
    })
  }
}
