import { describe, expect, it } from "vitest"
import { HandoffRegistry, resolveExactHandoffTarget, toolbarClickAction } from "../src/handoff.ts"

function registryWithIds(...ids: string[]): HandoffRegistry {
  return new HandoffRegistry(() => ids.shift() ?? "unexpected-id")
}

describe("HandoffRegistry", () => {
  it("resolves only a matching handoff id and tab", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "do the 2fa", timeoutMs: 5_000 })

    expect(registry.pendingForSession("alpha")).toEqual({
      id: "handoff-1",
      sessionId: "alpha",
      tabId: 7,
      targetId: "target-7",
      targetSessionId: "bc-tab-7",
      message: "do the 2fa",
    })
    expect(registry.complete({ id: "handoff-1", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })).toBe(true)
    await expect(wait.outcome).resolves.toBe("resolved")
    expect(registry.pendingCount).toBe(0)
  })

  it("ignores mismatched ids and tabs", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 5_000 })

    expect(registry.complete({ id: "other", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })).toBe(false)
    expect(registry.complete({ id: "handoff-1", tabId: 8, targetId: "target-7", targetSessionId: "bc-tab-7" })).toBe(false)
    expect(registry.complete({ id: "handoff-1", tabId: 7, targetId: "replacement", targetSessionId: "bc-tab-7" })).toBe(false)
    expect(registry.complete({ id: "handoff-1", tabId: 7, targetId: "target-7", targetSessionId: "replacement-session" })).toBe(false)
    expect(registry.pendingForTab(7)?.id).toBe("handoff-1")

    registry.cancelAll()
    await expect(wait.outcome).resolves.toBe("timeout")
  })

  it("does not let a stale id resolve a replacement wait", async () => {
    const registry = registryWithIds("handoff-1", "handoff-2")
    const first = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "one", timeoutMs: 5_000 })
    const second = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "two", timeoutMs: 5_000 })

    await expect(first.outcome).resolves.toBe("timeout")
    expect(registry.complete({ id: first.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })).toBe(false)
    expect(registry.pendingForSession("alpha")?.id).toBe(second.id)
    expect(registry.complete({ id: second.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })).toBe(true)
    await expect(second.outcome).resolves.toBe("resolved")
  })

  it("times out and clears the pending descriptor", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 10 })

    await expect(wait.outcome).resolves.toBe("timeout")
    expect(registry.pendingForSession("alpha")).toBeUndefined()
    expect(registry.pendingForTab(7)).toBeUndefined()
  })

  it("cancelAll times out every waiter", async () => {
    const registry = registryWithIds("handoff-1", "handoff-2")
    const one = registry.wait({ sessionId: "a", tabId: 1, targetId: "target-1", targetSessionId: "bc-tab-1", message: "m", timeoutMs: 5_000 })
    const two = registry.wait({ sessionId: "b", tabId: 2, targetId: "target-2", targetSessionId: "bc-tab-2", message: "m", timeoutMs: 5_000 })

    registry.cancelAll()
    await expect(one.outcome).resolves.toBe("timeout")
    await expect(two.outcome).resolves.toBe("timeout")
    expect(registry.pendingCount).toBe(0)
  })

  it("cancels every waiter bound to an exact target with a structured reason", async () => {
    const registry = registryWithIds("handoff-1", "handoff-2")
    const one = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "one", timeoutMs: 5_000 })
    const two = registry.wait({ sessionId: "beta", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "two", timeoutMs: 5_000 })

    expect(registry.cancelForTarget({
      targetId: "target-7",
      targetSessionId: "bc-tab-7",
      reason: "target-crashed",
    })).toEqual([
      expect.objectContaining({ id: one.id, sessionId: "alpha", tabId: 7 }),
      expect.objectContaining({ id: two.id, sessionId: "beta", tabId: 7 }),
    ])
    await expect(one.outcome).resolves.toEqual({ type: "cancelled", reason: "target-crashed" })
    await expect(two.outcome).resolves.toEqual({ type: "cancelled", reason: "target-crashed" })
    expect(registry.pendingCount).toBe(0)
  })

  it("does not cancel a replacement target generation that reused the tab", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-new", message: "m", timeoutMs: 5_000 })

    expect(registry.cancelForTarget({
      targetId: "target-7",
      targetSessionId: "bc-tab-old",
      reason: "target-detached",
    })).toEqual([])
    expect(registry.pendingForSession("alpha")?.id).toBe(wait.id)
    expect(registry.complete({ id: wait.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-new" })).toBe(true)
    await expect(wait.outcome).resolves.toBe("resolved")
  })
})

describe("resolveExactHandoffTarget", () => {
  it("binds by stable target id regardless of page order or navigation", () => {
    const target = {
      tabId: 7,
      sessionId: "bc-tab-7",
      targetInfo: { targetId: "target-7", url: "https://example.com/after-navigation" },
    }
    const other = {
      tabId: 8,
      sessionId: "bc-tab-8",
      targetInfo: { targetId: "target-8", url: "https://example.com/before-navigation" },
    }

    expect(resolveExactHandoffTarget({
      targetId: "target-7",
      targets: [other, target],
      isVisible: () => true,
    })).toBe(target)
  })

  it("rejects detached and invisible targets without falling back", () => {
    const target = { tabId: 7, sessionId: "bc-tab-7", targetInfo: { targetId: "target-7" } }
    expect(() => resolveExactHandoffTarget({ targetId: "missing", targets: [target], isVisible: () => true })).toThrow("detached or is no longer visible")
    expect(() => resolveExactHandoffTarget({ targetId: "target-7", targets: [target], isVisible: () => false })).toThrow("detached or is no longer visible")
  })
})

describe("toolbarClickAction", () => {
  it("ignores toolbar clicks while a handoff is pending instead of completing or detaching", () => {
    expect(toolbarClickAction({ handoffPending: true, sessionExecuting: true })).toBe("ignore")
  })

  it("ignores any executing tab and otherwise preserves the attach toggle", () => {
    expect(toolbarClickAction({ handoffPending: false, sessionExecuting: true })).toBe("ignore")
    expect(toolbarClickAction({ handoffPending: false, sessionExecuting: false })).toBe("toggle")
  })
})
