import { describe, expect, it } from "vitest"
import { ProtectedFrameTracker } from "../src/protected-frames.ts"
import type { JsonObject } from "../src/protocol.ts"

const menuUrl = "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/menu/menu.html"

function tracker(childFrames: readonly string[] = ["menu"]) {
  const frames = new ProtectedFrameTracker()
  const observe = (method: string, params: JsonObject, mainFrameId: string | undefined = "main") =>
    frames.observe({ tabId: 1, method, params, mainFrameId, isChildFrame: (frameId) => childFrames.includes(frameId) })
  return { frames, observe }
}

describe("ProtectedFrameTracker", () => {
  it("retracts a child frame once its navigation targets a restricted URL and hides it afterwards", () => {
    const { frames, observe } = tracker()
    expect(observe("Page.frameAttached", { frameId: "menu", parentFrameId: "main" })).toEqual({ kind: "forward" })
    expect(observe("Page.frameStartedNavigating", { frameId: "menu", url: menuUrl })).toEqual({ kind: "retract", frameId: "menu" })
    expect(observe("Page.frameRequestedNavigation", { frameId: "menu", url: menuUrl })).toEqual({ kind: "suppress" })
    expect(observe("Page.lifecycleEvent", { frameId: "menu", name: "load" })).toEqual({ kind: "suppress" })
    expect(observe("Page.frameNavigated", { frame: { id: "menu", parentId: "main", url: menuUrl } })).toEqual({ kind: "suppress" })
    expect(frames.hasAny(1)).toBe(true)
    expect(observe("Page.frameDetached", { frameId: "menu", reason: "remove" })).toEqual({ kind: "suppress" })
    expect(frames.hasAny(1)).toBe(false)
    expect(observe("Page.frameDetached", { frameId: "menu", reason: "remove" })).toEqual({ kind: "forward" })
  })

  it("marks a same-process child frame from its committed restricted navigation", () => {
    const { observe } = tracker([])
    expect(observe("Page.frameNavigated", { frame: { id: "help", parentId: "main", url: "chrome://settings/help" } })).toEqual({ kind: "retract", frameId: "help" })
  })

  it("never protects the main frame, even when its id is not known yet", () => {
    const { observe } = tracker([])
    expect(observe("Page.frameStartedNavigating", { frameId: "main", url: "chrome://newtab/" })).toEqual({ kind: "forward" })
    expect(observe("Page.frameStartedNavigating", { frameId: "unknown", url: "chrome://newtab/" }, undefined)).toEqual({ kind: "forward" })
    expect(observe("Page.frameNavigated", { frame: { id: "unknown", url: "chrome://newtab/" } }, undefined)).toEqual({ kind: "forward" })
  })

  it("restores a protected frame that navigates back to an ordinary document", () => {
    const { frames, observe } = tracker()
    expect(observe("Page.frameStartedNavigating", { frameId: "menu", url: menuUrl })).toEqual({ kind: "retract", frameId: "menu" })
    expect(observe("Page.frameNavigated", { frame: { id: "menu", parentId: "main", url: "https://example.com/widget" } })).toEqual({ kind: "restore", frameId: "menu", parentFrameId: "main" })
    expect(frames.has(1, "menu")).toBe(false)
  })

  it("leaves ordinary frames, non-Page events, and other tabs alone", () => {
    const { frames, observe } = tracker(["pay"])
    expect(observe("Page.frameStartedNavigating", { frameId: "pay", url: "https://pay.example.net/frame" })).toEqual({ kind: "forward" })
    expect(observe("Network.requestWillBeSent", { frameId: "pay", request: { url: menuUrl } })).toEqual({ kind: "forward" })
    expect(observe("Page.frameStartedLoading", {})).toEqual({ kind: "forward" })
    frames.mark(2, "menu")
    expect(frames.has(1, "menu")).toBe(false)
    frames.forgetTab(2)
    expect(frames.hasAny(2)).toBe(false)
  })
})
