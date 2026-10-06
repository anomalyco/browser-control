import { describe, expect, it, vi } from "vitest"
import {
  finalizeBrowserControlGrouping,
  formatTabGroupTitle,
  isBrowserControlGroupTitle,
  tabGroupTitle,
} from "../extension/src/tab-groups.ts"

describe("isBrowserControlGroupTitle", () => {
  it("matches the current session-named and legacy Browser Control group titles", () => {
    expect(tabGroupTitle.replace("\u2063", "")).toBe("control")
    expect(isBrowserControlGroupTitle(tabGroupTitle)).toBe(true)
    expect(isBrowserControlGroupTitle(formatTabGroupTitle("🎙️ elevenlabs"))).toBe(true)
    expect(formatTabGroupTitle("🎙️ elevenlabs").replace("\u2063", "")).toBe("🎙️ elevenlabs")
    expect(formatTabGroupTitle("cosmic-otter-866").replace("\u2063", "")).toBe("cosmic-otter-866")
    expect(isBrowserControlGroupTitle("control")).toBe(false)
    expect(isBrowserControlGroupTitle("browser-control")).toBe(true)
    expect(isBrowserControlGroupTitle("bc:cosmic-otter-866")).toBe(true)
    expect(isBrowserControlGroupTitle("bc · cos-ott-866")).toBe(true)
  })

  it("does not match unrelated groups", () => {
    expect(isBrowserControlGroupTitle(undefined)).toBe(false)
    expect(isBrowserControlGroupTitle("Control")).toBe(false)
    expect(isBrowserControlGroupTitle("abc:cosmic-otter-866")).toBe(false)
    expect(isBrowserControlGroupTitle("reading-list")).toBe(false)
  })
})

describe("finalizeBrowserControlGrouping", () => {
  it("updates a group while the originating connection is current", async () => {
    const update = vi.fn(async () => {})
    const rollback = vi.fn(async () => {})

    await finalizeBrowserControlGrouping({ assertCurrent: () => {}, update, rollback })

    expect(update).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
  })

  it("rolls back a group created by a replaced connection", async () => {
    const replacement = new Error("connection replaced")
    const update = vi.fn(async () => {})
    const rollback = vi.fn(async () => {})

    await expect(finalizeBrowserControlGrouping({
      assertCurrent: () => { throw replacement },
      update,
      rollback,
    })).rejects.toBe(replacement)

    expect(rollback).toHaveBeenCalledOnce()
    expect(update).not.toHaveBeenCalled()
  })
})
