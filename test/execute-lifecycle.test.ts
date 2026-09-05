import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { chromium, selectors, type Browser, type BrowserContext } from "playwright-core"
import { ExecuteSandbox, finishHandoff, isSessionPageConnected, recoverSessionPage, runPlaywrightOperation, waitForPageContext } from "../src/execute.ts"

describe("execute lifecycle", () => {
  it("reports a session connected only when it has a live default page", () => {
    expect(isSessionPageConnected({ browserConnected: true, pageUrl: null, healthCheckRequired: false })).toBe(false)
    expect(isSessionPageConnected({ browserConnected: true, pageUrl: "about:blank", healthCheckRequired: false })).toBe(true)
    expect(isSessionPageConnected({ browserConnected: false, pageUrl: "about:blank", healthCheckRequired: false })).toBe(false)
    expect(isSessionPageConnected({ browserConnected: true, pageUrl: "about:blank", healthCheckRequired: true })).toBe(false)
  })

  it.each([
    { kind: "protected extension", error: "Cannot access a chrome-extension:// URL of different extension", healthCheck: false },
    { kind: "destroyed context", error: "Execution context was destroyed", healthCheck: true },
    { kind: "crashed target", error: "Target closed", healthCheck: true },
  ])("handles $kind failures without losing the session page", async ({ kind, error, healthCheck }) => {
    const page = {
      isClosed: () => false,
      url: () => "https://example.test/form",
      context: (): BrowserContext => context as unknown as BrowserContext,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      evaluate: vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error(error)),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const context = {
      pages: () => [],
      on: vi.fn(),
      newPage: vi.fn().mockResolvedValueOnce(page).mockRejectedValue(new Error("Unexpected page replacement")),
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: "fixture-target" } }),
        detach: async () => {},
      }),
    }
    const browser = {
      isConnected: () => true,
      contexts: () => [context],
      close: vi.fn().mockResolvedValue(undefined),
    }
    const connect = vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser as unknown as Browser)
    const register = vi.spyOn(selectors, "register").mockResolvedValue(undefined)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://127.0.0.1:1" })
    try {
      const failure = await Effect.runPromise(sandbox.execute("state.originalPage = page; return page.evaluate(() => true)"))
      expect(failure.isError).toBe(true)
      expect(failure.text).toContain(error)
      if (kind === "protected extension") {
        expect(failure.diagnostic).toBe("target/cross-extension-page")
        expect(failure.warnings).toEqual([
          "Chromium blocked protected extension UI, possibly a password manager. Ask the user to finish or dismiss it in the browser, then retry.",
        ])
      } else {
        expect(failure.warnings).toEqual([])
      }
      if (kind === "crashed target") expect(sandbox.markTargetCrashed("fixture-target")).toBe(true)
      expect(sandbox.getStatus()).toMatchObject({ connected: !healthCheck, pageUrl: "https://example.test/form" })

      // Keep the permission failure active: the next execute must not probe or replace this page.
      if (healthCheck) page.evaluate.mockResolvedValue(true)
      const continued = await Effect.runPromise(sandbox.execute("return { samePage: page === state.originalPage }"))
      expect(continued).toMatchObject({ isError: false, value: { samePage: true } })
      expect(page.evaluate).toHaveBeenCalledTimes(healthCheck ? 2 : 1)
      expect(context.newPage).toHaveBeenCalledTimes(1)
      expect(page.close).not.toHaveBeenCalled()
      expect(sandbox.getStatus().connected).toBe(true)

      page.evaluate.mockResolvedValue(true)
      const retried = await Effect.runPromise(sandbox.execute("return page.evaluate(() => true)"))
      expect(retried).toMatchObject({ isError: false, value: true, warnings: [] })
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
      connect.mockRestore()
      register.mockRestore()
    }
  })

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

  it("does not return from a resolved handoff until the destination context is available", async () => {
    let attempts = 0
    await expect(finishHandoff({
      outcome: "resolved",
      message: "complete authentication",
      timeoutMs: 30_000,
      contextTimeoutMs: 1_000,
      retryDelayMs: 0,
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
