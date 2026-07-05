import { describe, expect, it } from "vitest"
import { compactBrowserControlGroupTitle, isBrowserControlGroupTitle, shouldUngroupBrowserControlTab } from "../extension/src/tab-groups.ts"

describe("isBrowserControlGroupTitle", () => {
  it("matches the shared and session-scoped Browser Control group titles", () => {
    expect(isBrowserControlGroupTitle("browser-control")).toBe(true)
    expect(isBrowserControlGroupTitle("bc:cosmic-otter-866")).toBe(true)
    expect(isBrowserControlGroupTitle("bc · cos-ott-866")).toBe(true)
  })

  it("does not match unrelated groups", () => {
    expect(isBrowserControlGroupTitle(undefined)).toBe(false)
    expect(isBrowserControlGroupTitle("Browser Control")).toBe(false)
    expect(isBrowserControlGroupTitle("abc:cosmic-otter-866")).toBe(false)
  })

  it("compacts generated and purpose-suffixed session labels", () => {
    expect(compactBrowserControlGroupTitle("bc:cosmic-otter-866")).toBe("bc · cos-ott-866")
    expect(compactBrowserControlGroupTitle("bc:race-browser-control")).toBe("bc · race")
    expect(compactBrowserControlGroupTitle("bc:convex-inspect")).toBe("bc · convex")
    expect(compactBrowserControlGroupTitle("browser-control")).toBe("browser-control")
  })

  it("bounds long custom labels while retaining both ends", () => {
    const title = compactBrowserControlGroupTitle("bc:product-research-checkout")
    expect(title).toBe("bc · product…kout")
    expect(title.length).toBeLessThanOrEqual(17)
    expect(isBrowserControlGroupTitle(title)).toBe(true)
  })
})

describe("shouldUngroupBrowserControlTab", () => {
  it("ungroups detached tabs in Browser Control groups", () => {
    expect(shouldUngroupBrowserControlTab({ groupTitle: "browser-control", isDebuggerAttached: false })).toBe(true)
    expect(shouldUngroupBrowserControlTab({ groupTitle: "bc:cosmic-otter-866", isDebuggerAttached: false })).toBe(true)
    expect(shouldUngroupBrowserControlTab({ groupTitle: "bc · cos-ott-866", isDebuggerAttached: false })).toBe(true)
  })

  it("keeps still-attached Browser Control tabs grouped", () => {
    expect(shouldUngroupBrowserControlTab({ groupTitle: "browser-control", isDebuggerAttached: true })).toBe(false)
    expect(shouldUngroupBrowserControlTab({ groupTitle: "bc:cosmic-otter-866", isDebuggerAttached: true })).toBe(false)
  })

  it("ignores non-Browser Control groups even when detached", () => {
    expect(shouldUngroupBrowserControlTab({ groupTitle: "reading-list", isDebuggerAttached: false })).toBe(false)
    expect(shouldUngroupBrowserControlTab({ groupTitle: undefined, isDebuggerAttached: false })).toBe(false)
  })
})
