import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { recoverSessionPage, runPlaywrightOperation, waitForPageContext } from "../src/execute.ts"

describe("execute lifecycle", () => {
  it("bounds a Playwright operation that never settles", async () => {
    const error = await Effect.runPromise(runPlaywrightOperation({
      label: "Close test page",
      timeoutMs: 20,
      run: () => new Promise<void>(() => {}),
    }).pipe(Effect.flip))

    expect(error.message).toBe("Close test page timed out after 20ms")
  })

  it("keeps a navigable relay-owned error document", async () => {
    let closed = false
    const result = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "chrome-error://chromewebdata/",
      timeoutMs: 20,
      healthCheck: () => Promise.resolve(),
      close: () => {
        closed = true
        return Promise.resolve()
      },
    }))

    expect(result).toBe("use")
    expect(closed).toBe(false)
  })

  it("recreates a relay-owned error document whose context is unavailable", async () => {
    let closed = false
    const result = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "chrome-error://chromewebdata/",
      timeoutMs: 20,
      healthCheck: () => Promise.reject(new Error("Execution context was destroyed")),
      close: () => {
        closed = true
        return Promise.resolve()
      },
    }))

    expect(result).toBe("recreate")
    expect(closed).toBe(true)
  })

  it("does not claim recovery when an unhealthy relay-owned page cannot close", async () => {
    const error = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "chrome-error://chromewebdata/",
      timeoutMs: 20,
      healthCheck: () => Promise.reject(new Error("Execution context was destroyed")),
      close: () => Promise.reject(new Error("target did not close")),
    })).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error instanceof Error ? error.message : "").toContain("could not be closed")
  })

  it("fails fast without closing an unhealthy adopted page", async () => {
    let closed = false
    const error = await Effect.runPromise(recoverSessionPage({
      ownsPage: false,
      url: "https://example.test/form",
      timeoutMs: 20,
      healthCheck: () => Promise.reject(new Error("Execution context was destroyed")),
      close: () => {
        closed = true
        return Promise.resolve()
      },
    })).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").toContain("adopted session page is unresponsive")
    expect(closed).toBe(false)
  })

  it("keeps a page that passes the bounded health check", async () => {
    const result = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "https://example.test/form",
      timeoutMs: 20,
      healthCheck: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }))

    expect(result).toBe("use")
  })

  it("waits through transient execution-context replacement", async () => {
    let attempts = 0
    await expect(waitForPageContext({
      timeoutMs: 1_000,
      retryDelayMs: 10,
      delay: () => Promise.resolve(),
      evaluate: () => ++attempts < 3
        ? Promise.reject(new Error("Execution context was destroyed"))
        : Promise.resolve(),
    })).resolves.toBeUndefined()
    expect(attempts).toBe(3)
  })

  it("does not retry non-context page failures", async () => {
    let attempts = 0
    await expect(waitForPageContext({
      timeoutMs: 30,
      retryDelayMs: 10,
      delay: () => Promise.resolve(),
      evaluate: () => {
        attempts += 1
        return Promise.reject(new Error("Permission denied"))
      },
    })).rejects.toThrow("Permission denied")
    expect(attempts).toBe(1)
  })

  it("bounds a context evaluation that never settles", async () => {
    const startedAt = Date.now()
    await expect(waitForPageContext({
      timeoutMs: 20,
      evaluate: () => new Promise<void>(() => {}),
    })).rejects.toThrow("did not become available within 20ms")
    expect(Date.now() - startedAt).toBeLessThan(100)
  })
})
