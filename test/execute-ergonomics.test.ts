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
  it("updates values without changing document focus", async () => {
    class MockInput {
      private currentValue = ""
      readonly focus = vi.fn()
      readonly blur = vi.fn()
      readonly dispatchEvent = vi.fn()

      get value() {
        return this.currentValue
      }

      set value(value: string) {
        this.currentValue = value
      }
    }

    const input = new MockInput()
    const evaluate = vi.fn(async (run: (fields: Array<{ readonly target: string; readonly label: string; readonly value: string }>) => unknown, fields) => {
      const previousDocument = globalThis.document
      const previousInput = globalThis.HTMLInputElement
      const previousTextArea = globalThis.HTMLTextAreaElement
      const previousInputEvent = globalThis.InputEvent
      Object.assign(globalThis, {
        document: {
          querySelectorAll: vi.fn((selector: string) => selector === "#field" ? [input] : []),
        },
        HTMLInputElement: MockInput,
        HTMLTextAreaElement: class {},
        InputEvent: class {},
      })
      try {
        return run(fields as Array<{ readonly target: string; readonly label: string; readonly value: string }>)
      } finally {
        Object.assign(globalThis, {
          document: previousDocument,
          HTMLInputElement: previousInput,
          HTMLTextAreaElement: previousTextArea,
          InputEvent: previousInputEvent,
        })
      }
    })
    const page = { evaluate } as unknown as Page

    await fillInputs(page, [{ selector: "#field", value: "next" }])

    expect(input.value).toBe("next")
    expect(input.focus).not.toHaveBeenCalled()
    expect(input.blur).not.toHaveBeenCalled()
    expect(input.dispatchEvent).toHaveBeenCalledTimes(2)
  })

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
    expect(evaluate.mock.calls[0]?.[0].toString()).toContain("candidate.shadowRoot")
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("explains the open and closed shadow-root boundary without exposing the value", async () => {
    const evaluate = vi.fn(async (run: (fields: Array<{ readonly target: string; readonly label: string; readonly value: string }>) => unknown, fields) => {
      const previousDocument = globalThis.document
      const root = {
        querySelectorAll: vi.fn((selector: string) => selector === "*" ? [] : []),
      }
      Object.assign(globalThis, { document: root })
      try {
        return run(fields as Array<{ readonly target: string; readonly label: string; readonly value: string }>)
      } finally {
        Object.assign(globalThis, { document: previousDocument })
      }
    })
    const page = { evaluate } as unknown as Page

    const outcome = fillInputs(page, [{ selector: "secure-field", value: "private-value" }])
    await expect(outcome).rejects.toThrow(
      "fillInputs found no match for selector: secure-field in the document or open shadow roots; closed shadow roots are unavailable. Try locator.fill() if Playwright can resolve the field.",
    )
    await expect(outcome).rejects.not.toThrow("private-value")
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

function ariaSnapshotFixture(options: {
  readonly snapshot?: string
  readonly captureError?: Error
  readonly cleanupError?: Error
} = {}) {
  const ariaSnapshot = options.captureError
    ? vi.fn().mockRejectedValue(options.captureError)
    : vi.fn().mockResolvedValue(options.snapshot ?? "- main")
  const waitFor = options.cleanupError
    ? vi.fn().mockRejectedValue(options.cleanupError)
    : vi.fn().mockResolvedValue(undefined)
  const frame = { locator: vi.fn(() => ({ waitFor })) }
  const ownerPage = { frames: () => [frame] }
  const locator = {
    locator: vi.fn(() => ({ ariaSnapshot })),
    page: vi.fn(() => ownerPage),
  } as unknown as Locator
  const page = { locator: vi.fn(() => locator) } as unknown as Pick<Page, "locator">
  return { ariaSnapshot, frame, locator, page, waitFor }
}

describe("ariaSnapshot helper", () => {
  it("uses a bounded default timeout for the default body target", async () => {
    const fixture = ariaSnapshotFixture({ snapshot: '- textbox "Password"' })

    await expect(createAriaSnapshotHelper(fixture.page)()).resolves.toBe('- textbox "Password"')
    expect(fixture.page.locator).toHaveBeenCalledWith("body")
    expect(fixture.ariaSnapshot).toHaveBeenCalledWith({ timeout: defaultAriaSnapshotTimeoutMs })
    const activation = vi.mocked(fixture.locator.locator).mock.calls[0]?.[0]
    expect(activation).toMatch(/^bcariaredact=on_\d+$/)
    if (typeof activation !== "string") throw new Error("Expected redaction selector activation")
    expect(fixture.frame.locator).toHaveBeenCalledWith(activation.replace("=on_", "=off_"))
    expect(fixture.waitFor).toHaveBeenCalledWith({ state: "attached", timeout: 1_000 })
  })

  it("preserves selector and locator targets and accepts a short timeout", async () => {
    const selector = ariaSnapshotFixture({ snapshot: '- main "Selector"' })
    const helper = createAriaSnapshotHelper(selector.page)

    await expect(helper("main", { timeout: 250 })).resolves.toBe('- main "Selector"')
    expect(selector.page.locator).toHaveBeenCalledWith("main")
    expect(selector.ariaSnapshot).toHaveBeenCalledWith({ timeout: 250 })

    const direct = ariaSnapshotFixture({ snapshot: '- button "Locator"' })
    await expect(helper(direct.locator, { timeout: 400 })).resolves.toBe('- button "Locator"')
    expect(direct.ariaSnapshot).toHaveBeenCalledWith({ timeout: 400 })
    expect(selector.page.locator).toHaveBeenCalledTimes(1)
  })

  it("restores isolated-world value access when snapshot capture fails", async () => {
    const captureError = new Error("target detached")
    const fixture = ariaSnapshotFixture({ captureError })

    await expect(createAriaSnapshotHelper(fixture.page)()).rejects.toThrow(captureError)
    expect(fixture.waitFor).toHaveBeenCalledOnce()
  })

  it("does not return a snapshot when isolated-world cleanup cannot be confirmed", async () => {
    const fixture = ariaSnapshotFixture({
      snapshot: '- textbox "Password"',
      cleanupError: new Error("frame wedged"),
    })

    await expect(createAriaSnapshotHelper(fixture.page)()).rejects.toThrow(
      "Browser Control could not confirm ARIA snapshot value-redaction cleanup",
    )
  })

  it("retries stale cleanup tokens before returning a later snapshot", async () => {
    const fixture = ariaSnapshotFixture({ snapshot: '- textbox "Password"' })
    fixture.waitFor.mockRejectedValueOnce(new Error("frame wedged"))
    const helper = createAriaSnapshotHelper(fixture.page)

    await expect(helper()).rejects.toThrow("Browser Control could not confirm ARIA snapshot value-redaction cleanup")
    await expect(helper()).resolves.toBe('- textbox "Password"')
    expect(fixture.waitFor).toHaveBeenCalledTimes(3)
  })

  it("preserves capture and cleanup failures", async () => {
    const captureError = new Error("target detached")
    const cleanupError = new Error("frame wedged")
    const fixture = ariaSnapshotFixture({ captureError, cleanupError })

    const error = await createAriaSnapshotHelper(fixture.page)().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toMatchObject({
      message: "Browser Control could not confirm ARIA snapshot value-redaction cleanup",
      errors: expect.arrayContaining([captureError, cleanupError]),
    })
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
    expect(evaluate.mock.calls[0]?.[0].toString()).toContain("const __name = (target) => target")
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ maxItems: 80, rootSelector: undefined })
    expect(helpers.ref("@e1")).toBe(resolvedLocator)
    expect(page.locator).toHaveBeenLastCalledWith("#save")
    expect(page.getByRole).toHaveBeenCalledWith("button")
    expect(saveLocator.and).toHaveBeenCalledWith(saveRoleLocator)
  })

  it("does not use the approximate snapshot name to constrain a stable selector", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      entries: [{
        depth: 0,
        role: "textbox",
        name: "Organization or user *",
        identityName: "Organization or user *",
        selector: "#oidc-repositoryOwner",
      }],
      truncated: false,
    })
    const resolvedLocator = {} as Locator
    const selectorLocator = { and: vi.fn(() => resolvedLocator) } as unknown as Locator
    const roleLocator = {} as Locator
    const page = {
      evaluate,
      locator: vi.fn(() => selectorLocator),
      getByRole: vi.fn(() => roleLocator),
      url: vi.fn(() => "https://www.npmjs.com/package/example/access"),
      mainFrame: vi.fn(() => ({})),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Page
    const helpers = createSnapshotHelpers(page, { selectors: new Map() })

    await helpers.snapshot()
    expect(helpers.ref("e1")).toBe(resolvedLocator)
    expect(page.getByRole).toHaveBeenCalledWith("textbox")
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
