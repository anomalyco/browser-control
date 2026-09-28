import { afterEach, describe, expect, it, vi } from "vitest"
import { awaitHandoffAction, HandoffRegistry, resolveExactHandoffTarget, toolbarClickAction } from "../src/handoff.ts"

function registryWithIds(...ids: string[]): HandoffRegistry {
  return new HandoffRegistry(() => ids.shift() ?? "unexpected-id")
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("HandoffRegistry", () => {
  afterEach(() => vi.useRealTimers())

  it.each(["timeout", "target-detached", "target-crashed"] as const)("keeps %s effective after human completion until the start action settles", async (ending) => {
    vi.useFakeTimers()
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 5_000 })
    const action = deferred()
    const started = deferred()
    const disconnected = deferred()
    const cancelStarted = deferred()
    const cancelStart = vi.fn(() => {
      cancelStarted.resolve()
      return disconnected.promise
    })
    let settled = false
    const result = awaitHandoffAction({
      wait,
      start: () => {
        started.resolve()
        return action.promise
      },
      cancelStart,
    }).finally(() => { settled = true })
    await started.promise
    expect(registry.complete({ id: wait.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })).toBe(true)
    expect(registry.pendingCount).toBe(1)
    expect(registry.cancelForTarget({ targetId: "target-7", targetSessionId: "stale", reason: "target-detached" })).toEqual([])
    if (ending === "timeout") {
      await vi.advanceTimersByTimeAsync(5_000)
    } else {
      expect(registry.cancelForTarget({ targetId: "target-7", targetSessionId: "bc-tab-7", reason: ending })).toHaveLength(1)
    }
    await cancelStarted.promise
    expect(cancelStart).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    disconnected.resolve()
    await expect(result).resolves.toEqual(ending === "timeout" ? "timeout" : { type: "cancelled", reason: ending })
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    action.reject(new Error("late disconnection rejection"))
    await Promise.resolve()
  })

  it("lets the start action settle instead of disconnecting it when completion precedes the hold", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 5_000 })
    registry.complete({ id: wait.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })
    const action = deferred()
    const cancelStart = vi.fn(async () => {})
    let settled = false
    const result = awaitHandoffAction({ wait, start: () => action.promise, cancelStart }).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    action.resolve()
    await expect(result).resolves.toBe("resolved")
    expect(cancelStart).not.toHaveBeenCalled()
  })

  it("preserves a start failure after the human has completed the handoff", async () => {
    vi.useFakeTimers()
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 5_000 })
    const action = deferred()
    const started = deferred()
    const result = awaitHandoffAction({
      wait,
      start: () => {
        started.resolve()
        return action.promise
      },
    })
    await started.promise
    registry.complete({ id: wait.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })
    const assertion = expect(result).rejects.toThrow("prompt action failed")
    action.reject(new Error("prompt action failed"))
    await assertion
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still waits for the human when the action settles first", async () => {
    vi.useFakeTimers()
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 5_000 })
    let settled = false
    const result = awaitHandoffAction({
      wait,
      start: () => undefined,
    }).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(registry.pendingCount).toBe(1)
    registry.complete({ id: wait.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })
    await expect(result).resolves.toBe("resolved")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps held completion bound to the rebound target and ignores a late release after replacement", async () => {
    vi.useFakeTimers()
    const registry = registryWithIds("handoff-1", "handoff-2")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7", message: "m", timeoutMs: 5_000 })
    const release = wait.holdCompletion()
    registry.complete({ id: wait.id, tabId: 7, targetId: "target-7", targetSessionId: "bc-tab-7" })
    expect(registry.rebindTarget({ tabId: 7, previousTargetId: "target-7", previousTargetSessionId: "bc-tab-7", targetId: "new-target", targetSessionId: "new-session" })).toBe(true)
    expect(registry.cancelForTarget({ targetId: "target-7", targetSessionId: "bc-tab-7", reason: "target-detached" })).toEqual([])
    expect(registry.cancelForTarget({ targetId: "new-target", targetSessionId: "new-session", reason: "target-crashed" })).toHaveLength(1)
    await expect(wait.outcome).resolves.toEqual({ type: "cancelled", reason: "target-crashed" })
    const replacement = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "new-target", targetSessionId: "new-session", message: "m", timeoutMs: 5_000 })
    release()
    release()
    expect(registry.pendingForSession("alpha")?.id).toBe(replacement.id)
    expect(vi.getTimerCount()).toBe(1)
    registry.cancelAll()
    await expect(replacement.outcome).resolves.toBe("timeout")
    expect(vi.getTimerCount()).toBe(0)
  })

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

  it("rebinds a pending handoff to a replacement root generation", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-old", targetSessionId: "bc-tab-old", message: "m", timeoutMs: 5_000 })

    expect(registry.rebindTarget({
      tabId: 7,
      previousTargetId: "target-old",
      previousTargetSessionId: "bc-tab-old",
      targetId: "target-new",
      targetSessionId: "bc-tab-new",
    })).toBe(true)
    expect(registry.complete({ id: wait.id, tabId: 7, targetId: "target-old", targetSessionId: "bc-tab-old" })).toBe(false)
    expect(registry.complete({ id: wait.id, tabId: 7, targetId: "target-new", targetSessionId: "bc-tab-new" })).toBe(true)
    await expect(wait.outcome).resolves.toBe("resolved")
  })

  it("cancels a registered handoff when its start action fails", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1", message: "m", timeoutMs: 5_000 })

    await expect(awaitHandoffAction({
      wait,
      start: () => Promise.reject(new Error("prompt action failed")),
    })).rejects.toThrow("prompt action failed")
    expect(registry.cancel(wait.id)).toBe(false)
    await expect(wait.outcome).resolves.toBe("timeout")
    expect(registry.pendingCount).toBe(0)
  })

  it("does not start the prompt action until WAIT presentation is acknowledged", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1", message: "m", timeoutMs: 5_000 })
    let acknowledgePresentation: (() => void) | undefined
    const presented = new Promise<void>((resolve) => {
      acknowledgePresentation = resolve
    })
    let markStarted: (() => void) | undefined
    const startCalled = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let started = false
    const result = awaitHandoffAction({
      wait,
      present: () => presented,
      start: () => {
        started = true
        markStarted?.()
      },
    })

    await Promise.resolve()
    expect(started).toBe(false)
    acknowledgePresentation?.()
    await startCalled
    expect(started).toBe(true)
    expect(registry.complete({ id: wait.id, tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1" })).toBe(true)
    await expect(result).resolves.toBe("resolved")
  })

  it("does not start the prompt action when the handoff ends before WAIT is acknowledged", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1", message: "m", timeoutMs: 5_000 })
    let acknowledgePresentation: (() => void) | undefined
    const presented = new Promise<void>((resolve) => {
      acknowledgePresentation = resolve
    })
    let started = false
    const result = awaitHandoffAction({
      wait,
      present: () => presented,
      start: () => {
        started = true
      },
    })

    expect(registry.cancel(wait.id)).toBe(true)
    await expect(result).resolves.toBe("timeout")
    acknowledgePresentation?.()
    await Promise.resolve()
    expect(started).toBe(false)
  })

  it("starts a blocking action after registration and waits for both outcomes", async () => {
    vi.useFakeTimers()
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1", message: "m", timeoutMs: 5_000 })
    let finishAction: (() => void) | undefined
    const action = new Promise<void>((resolve) => {
      finishAction = resolve
    })
    let settled = false
    const result = awaitHandoffAction({
      wait,
      start: () => {
        expect(registry.pendingCount).toBe(1)
        return action
      },
    }).finally(() => {
      settled = true
    })

    await Promise.resolve()
    expect(registry.pendingCount).toBe(1)
    registry.complete({ id: wait.id, tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1" })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(registry.pendingCount).toBe(1)
    finishAction?.()
    await expect(result).resolves.toBe("resolved")
    expect(registry.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("disconnects a non-settling start action after the handoff times out", async () => {
    const registry = registryWithIds("handoff-1")
    const wait = registry.wait({ sessionId: "alpha", tabId: 7, targetId: "target-1", targetSessionId: "bc-tab-1", message: "m", timeoutMs: 5_000 })
    let cancelled = false
    const result = awaitHandoffAction({
      wait,
      start: () => new Promise(() => {}),
      cancelStart: async () => {
        cancelled = true
      },
    })

    expect(registry.cancel(wait.id)).toBe(true)
    await expect(result).resolves.toBe("timeout")
    expect(cancelled).toBe(true)
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
