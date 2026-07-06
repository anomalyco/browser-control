import { describe, expect, it } from "vitest"
import { isBrowserControlGroupTitle, isCurrentBrowserControlGroupTitle, isLegacyBrowserControlGroupTitle, shouldUngroupBrowserControlTab, tabGroupTitle, tabGroupVisibleTitle } from "../extension/src/tab-groups.ts"

describe("isBrowserControlGroupTitle", () => {
  it("matches the current and legacy Browser Control group titles", () => {
    expect(tabGroupVisibleTitle).toBe("control")
    expect(tabGroupTitle.replace("\u2063", "")).toBe("control")
    expect(isBrowserControlGroupTitle(tabGroupTitle)).toBe(true)
    expect(isBrowserControlGroupTitle("control")).toBe(false)
    expect(isBrowserControlGroupTitle("browser-control")).toBe(true)
    expect(isBrowserControlGroupTitle("bc:cosmic-otter-866")).toBe(true)
    expect(isBrowserControlGroupTitle("bc · cos-ott-866")).toBe(true)
    expect(isCurrentBrowserControlGroupTitle(tabGroupTitle)).toBe(true)
    expect(isCurrentBrowserControlGroupTitle("control")).toBe(false)
    expect(isCurrentBrowserControlGroupTitle("browser-control")).toBe(false)
    expect(isLegacyBrowserControlGroupTitle(tabGroupTitle)).toBe(false)
    expect(isLegacyBrowserControlGroupTitle("browser-control")).toBe(true)
  })

  it("does not match unrelated groups", () => {
    expect(isBrowserControlGroupTitle(undefined)).toBe(false)
    expect(isBrowserControlGroupTitle("Control")).toBe(false)
    expect(isBrowserControlGroupTitle("abc:cosmic-otter-866")).toBe(false)
  })

})

describe("shouldUngroupBrowserControlTab", () => {
  it("ungroups detached tabs in Browser Control groups", () => {
    expect(shouldUngroupBrowserControlTab("browser-control")).toBe(true)
    expect(shouldUngroupBrowserControlTab(tabGroupTitle)).toBe(true)
    expect(shouldUngroupBrowserControlTab("bc:cosmic-otter-866")).toBe(true)
    expect(shouldUngroupBrowserControlTab("bc · cos-ott-866")).toBe(true)
  })

  it("ungroups still-attached tabs from legacy Browser Control groups", () => {
    expect(shouldUngroupBrowserControlTab("browser-control")).toBe(true)
    expect(shouldUngroupBrowserControlTab("bc:cosmic-otter-866")).toBe(true)
  })

  it("ignores non-Browser Control groups even when detached", () => {
    expect(shouldUngroupBrowserControlTab("reading-list")).toBe(false)
    expect(shouldUngroupBrowserControlTab("control")).toBe(false)
    expect(shouldUngroupBrowserControlTab(undefined)).toBe(false)
  })
})
