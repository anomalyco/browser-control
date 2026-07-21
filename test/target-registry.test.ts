import { describe, expect, it } from "vitest"
import { TargetRegistry } from "../src/target-registry.ts"
import type { ConnectedTarget } from "../src/relay-types.ts"

function root(options: {
  readonly tabId?: number
  readonly sessionId: string
  readonly targetId: string
  readonly browserControlSessionId?: string
}): ConnectedTarget {
  return {
    tabId: options.tabId ?? 7,
    sessionId: options.sessionId,
    owner: "relay",
    ...(options.browserControlSessionId ? { browserControlSessionId: options.browserControlSessionId } : {}),
    targetInfo: {
      targetId: options.targetId,
      type: "page",
      title: options.targetId,
      url: "https://example.test/",
      attached: true,
      canAccessOpener: false,
    },
  }
}

describe("TargetRegistry root generations", () => {
  it("preserves ownership and reports same-tab root replacement", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget(root({ sessionId: "bc-tab-1", targetId: "target-1", browserControlSessionId: "alpha" }))
    registry.addChildTarget({
      tabId: 7,
      sessionId: "child-1",
      parentSessionId: "bc-tab-1",
      waitingForDebugger: false,
      targetInfo: {
        targetId: "child-target-1",
        type: "iframe",
        title: "",
        url: "https://child.example.test/",
        attached: true,
        canAccessOpener: false,
      },
    })

    const change = registry.addRootTarget(root({ sessionId: "bc-tab-2", targetId: "target-2" }))

    expect(change).toMatchObject({
      kind: "replaced",
      previous: { sessionId: "bc-tab-1", targetInfo: { targetId: "target-1" } },
      target: { sessionId: "bc-tab-2", browserControlSessionId: "alpha", targetInfo: { targetId: "target-2" } },
      childSessionIds: ["child-1"],
    })
    expect(registry.targets.has("bc-tab-1")).toBe(false)
    expect(registry.targetsByTargetId.has("target-1")).toBe(false)
    expect(registry.childTargets.size).toBe(0)
  })

  it("does not preserve provisional adoption ownership across replacement", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget(root({ sessionId: "bc-tab-1", targetId: "target-1" }))
    const reservation = registry.reserveTargetOwnership("target-1", "alpha")

    const change = registry.addRootTarget(root({ sessionId: "bc-tab-2", targetId: "target-2" }))

    expect(change.target.browserControlSessionId).toBeUndefined()
    expect(registry.rollbackTargetOwnership(reservation)).toEqual({ targetIds: [], tabIds: [] })
  })

  it("keeps a staged replacement non-authoritative and commits current ownership", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget(root({ sessionId: "bc-tab-1", targetId: "target-1", browserControlSessionId: "alpha" }))

    const staged = registry.stageRootTarget(root({ sessionId: "bc-tab-2", targetId: "target-2", browserControlSessionId: "alpha" }))
    expect(registry.tabTargets.get(7)?.targetInfo.targetId).toBe("target-1")
    expect(registry.targetsByTargetId.has("target-2")).toBe(false)
    expect(registry.routingRootTarget(7)).toBe(staged)

    registry.releaseTargetOwnership("target-1", "alpha")
    const change = registry.commitStagedRootTarget(7, "bc-tab-2")

    expect(change?.target.targetInfo.targetId).toBe("target-2")
    expect(change?.target.browserControlSessionId).toBeUndefined()
  })

  it("preserves children attached to a staged generation when it commits", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget(root({ sessionId: "bc-tab-1", targetId: "target-1" }))
    registry.addChildTarget({
      tabId: 7,
      sessionId: "old-child",
      parentSessionId: "bc-tab-1",
      waitingForDebugger: false,
      targetInfo: { ...root({ sessionId: "unused", targetId: "old-child-target" }).targetInfo, type: "iframe" },
    })
    registry.stageRootTarget(root({ sessionId: "bc-tab-2", targetId: "target-2" }))
    registry.addChildTarget({
      tabId: 7,
      sessionId: "new-child",
      parentSessionId: "bc-tab-2",
      waitingForDebugger: false,
      targetInfo: { ...root({ sessionId: "unused", targetId: "new-child-target" }).targetInfo, type: "iframe" },
    })

    const change = registry.commitStagedRootTarget(7, "bc-tab-2")

    expect(change).toMatchObject({ kind: "replaced", childSessionIds: ["old-child"] })
    expect(registry.childTargets.has("old-child")).toBe(false)
    expect(registry.childTargets.get("new-child")?.parentSessionId).toBe("bc-tab-2")
  })
})
