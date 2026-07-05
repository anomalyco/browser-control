import { describe, expect, it } from "vitest"
import { pageStatusFromJson, pageStatusView } from "../extension/src/page-status.ts"
import { makePageStatus } from "../src/page-status.ts"

describe("pageStatusView", () => {
  it("keeps USER ownership plus adopted read-only session context", () => {
    const status = makePageStatus({
      state: "attached",
      targetOwner: "user",
      sessionId: "inspect",
      readOnly: true,
    })

    expect(status).toEqual({ state: "attached", owner: "user", sessionId: "inspect", readOnly: true })
    expect(pageStatusView(status).label).toBe("BC · RO")
  })

  it("describes an attached user-owned tab", () => {
    expect(pageStatusView({ state: "attached", owner: "user" })).toEqual({
      label: "BC",
      title: "Browser Control is attached. User-owned tab",
      tone: "active",
    })
  })

  it("includes session and read-only context while running", () => {
    expect(pageStatusView({ state: "running", owner: "session", sessionId: "cosmic-otter-866", readOnly: true })).toEqual({
      label: "BC · RO",
      title: "Browser Control is running a script. Session-owned tab. Session: cosmic-otter-866. Read-only",
      tone: "active",
    })
  })

  it("includes the handoff prompt in waiting-state accessibility text", () => {
    expect(pageStatusView({ state: "waiting", owner: "user", sessionId: "inspect", message: "Complete 2FA", handoffId: "handoff-1" })).toEqual({
      label: "BC · WAIT",
      title: "Browser Control is waiting for you. User-owned tab. Session: inspect. Complete 2FA",
      tone: "waiting",
      message: "Complete 2FA",
      completion: {
        handoffId: "handoff-1",
        label: "Continue",
      },
    })
  })

  it("does not expose a completion control outside the waiting state", () => {
    expect(pageStatusView({ state: "running", owner: "session", sessionId: "inspect" }).completion).toBeUndefined()
  })

  it("keeps read-only handoffs prominent", () => {
    expect(pageStatusView({ state: "waiting", owner: "session", sessionId: "inspect", readOnly: true, message: "Continue", handoffId: "handoff-1" })).toMatchObject({
      label: "BC · WAIT",
      tone: "waiting",
    })
  })
})

describe("pageStatusFromJson", () => {
  it("rejects invalid relay state", () => {
    expect(pageStatusFromJson({ state: "idle", owner: "user" })).toBeUndefined()
    expect(pageStatusFromJson({ state: "attached", owner: "unknown" })).toBeUndefined()
  })

  it("keeps only supported optional fields", () => {
    expect(pageStatusFromJson({
      state: "waiting",
      owner: "session",
      sessionId: "inspect",
      readOnly: true,
      message: "Continue",
      handoffId: "handoff-1",
      ignored: 123,
    })).toEqual({
      state: "waiting",
      owner: "session",
      sessionId: "inspect",
      readOnly: true,
      message: "Continue",
      handoffId: "handoff-1",
    })
  })

  it("rejects a waiting status without a completion id and message", () => {
    expect(pageStatusFromJson({ state: "waiting", owner: "user", message: "Continue" })).toBeUndefined()
    expect(pageStatusFromJson({ state: "waiting", owner: "user", handoffId: "handoff-1" })).toBeUndefined()
  })
})
