import { describe, expect, it, vi } from "vitest"
import type { Locator, Page } from "playwright-core"
import {
  createAriaSnapshotHelper,
  createExecuteLogCapture,
  createSnapshotHelpers,
  defaultAriaSnapshotTimeoutMs,
  pageTargetId,
} from "../src/execute.ts"

describe("execute log capture", () => {
  it("deduplicates equivalent page logs but not script-authored logs", () => {
    const capture = createExecuteLogCapture()
    const pageWarning = {
      source: "page" as const,
      type: "warning",
      text: "Permissions-Policy header warning",
      location: { url: "https://example.com", lineNumber: 1, columnNumber: 2 },
    }

    capture.add(pageWarning)
    capture.add(pageWarning)
    capture.add(pageWarning)
    capture.add({ source: "script", type: "log", text: "checkpoint" })
    capture.add({ source: "script", type: "log", text: "checkpoint" })

    const result = capture.snapshot()
    expect(result.logs).toEqual([
      { ...pageWarning, repeatCount: 2 },
      { source: "script", type: "log", text: "checkpoint" },
      { source: "script", type: "log", text: "checkpoint" },
    ])
    expect(result.summary).toEqual({
      totalCount: 5,
      returnedCount: 3,
      repeatedCount: 2,
      omittedCount: 0,
    })
  })

  it("bounds each source while preserving raw aftermath error counts", () => {
    const capture = createExecuteLogCapture({ page: 2, script: 2 })

    capture.add({ source: "page", type: "error", text: "page console error 1" })
    capture.add({ source: "page", type: "error", text: "page console error 1" })
    capture.add({ source: "page", type: "pageerror", text: "uncaught 1" })
    capture.add({ source: "page", type: "error", text: "omitted page console error" })
    capture.add({ source: "page", type: "pageerror", text: "omitted uncaught error" })
    capture.add({ source: "script", type: "error", text: "script error 1" })
    capture.add({ source: "script", type: "error", text: "script error 2" })
    capture.add({ source: "script", type: "error", text: "omitted script error" })

    const result = capture.snapshot()
    expect(result.logs).toHaveLength(4)
    expect(result.summary).toEqual({
      totalCount: 8,
      returnedCount: 4,
      repeatedCount: 1,
      omittedCount: 3,
    })
    expect(result.consoleErrorCount).toBe(6)
    expect(result.pageErrorCount).toBe(2)
  })
})

describe("ariaSnapshot helper", () => {
  it("uses a bounded default timeout for the default body target", async () => {
    const ariaSnapshot = vi.fn().mockResolvedValue("snapshot")
    const locator = { ariaSnapshot } as unknown as Locator
    const page = { locator: vi.fn(() => locator) } as unknown as Pick<Page, "locator">

    await expect(createAriaSnapshotHelper(page)()).resolves.toBe("snapshot")
    expect(page.locator).toHaveBeenCalledWith("body")
    expect(ariaSnapshot).toHaveBeenCalledWith({ timeout: defaultAriaSnapshotTimeoutMs })
  })

  it("preserves selector and locator targets and accepts a short timeout", async () => {
    const selectorSnapshot = vi.fn().mockResolvedValue("selector")
    const selectorLocator = { ariaSnapshot: selectorSnapshot } as unknown as Locator
    const page = { locator: vi.fn(() => selectorLocator) } as unknown as Pick<Page, "locator">
    const helper = createAriaSnapshotHelper(page)

    await expect(helper("main", { timeout: 250 })).resolves.toBe("selector")
    expect(page.locator).toHaveBeenCalledWith("main")
    expect(selectorSnapshot).toHaveBeenCalledWith({ timeout: 250 })

    const locatorSnapshot = vi.fn().mockResolvedValue("locator")
    const locator = { ariaSnapshot: locatorSnapshot } as unknown as Locator
    await expect(helper(locator, { timeout: 400 })).resolves.toBe("locator")
    expect(locatorSnapshot).toHaveBeenCalledWith({ timeout: 400 })
    expect(page.locator).toHaveBeenCalledTimes(1)
  })
})

describe("snapshot helpers", () => {
  it("formats a compact snapshot and resolves refs from the latest capture", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      entries: [
        { depth: 0, role: "heading", name: "Settings", details: "level=1" },
        { depth: 1, role: "button", name: "Save", identityName: "Save", selector: "#save" },
      ],
      truncated: false,
    })
    const resolvedLocator = { click: vi.fn() } as unknown as Locator
    const saveLocator = { and: vi.fn(() => resolvedLocator) } as unknown as Locator
    const saveRoleLocator = {} as unknown as Locator
    const mainFrame = {}
    const page = {
      evaluate,
      locator: vi.fn(() => saveLocator),
      getByRole: vi.fn(() => saveRoleLocator),
      url: vi.fn(() => "https://example.com/settings"),
      mainFrame: vi.fn(() => mainFrame),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page
    const helpers = createSnapshotHelpers(page, { selectors: new Map() })

    await expect(helpers.snapshot()).resolves.toBe('- heading "Settings" [level=1]\n  - button "Save" [ref=e1]')
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ maxItems: 80, rootSelector: undefined })
    expect(helpers.ref("@e1")).toBe(resolvedLocator)
    expect(page.locator).toHaveBeenLastCalledWith("#save")
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Save", exact: true })
    expect(saveLocator.and).toHaveBeenCalledWith(saveRoleLocator)
  })

  it("rejects unknown and navigation-stale refs, including same-URL reloads", async () => {
    let currentUrl = "https://example.com/settings"
    let onFrameNavigated: ((frame: unknown) => void) | undefined
    const mainFrame = {}
    const evaluate = vi.fn().mockResolvedValue({
        entries: [{ depth: 0, role: "link", name: "Account", selector: "#account" }],
        truncated: false,
      })
    const rootLocator = {} as unknown as Locator
    const page = {
      evaluate,
      locator: vi.fn(() => rootLocator),
      url: vi.fn(() => currentUrl),
      mainFrame: vi.fn(() => mainFrame),
      on: vi.fn((event: string, handler: (frame: unknown) => void) => {
        if (event === "framenavigated") onFrameNavigated = handler
      }),
      off: vi.fn(),
    } as unknown as Page
    const helpers = createSnapshotHelpers(page, { selectors: new Map() })

    await helpers.snapshot()
    expect(() => helpers.ref("e2")).toThrow("Unknown snapshot ref")
    onFrameNavigated?.(mainFrame)
    expect(() => helpers.ref("e1")).toThrow("Snapshot refs are stale")

    await helpers.snapshot()
    currentUrl = "https://example.com/account"
    expect(() => helpers.ref("e1")).toThrow("Snapshot refs are stale")
  })

  it("rejects refs when the page navigates during capture", async () => {
    let onFrameNavigated: ((frame: unknown) => void) | undefined
    const mainFrame = {}
    const page = {
      evaluate: vi.fn(async () => {
        onFrameNavigated?.(mainFrame)
        return {
          entries: [{ depth: 0, role: "button", name: "Save", identityName: "Save", selector: "#save" }],
          truncated: false,
        }
      }),
      locator: vi.fn(),
      url: vi.fn(() => "https://example.com/after"),
      mainFrame: vi.fn(() => mainFrame),
      on: vi.fn((event: string, handler: (frame: unknown) => void) => {
        if (event === "framenavigated") onFrameNavigated = handler
      }),
      off: vi.fn(),
    } as unknown as Page
    const registry = { selectors: new Map() }
    const helpers = createSnapshotHelpers(page, registry)

    await expect(helpers.snapshot()).rejects.toThrow("Page navigated while snapshot() was capturing")
    expect(registry.selectors.size).toBe(0)
    expect(() => helpers.ref("e1")).toThrow("Snapshot refs are stale")
  })
})

describe("pageTargetId", () => {
  it("derives the stable target id from the actual Playwright page and detaches the probe", async () => {
    const detach = vi.fn().mockResolvedValue(undefined)
    const send = vi.fn().mockResolvedValue({ targetInfo: { targetId: "target-stable" } })
    const session = { send, detach }
    const context = { newCDPSession: vi.fn().mockResolvedValue(session) }
    const page = { context: () => context, isClosed: () => false } as unknown as Page

    await expect(pageTargetId(page)).resolves.toBe("target-stable")
    expect(context.newCDPSession).toHaveBeenCalledWith(page)
    expect(send).toHaveBeenCalledWith("Target.getTargetInfo")
    expect(detach).toHaveBeenCalledOnce()
  })

  it("detaches the identity probe when target lookup fails", async () => {
    const detach = vi.fn().mockResolvedValue(undefined)
    const session = { send: vi.fn().mockRejectedValue(new Error("target detached")), detach }
    const context = { newCDPSession: vi.fn().mockResolvedValue(session) }
    const page = { context: () => context, isClosed: () => false } as unknown as Page

    await expect(pageTargetId(page)).rejects.toThrow("target detached")
    expect(detach).toHaveBeenCalledOnce()
  })
})
