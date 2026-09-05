import { describe, expect, it } from "vitest"
import { TargetRegistry } from "../src/target-registry.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"

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

function child(sessionId: string, targetId: string, parentSessionId = "bc-tab-1"): ChildTarget {
  return {
    tabId: 7,
    sessionId,
    parentSessionId,
    waitingForDebugger: false,
    targetInfo: { ...root({ sessionId, targetId }).targetInfo, type: "iframe" },
  }
}

describe("TargetRegistry child generations", () => {
  it.each([false, true])("removes descendants from every child index without removing siblings (reverse: %s)", (reverse) => {
    const registry = new TargetRegistry()
    const parent = child("parent", "parent-target")
    const grandchild = child("grandchild", "grandchild-target", parent.sessionId)
    const descendant = child("descendant", "descendant-target", grandchild.sessionId)
    const sibling = child("sibling", "sibling-target")
    const targets = [parent, grandchild, descendant, sibling]
    for (const target of reverse ? targets.reverse() : targets) registry.addChildTarget(target)

    expect(registry.detachChildTargetState(parent.sessionId)).toBe(parent)
    expect([...registry.childTargets.values()]).toEqual([sibling])
    expect([...registry.childTargetsByTargetId.values()]).toEqual([sibling])
    expect(registry.detachChildTargetState(parent.sessionId)).toBeUndefined()
  })

  it.each(["target", "session"] as const)("replaces the old subtree on a conflicting %s identity", (conflict) => {
    const registry = new TargetRegistry()
    const parent = child("parent", "parent-target")
    registry.addChildTarget(parent)
    registry.addChildTarget(child("grandchild", "grandchild-target", parent.sessionId))
    const replacement = conflict === "target"
      ? child("replacement", parent.targetInfo.targetId)
      : child(parent.sessionId, "replacement-target")

    expect(registry.addChildTarget(replacement)).toEqual([parent])
    expect([...registry.childTargets.values()]).toEqual([replacement])
    expect([...registry.childTargetsByTargetId.values()]).toEqual([replacement])
  })

  it("reports and removes both conflicting subtrees", () => {
    const registry = new TargetRegistry()
    const first = child("first", "first-target")
    const second = child("second", "second-target")
    for (const parent of [first, second]) {
      registry.addChildTarget(parent)
      registry.addChildTarget(child(`${parent.sessionId}-child`, `${parent.sessionId}-child-target`, parent.sessionId))
    }
    const replacement = child(first.sessionId, second.targetInfo.targetId)

    expect(registry.addChildTarget(replacement)).toEqual([first, second])
    expect([...registry.childTargets.values()]).toEqual([replacement])
    expect([...registry.childTargetsByTargetId.values()]).toEqual([replacement])
  })

  it("updates the same identity without tearing down descendants", () => {
    const registry = new TargetRegistry()
    const parent = child("parent", "parent-target")
    const grandchild = child("grandchild", "grandchild-target", parent.sessionId)
    expect(registry.addChildTarget(parent)).toEqual([])
    registry.addChildTarget(grandchild)
    const updated = { ...parent, targetInfo: { ...parent.targetInfo, title: "Updated", url: "https://updated.example.test/" } }

    expect(registry.addChildTarget(updated)).toEqual([])
    expect([...registry.childTargets.values()]).toEqual([updated, grandchild])
    expect([...registry.childTargetsByTargetId.values()]).toEqual([updated, grandchild])
  })
})

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
    expect(registry.childTargets.get("child-1")?.tabId).toBe(7)

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

  it.each(["parents-first", "descendants-first", "interleaved"])("preserves the entire staged subtree across repeated replacements (%s)", (order) => {
    const registry = new TargetRegistry()
    const unrelatedRoot = root({ tabId: 8, sessionId: "other-root", targetId: "other-root-target" })
    const unrelated = [
      { ...child("other-child", "other-child-target", unrelatedRoot.sessionId), tabId: 8 },
      { ...child("other-nested", "other-nested-target", "other-child"), tabId: 8 },
    ]
    registry.addRootTarget(unrelatedRoot)
    for (const target of unrelated) registry.addChildTarget(target)
    let previous: ChildTarget[] = []
    for (const generation of [1, 2, 3]) {
      const sessionId = `bc-tab-${generation}`
      const nextRoot = root({ sessionId, targetId: `target-${generation}` })
      if (generation === 1) registry.addRootTarget(nextRoot)
      else registry.stageRootTarget(nextRoot)
      const parent = child(`${sessionId}-parent`, `${sessionId}-parent-target`, sessionId)
      const nested = child(`${sessionId}-nested`, `${sessionId}-nested-target`, parent.sessionId)
      const deep = child(`${sessionId}-deep`, `${sessionId}-deep-target`, nested.sessionId)
      const deepest = child(`${sessionId}-deepest`, `${sessionId}-deepest-target`, deep.sessionId)
      const sibling = child(`${sessionId}-sibling`, `${sessionId}-sibling-target`, sessionId)
      const cousin = child(`${sessionId}-cousin`, `${sessionId}-cousin-target`, sibling.sessionId)
      const children = order === "interleaved"
        ? [deep, sibling, nested, cousin, parent, deepest]
        : [parent, nested, deep, deepest, sibling, cousin]
      if (order === "descendants-first") children.reverse()
      for (const target of children) registry.addChildTarget(target)

      if (generation !== 1) {
        const change = registry.commitStagedRootTarget(7, sessionId)
        expect(change).toMatchObject({
          kind: "replaced",
          previous: { sessionId: `bc-tab-${generation - 1}` },
          target: { sessionId },
          childSessionIds: previous.map((target) => target.sessionId),
        })
        for (const target of previous) {
          expect(registry.childTargets.has(target.sessionId)).toBe(false)
          expect(registry.childTargetsByTargetId.has(target.targetInfo.targetId)).toBe(false)
        }
        expect(registry.commitStagedRootTarget(7, sessionId)).toBeUndefined()
        expect(registry.addRootTarget(nextRoot).kind).toBe("updated")
      }
      const retained = [...unrelated, ...children]
      expect([...registry.childTargets.values()]).toEqual(retained)
      expect([...registry.childTargetsByTargetId.values()]).toEqual(retained)
      previous = children
    }

    expect(registry.detachRootTargetState(7)?.childSessionIds).toEqual(previous.map((target) => target.sessionId))
    expect(registry.detachRootTargetState(7)).toBeUndefined()
    expect([...registry.childTargets.values()]).toEqual(unrelated)
    expect([...registry.childTargetsByTargetId.values()]).toEqual(unrelated)
  })
})
