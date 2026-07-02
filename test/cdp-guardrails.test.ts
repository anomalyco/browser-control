import { describe, expect, it } from "vitest"
import { alwaysBlockedCdpMethods, guardCdpMethod } from "../src/cdp-guardrails.ts"

describe("cdp-guardrails", () => {
  it("always blocks browser-state-destroying methods", () => {
    for (const method of ["Network.clearBrowserCookies", "Network.clearBrowserCache", "Storage.clearCookies", "Browser.close"]) {
      expect(alwaysBlockedCdpMethods.has(method)).toBe(true)
      const message = guardCdpMethod({ method, readOnly: false })
      expect(message).toContain(`Browser Control blocked ${method}`)
      expect(message).toContain("always blocked")
    }
  })

  it("allows ordinary methods", () => {
    for (const method of ["Page.navigate", "Runtime.evaluate", "Target.createTarget", "Network.enable", "Input.dispatchMouseEvent"]) {
      expect(guardCdpMethod({ method, readOnly: false })).toBeNull()
    }
  })

  it("blocks input dispatch for read-only sessions with the session id in the message", () => {
    const message = guardCdpMethod({ method: "Input.dispatchMouseEvent", readOnly: true, sessionId: "quiet-owl-1" })
    expect(message).toContain("Session quiet-owl-1 is read-only")
    expect(message).toContain("Input.dispatchMouseEvent")
  })

  it("blocks all Input.* methods in read-only mode but allows reads", () => {
    expect(guardCdpMethod({ method: "Input.dispatchKeyEvent", readOnly: true })).not.toBeNull()
    expect(guardCdpMethod({ method: "Input.insertText", readOnly: true })).not.toBeNull()
    expect(guardCdpMethod({ method: "Runtime.evaluate", readOnly: true })).toBeNull()
    expect(guardCdpMethod({ method: "Page.captureScreenshot", readOnly: true })).toBeNull()
  })
})
