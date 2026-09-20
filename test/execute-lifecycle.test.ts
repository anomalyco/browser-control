import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { chromium, selectors, type Browser, type BrowserContext } from "playwright-core"
import { defaultPageRepairedWarning, ExecuteSandbox, finishHandoff, isDisposableSessionPage, isSessionPageConnected, recoverSessionPage, runPlaywrightOperation, waitForPageContext } from "../src/execute.ts"
import { runtimeFailureKind } from "../src/runtime-diagnostics.ts"

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
      title: async () => "Fixture",
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

  it.each([
    { kind: "rewritten evaluate", error: "Execution context was destroyed, most likely because of a navigation." },
    { kind: "locator retry", error: "locator.inputValue: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#payment').contentFrame().locator('#card')" },
  ])("names protected extension UI behind a $kind failure while the relay reports the tab blocked", async ({ error }) => {
    // Playwright hides Chrome's "Cannot access a chrome-extension:// URL of
    // different extension" rejection behind a rewritten evaluate error or a
    // locator timeout; only the relay saw the real message.
    const page = {
      isClosed: () => false,
      url: () => "https://example.test/pay",
      title: async () => "Fixture",
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
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://127.0.0.1:1", pageHealthCheckTimeoutMs: 50 })
    try {
      const ready = await Effect.runPromise(sandbox.execute("state.originalPage = page; return page.url()"))
      expect(ready).toMatchObject({ isError: false, value: "https://example.test/pay" })
      expect(sandbox.markTargetProtectedUi("other-target", true)).toBe(false)
      expect(sandbox.markTargetProtectedUi("fixture-target", true)).toBe(true)

      const failure = await Effect.runPromise(sandbox.execute("return page.evaluate(() => true)"))
      expect(failure.isError).toBe(true)
      expect(failure.text).toContain(error.split("\n")[0])
      expect(failure.diagnostic).toBe("target/cross-extension-page")
      expect(failure.warnings).toEqual([
        "Chromium blocked protected extension UI, possibly a password manager. Ask the user to finish or dismiss it in the browser, then retry.",
      ])
      // The tab is healthy; no health check, repair, or replacement follows.
      expect(sandbox.getStatus()).toMatchObject({ connected: true, pageUrl: "https://example.test/pay" })
      const continued = await Effect.runPromise(sandbox.execute("return { samePage: page === state.originalPage }"))
      expect(continued).toMatchObject({ isError: false, value: { samePage: true }, warnings: [] })
      expect(page.evaluate).toHaveBeenCalledTimes(1)
      expect(context.newPage).toHaveBeenCalledTimes(1)
      expect(page.close).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledTimes(1)

      // Once the menu is dismissed the same failure is classified as before.
      expect(sandbox.markTargetProtectedUi("fixture-target", false)).toBe(true)
      const later = await Effect.runPromise(sandbox.execute("return page.evaluate(() => true)"))
      expect(later.isError).toBe(true)
      expect(later.diagnostic).not.toBe("target/cross-extension-page")
      expect(later.warnings).toEqual([])
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
      connect.mockRestore()
      register.mockRestore()
    }
  })

  it("repairs a stale relay-owned page over a fresh connection instead of replacing it", async () => {
    const makePage = (evaluate: () => Promise<boolean>) => ({
      isClosed: () => false,
      url: () => "https://example.test/sign-in",
      title: async () => "Fixture",
      context: (): BrowserContext => context as unknown as BrowserContext,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      evaluate: vi.fn(evaluate),
      close: vi.fn().mockResolvedValue(undefined),
    })
    // The first Playwright view of the tab keeps failing with a stale context id.
    const stalePage = makePage(() => Promise.reject(new Error("Execution context was destroyed")))
    // The same tab re-resolved over a new connection answers immediately.
    const repairedPage = makePage(() => Promise.resolve(true))
    const pages: Array<typeof stalePage> = []
    const context = {
      pages: () => pages,
      on: vi.fn(),
      newPage: vi.fn(async () => {
        pages.push(stalePage)
        return stalePage
      }),
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: "fixture-target" } }),
        detach: async () => {},
      }),
    }
    let connected = true
    const browser = {
      isConnected: () => connected,
      contexts: () => [context],
      close: vi.fn(async () => { connected = false }),
    }
    const connect = vi.spyOn(chromium, "connectOverCDP").mockImplementation(async () => {
      connected = true
      return browser as unknown as Browser
    })
    const register = vi.spyOn(selectors, "register").mockResolvedValue(undefined)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://127.0.0.1:1", pageHealthCheckTimeoutMs: 50 })
    try {
      const failure = await Effect.runPromise(sandbox.execute("return page.evaluate(() => true)"))
      expect(failure.isError).toBe(true)
      expect(failure.diagnostic).toMatch(/^execution-context\/context-destroyed/)
      expect(sandbox.getStatus().connected).toBe(false)

      // Reconnecting exposes the same target id through a fresh page object.
      pages.splice(0, pages.length, repairedPage)
      const continued = await Effect.runPromise(sandbox.execute("return { url: page.url() }"))
      expect(continued).toMatchObject({ isError: false, value: { url: "https://example.test/sign-in" } })
      expect(continued.warnings).toEqual([defaultPageRepairedWarning])
      expect(stalePage.close).not.toHaveBeenCalled()
      expect(context.newPage).toHaveBeenCalledTimes(1)
      expect(browser.close).toHaveBeenCalledTimes(1)
      expect(connect).toHaveBeenCalledTimes(2)
      expect(sandbox.getStatus()).toMatchObject({ connected: true, pageUrl: "https://example.test/sign-in" })
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
      connect.mockRestore()
      register.mockRestore()
    }
  })

  it("reports an unresponsive relay-owned page and keeps the tab when repair does not help", async () => {
    const page = {
      isClosed: () => false,
      url: () => "https://example.test/customize-your-trip",
      title: async () => "Fixture",
      context: (): BrowserContext => context as unknown as BrowserContext,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      evaluate: vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error("Execution context was destroyed")),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const pages: Array<typeof page> = []
    const context = {
      pages: () => pages,
      on: vi.fn(),
      newPage: vi.fn(async () => {
        pages.push(page)
        return page
      }),
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: "fixture-target" } }),
        detach: async () => {},
      }),
    }
    let connected = true
    const browser = {
      isConnected: () => connected,
      contexts: () => [context],
      close: vi.fn(async () => { connected = false }),
    }
    const connect = vi.spyOn(chromium, "connectOverCDP").mockImplementation(async () => {
      connected = true
      return browser as unknown as Browser
    })
    const register = vi.spyOn(selectors, "register").mockResolvedValue(undefined)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://127.0.0.1:1", pageHealthCheckTimeoutMs: 50 })
    try {
      const failure = await Effect.runPromise(sandbox.execute("return page.evaluate(() => document.readyState)"))
      expect(failure.isError).toBe(true)
      expect(failure.diagnostic).toMatch(/^execution-context\/context-destroyed/)

      const kept = await Effect.runPromise(sandbox.execute("return page.url()"))
      expect(kept.isError).toBe(true)
      expect(kept.setupFailed).toBe(true)
      expect(kept.diagnostic).toBe("session-page/owned-unresponsive")
      expect(kept.text).toContain("relay-owned session page is unresponsive")
      expect(kept.text).toContain("was kept and was not replaced")
      expect(kept.warnings).toEqual([])
      expect(page.close).not.toHaveBeenCalled()
      expect(context.newPage).toHaveBeenCalledTimes(1)
      expect(sandbox.getStatus()).toMatchObject({ connected: false, pageUrl: "https://example.test/customize-your-trip" })
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
      connect.mockRestore()
      register.mockRestore()
    }
  })

  it("still recreates a crashed relay-owned page", async () => {
    const page = {
      isClosed: () => false,
      url: () => "https://example.test/form",
      title: async () => "Fixture",
      context: (): BrowserContext => context as unknown as BrowserContext,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      evaluate: vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error("Target crashed")),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const freshPage = { ...page, url: () => "about:blank", evaluate: vi.fn().mockResolvedValue(true), close: vi.fn() }
    const context = {
      pages: () => [],
      on: vi.fn(),
      newPage: vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(freshPage),
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
      const failure = await Effect.runPromise(sandbox.execute("return page.evaluate(() => true)"))
      expect(failure.isError).toBe(true)
      expect(sandbox.markTargetCrashed("fixture-target")).toBe(true)

      const recovered = await Effect.runPromise(sandbox.execute("return page.url()"))
      expect(recovered).toMatchObject({ isError: false, value: "about:blank" })
      expect(recovered.warnings).toEqual([
        "The session default page target crashed; checking it before the next execute.",
        "The session default page was unresponsive; created a new page. References to the old page in state are stale.",
      ])
      expect(page.close).toHaveBeenCalledTimes(1)
      expect(context.newPage).toHaveBeenCalledTimes(2)
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

  it("keeps a relay-owned page with user state instead of closing it", async () => {
    let closed = false
    const result = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "https://example.test/sign-in",
      timeoutMs: 20,
      healthCheck: () => Promise.reject(new Error("Execution context was destroyed")),
      close: () => {
        closed = true
        return Promise.resolve()
      },
    }))

    expect(result).toBe("repair")
    expect(closed).toBe(false)
  })

  it("diagnoses a relay-owned page that stays unresponsive after repair without closing it", async () => {
    let closed = false
    const error = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "https://example.test/sign-in",
      timeoutMs: 20,
      repaired: true,
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
    const message = error instanceof Error ? error.message : ""
    expect(message).toContain("relay-owned session page is unresponsive")
    expect(message).toContain("even after reconnecting")
    expect(message).toContain("was kept")
    expect(closed).toBe(false)
  })

  it("recreates a crashed relay-owned page regardless of its URL", async () => {
    let closed = false
    const result = await Effect.runPromise(recoverSessionPage({
      ownsPage: true,
      url: "https://example.test/form",
      timeoutMs: 20,
      crashed: true,
      healthCheck: () => Promise.reject(new Error("Target crashed")),
      close: () => {
        closed = true
        return Promise.resolve()
      },
    }))

    expect(result).toBe("recreate")
    expect(closed).toBe(true)
  })

  it("classifies which relay-owned documents are disposable", () => {
    expect(isDisposableSessionPage({ url: "about:blank" })).toBe(true)
    expect(isDisposableSessionPage({ url: "" })).toBe(true)
    expect(isDisposableSessionPage({ url: "chrome-error://chromewebdata/" })).toBe(true)
    expect(isDisposableSessionPage({ url: "https://example.test/form", crashed: true })).toBe(true)
    expect(isDisposableSessionPage({ url: "https://example.test/form" })).toBe(false)
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

  it("explains a resolved handoff whose destination context never appears", async () => {
    const error = await finishHandoff({
      outcome: "resolved",
      message: "Sign in",
      timeoutMs: 30_000,
      contextTimeoutMs: 30,
      retryDelayMs: 0,
      delay: () => Promise.resolve(),
      evaluate: () => Promise.reject(new Error("Execution context was destroyed, most likely because of a navigation.")),
    }).then(() => undefined, (cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ""
    expect(message).toContain("Handoff resolved (Sign in)")
    expect(message).toContain("did not become available within 30ms")
    expect(message).toContain("The tab was kept")
    expect(runtimeFailureKind(error)).toBe("context-destroyed")
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
