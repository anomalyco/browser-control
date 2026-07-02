import { describe, expect, it } from "vitest"
import { HandoffRegistry } from "../src/handoff.ts"

describe("HandoffRegistry", () => {
  it("resolves a pending handoff for its session", async () => {
    const registry = new HandoffRegistry()
    const outcome = registry.wait({ sessionId: "alpha", message: "do the 2fa", timeoutMs: 5_000 })
    expect(registry.pendingCount).toBe(1)
    expect(registry.pendingMessage("alpha")).toBe("do the 2fa")
    expect(registry.resolveForSession("alpha")).toBe(true)
    await expect(outcome).resolves.toBe("resolved")
    expect(registry.pendingCount).toBe(0)
  })

  it("does not resolve other sessions", () => {
    const registry = new HandoffRegistry()
    void registry.wait({ sessionId: "alpha", message: "m", timeoutMs: 5_000 })
    expect(registry.resolveForSession("beta")).toBe(false)
    registry.cancelAll()
  })

  it("times out when nobody clicks", async () => {
    const registry = new HandoffRegistry()
    const outcome = registry.wait({ sessionId: "alpha", message: "m", timeoutMs: 10 })
    await expect(outcome).resolves.toBe("timeout")
    expect(registry.pendingCount).toBe(0)
  })

  it("resolveIfSingle resolves only when exactly one handoff is pending", async () => {
    const registry = new HandoffRegistry()
    expect(registry.resolveIfSingle()).toBe(false)
    const first = registry.wait({ sessionId: "alpha", message: "m", timeoutMs: 5_000 })
    const second = registry.wait({ sessionId: "beta", message: "m", timeoutMs: 5_000 })
    expect(registry.resolveIfSingle()).toBe(false)
    registry.cancelAll()
    await expect(first).resolves.toBe("timeout")
    await expect(second).resolves.toBe("timeout")
    const third = registry.wait({ sessionId: "gamma", message: "m", timeoutMs: 5_000 })
    expect(registry.resolveIfSingle()).toBe(true)
    await expect(third).resolves.toBe("resolved")
  })

  it("a second wait for the same session times out the first", async () => {
    const registry = new HandoffRegistry()
    const first = registry.wait({ sessionId: "alpha", message: "one", timeoutMs: 5_000 })
    const second = registry.wait({ sessionId: "alpha", message: "two", timeoutMs: 5_000 })
    await expect(first).resolves.toBe("timeout")
    expect(registry.resolveForSession("alpha")).toBe(true)
    await expect(second).resolves.toBe("resolved")
  })

  it("cancelAll times out every waiter", async () => {
    const registry = new HandoffRegistry()
    const one = registry.wait({ sessionId: "a", message: "m", timeoutMs: 5_000 })
    const two = registry.wait({ sessionId: "b", message: "m", timeoutMs: 5_000 })
    registry.cancelAll()
    await expect(one).resolves.toBe("timeout")
    await expect(two).resolves.toBe("timeout")
    expect(registry.pendingCount).toBe(0)
  })
})
