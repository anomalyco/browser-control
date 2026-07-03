import { describe, expect, it } from "vitest"
import { isBrowserControlGroupTitle, shouldUngroupBrowserControlTab } from "../extension/src/tab-groups.ts"

describe("isBrowserControlGroupTitle", () => {
  it("matches the shared and session-scoped Browser Control group titles", () => {
    expect(isBrowserControlGroupTitle("browser-control")).toBe(true)
    expect(isBrowserControlGroupTitle("bc:cosmic-otter-866")).toBe(true)
  })

  it("does not match unrelated groups", () => {
    expect(isBrowserControlGroupTitle(undefined)).toBe(false)
    expect(isBrowserControlGroupTitle("Browser Control")).toBe(false)
    expect(isBrowserControlGroupTitle("abc:cosmic-otter-866")).toBe(false)
  })
})

describe("shouldUngroupBrowserControlTab", () => {
  it("ungroups detached tabs in Browser Control groups", () => {
    expect(shouldUngroupBrowserControlTab({ groupTitle: "browser-control", isDebuggerAttached: false })).toBe(true)
    expect(shouldUngroupBrowserControlTab({ groupTitle: "bc:cosmic-otter-866", isDebuggerAttached: false })).toBe(true)
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
