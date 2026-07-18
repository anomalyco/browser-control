import { describe, expect, it, vi } from "vitest"
import type { Locator, Page } from "playwright-core"
import {
  createAriaSnapshotHelper,
  createExecuteLogCapture,
  createSnapshotHelpers,
  defaultAriaSnapshotTimeoutMs,
  fillInputs,
  pageTargetId,
  runUserCode,
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

  it("folds routine policy and blocked analytics chatter without folding application errors", () => {
    const capture = createExecuteLogCapture()

    capture.add({ source: "page", type: "warning", text: "Permissions-Policy header warning: camera", location: { url: "https://example.com/a", lineNumber: 1, columnNumber: 1 } })
    capture.add({ source: "page", type: "warning", text: "Permissions-Policy header warning: microphone", location: { url: "https://example.com/b", lineNumber: 2, columnNumber: 1 } })
    capture.add({ source: "page", type: "error", text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", location: { url: "https://www.google-analytics.com/g/collect", lineNumber: 0, columnNumber: 0 } })
    capture.add({ source: "page", type: "error", text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", location: { url: "https://www.googletagmanager.com/gtm.js", lineNumber: 0, columnNumber: 0 } })
    capture.add({ source: "page", type: "error", text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", location: { url: "https://example.com/app.js", lineNumber: 0, columnNumber: 0 } })
    capture.add({ source: "page", type: "warning", text: "Application permissions-policy configuration is invalid", location: { url: "https://example.com/app.js", lineNumber: 10, columnNumber: 2 } })

    const result = capture.snapshot()
    expect(result.logs).toHaveLength(4)
    expect(result.logs[0]).toMatchObject({ repeatCount: 1 })
    expect(result.logs[1]).toMatchObject({ repeatCount: 1 })
    expect(result.logs[2]).toMatchObject({ location: { url: "https://example.com/app.js" } })
    expect(result.logs[3]).toMatchObject({ text: "Application permissions-policy configuration is invalid" })
    expect(result.summary).toEqual({ totalCount: 6, returnedCount: 4, repeatedCount: 2, omittedCount: 0 })
    expect(result.consoleErrorCount).toBe(3)
  })
})

describe("user code execution", () => {
  it("keeps module aliases available while allowing scripts to shadow them", async () => {
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => "https://example.com"),
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => ({})),
    }
    const globals = {
      page,
      handoffTracker: { count: 0 },
      modules: { path: { resolve: (...parts: string[]) => parts.join("/") }, buffer: {} },
    } as never

    await expect(runUserCode({ code: 'return path.resolve("tmp", "shot.png")', globals }))
      .resolves.toMatchObject({ result: "tmp/shot.png" })
    await expect(runUserCode({ code: 'const path = "local"; const buffer = "value"; return { path, buffer }', globals }))
      .resolves.toMatchObject({ result: { path: "local", buffer: "value" } })
  })

  it("classifies syntax errors as user-code failures and removes page listeners", async () => {
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => "https://example.com"),
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => ({})),
    }

    await expect(runUserCode({ code: "const = ]", globals: { page, handoffTracker: { count: 0 } } as never })).rejects.toMatchObject({
      name: "SyntaxError",
      aftermath: {
        startUrl: "https://example.com",
        endUrl: "https://example.com",
      },
    })
    expect(page.off).toHaveBeenCalledTimes(3)
  })
})

describe("fillInputs", () => {
  it("resolves locators before the single batched page evaluation", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const handle = { dispose } as unknown as Awaited<ReturnType<Locator["elementHandle"]>>
    const locator = {
      _frame: { _platform: { boxedStackPrefixes: new Map([["secret", "internal"]]) } },
      elementHandles: vi.fn().mockResolvedValue([handle]),
    } as unknown as Locator
    const evaluate = vi.fn(async (_fn, argument: unknown) => {
      const fields = argument as Array<{ readonly target: unknown; readonly label: string; readonly value: string }>
      expect(fields).toEqual([
        { target: handle, label: "locator", value: "first" },
        { target: "#second", label: "selector: #second", value: "second" },
      ])
      expect(fields[0]?.target).not.toBe(locator)
      return ["locator", "selector: #second"]
    })
    const page = { evaluate } as unknown as Page

    await fillInputs(page, [
      { selector: locator, value: "first" },
      { selector: "#second", value: "second" },
    ])

    expect(locator.elementHandles).toHaveBeenCalledOnce()
    expect(evaluate).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("rejects an ambiguous locator without serializing it or exposing values", async () => {
    const handles = [
      { dispose: vi.fn().mockResolvedValue(undefined) },
      { dispose: vi.fn().mockResolvedValue(undefined) },
    ]
    const locator = { elementHandles: vi.fn().mockResolvedValue(handles) } as unknown as Locator
    const page = { evaluate: vi.fn() } as unknown as Page

    await expect(fillInputs(page, [{ selector: locator, value: "private-value" }]))
      .rejects.toThrow("fillInputs expects exactly one match for locator; got 2")
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(handles.every((handle) => handle.dispose.mock.calls.length === 1)).toBe(true)
  })

  it("disposes earlier handles when a later locator fails to resolve", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const first = { elementHandles: vi.fn().mockResolvedValue([{ dispose }]) } as unknown as Locator
    const second = { elementHandles: vi.fn().mockRejectedValue(new Error("target detached")) } as unknown as Locator
    const page = { evaluate: vi.fn() } as unknown as Page

    await expect(fillInputs(page, [
      { selector: first, value: "first" },
      { selector: second, value: "private-value" },
    ])).rejects.toThrow("target detached")
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
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

  it("diffs against the previous full snapshot and exposes only current changed refs", async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          { depth: 0, role: "heading", name: "Settings", details: "level=1" },
          { depth: 1, role: "button", name: "Save", identityName: "Save", selector: "#save" },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        entries: [
          { depth: 0, role: "heading", name: "Settings", details: "level=1" },
          { depth: 1, role: "button", name: "Save", identityName: "Save", selector: "#save", details: "disabled" },
          { depth: 1, role: "status", name: "Saved" },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        entries: [
          { depth: 0, role: "heading", name: "Settings", details: "level=1" },
          { depth: 1, role: "button", name: "Save", identityName: "Save", selector: "#save", details: "disabled" },
          { depth: 1, role: "status", name: "Saved" },
        ],
        truncated: false,
      })
    const resolvedLocator = {} as Locator
    const saveLocator = { and: vi.fn(() => resolvedLocator) } as unknown as Locator
    const page = {
      evaluate,
      locator: vi.fn(() => saveLocator),
      getByRole: vi.fn(() => ({} as Locator)),
      url: vi.fn(() => "https://example.com/settings"),
      mainFrame: vi.fn(() => ({})),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page
    const helpers = createSnapshotHelpers(page, { selectors: new Map() })

    await helpers.snapshot()
    await expect(helpers.snapshot({ diff: true })).resolves.toBe([
      '-   button "Save"',
      '+   button "Save" [ref=e2 disabled]',
      '+   status "Saved"',
      '2 additions, 1 removal, 1 unchanged',
    ].join("\n"))
    expect(() => helpers.ref("e1")).toThrow("Unknown snapshot ref")
    expect(helpers.ref("e2")).toBe(resolvedLocator)

    await expect(helpers.snapshot({ diff: true })).resolves.toBe("0 additions, 0 removals, 3 unchanged")
    expect(() => helpers.ref("e2")).toThrow("Unknown snapshot ref")
  })

  it("requires a compatible full snapshot before diffing", async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
      locator: vi.fn(),
      url: vi.fn(() => "https://example.com/settings"),
      mainFrame: vi.fn(() => ({})),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page
    const helpers = createSnapshotHelpers(page, { selectors: new Map() })

    await expect(helpers.snapshot({ diff: true })).rejects.toThrow("requires a previous snapshot() baseline")
    await helpers.snapshot({ interactive: true })
    await expect(helpers.snapshot({ diff: true })).rejects.toThrow("must use the same page and snapshot options")
  })

  it("does not compare snapshots from different arbitrary locator scopes", async () => {
    const locatorA = { evaluate: vi.fn().mockResolvedValue({ entries: [], truncated: false }) } as unknown as Locator
    const locatorB = { evaluate: vi.fn().mockResolvedValue({ entries: [], truncated: false }) } as unknown as Locator
    const page = {
      evaluate: vi.fn(),
      locator: vi.fn(),
      url: vi.fn(() => "https://example.com/settings"),
      mainFrame: vi.fn(() => ({})),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page
    const helpers = createSnapshotHelpers(page, { selectors: new Map() })

    await helpers.snapshot({ within: locatorA })
    await expect(helpers.snapshot({ within: locatorA, diff: true })).resolves.toBe("0 additions, 0 removals, 0 unchanged")
    await expect(helpers.snapshot({ within: locatorB, diff: true })).rejects.toThrow("must use the same page and snapshot options")
    expect(locatorB.evaluate).not.toHaveBeenCalled()
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
