import { describe, expect, it } from "vitest"
import { canClientSeeTarget } from "../src/cdp-visibility.ts"
import { TargetRegistry } from "../src/target-registry.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"
import type { TargetInfo } from "../src/protocol.ts"

function targetInfo(targetId: string, url = "https://example.com/"): TargetInfo {
  return { targetId, type: "page", title: "t", url, attached: true, canAccessOpener: false }
}

function rootTarget(options: {
  readonly tabId: number
  readonly sessionId: string
  readonly browserControlSessionId?: string
}): ConnectedTarget {
  return {
    tabId: options.tabId,
    sessionId: options.sessionId,
    targetInfo: targetInfo(`target-${options.tabId}`),
    owner: options.browserControlSessionId ? "relay" : "user",
    ...(options.browserControlSessionId ? { browserControlSessionId: options.browserControlSessionId } : {}),
  }
}

describe("canClientSeeTarget", () => {
  it("shows user toolbar targets to every client", () => {
    expect(canClientSeeTarget({ clientSessionId: "session-a", targetOwnerSessionId: undefined, targetOwner: "user", clientHasOwnedTarget: true })).toBe(true)
    expect(canClientSeeTarget({ clientSessionId: undefined, targetOwnerSessionId: undefined, targetOwner: "user", clientHasOwnedTarget: false })).toBe(true)
  })

  it("shows session-owned targets only to that session's clients", () => {
    expect(canClientSeeTarget({ clientSessionId: "session-a", targetOwnerSessionId: "session-a", targetOwner: "relay", clientHasOwnedTarget: true })).toBe(true)
    expect(canClientSeeTarget({ clientSessionId: "session-b", targetOwnerSessionId: "session-a", targetOwner: "relay", clientHasOwnedTarget: false })).toBe(false)
  })

  it("hides session-owned targets from raw clients so they cannot double-initialize them", () => {
    expect(canClientSeeTarget({ clientSessionId: undefined, targetOwnerSessionId: "session-a", targetOwner: "relay", clientHasOwnedTarget: false })).toBe(false)
  })

  it("hides raw-client-created targets from session clients that already own a target while keeping target-url discovery available", () => {
    expect(canClientSeeTarget({ clientSessionId: undefined, targetOwnerSessionId: undefined, targetOwner: "relay", clientHasOwnedTarget: false })).toBe(true)
    expect(canClientSeeTarget({ clientSessionId: "session-a", targetOwnerSessionId: undefined, targetOwner: "relay", clientHasOwnedTarget: false })).toBe(true)
    expect(canClientSeeTarget({ clientSessionId: "session-a", targetOwnerSessionId: undefined, targetOwner: "relay", clientHasOwnedTarget: true })).toBe(false)
  })
})

describe("TargetRegistry.allTargetInfos visibility filter", () => {
  it("filters root and child targets through isVisibleTarget", () => {
    const registry = new TargetRegistry()
    const owned = rootTarget({ tabId: 1, sessionId: "bc-tab-1", browserControlSessionId: "session-a" })
    const unowned = rootTarget({ tabId: 2, sessionId: "bc-tab-2" })
    registry.addRootTarget(owned)
    registry.addRootTarget(unowned)
    const child: ChildTarget = {
      tabId: 1,
      sessionId: "child-1",
      parentSessionId: "bc-tab-1",
      targetInfo: targetInfo("child-target-1"),
      waitingForDebugger: false,
    }
    registry.addChildTarget(child)

    const canSee = (clientSessionId: string | undefined) => {
      return registry
        .allTargetInfos({
          isRestrictedTarget: () => false,
          isVisibleTarget: (target) => {
            const root = registry.tabTargets.get(target.tabId)
            return canClientSeeTarget({
              clientSessionId,
              targetOwnerSessionId: root?.browserControlSessionId,
              targetOwner: root?.owner ?? "relay",
              clientHasOwnedTarget: clientSessionId === "session-a",
            })
          },
        })
        .map((info) => info.targetId)
    }

    expect(canSee("session-a")).toEqual(["target-1", "target-2", "child-target-1"])
    expect(canSee("session-b")).toEqual(["target-2"])
    expect(canSee(undefined)).toEqual(["target-2"])
  })
})
