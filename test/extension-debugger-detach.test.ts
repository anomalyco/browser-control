import { describe, expect, it } from "vitest"
import { debuggerDetachedEvent } from "../extension/src/debugger-detach.ts"

describe("debuggerDetachedEvent", () => {
  it("reports root detach evidence without deciding to clear handoff presentation", () => {
    expect(debuggerDetachedEvent({ tabId: 7, reason: "target_closed" })).toEqual({
      method: "debugger.detached",
      params: { tabId: 7, reason: "target_closed" },
    })
  })

  it("preserves child session identity for relay classification", () => {
    expect(debuggerDetachedEvent({ tabId: 7, reason: "target_closed", sessionId: "child-1" })).toEqual({
      method: "debugger.detached",
      params: { tabId: 7, reason: "target_closed", sessionId: "child-1" },
    })
  })
})
