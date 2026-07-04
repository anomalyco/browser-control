import { describe, expect, it, vi } from "vitest"

vi.mock("@effect/platform-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/platform-node")>()
  return {
    ...actual,
    NodeRuntime: {
      ...actual.NodeRuntime,
      runMain: vi.fn(),
    },
  }
})

import { executeJsonEnvelope, formatRecreatedSessionNotice, shouldPrintRecreatedSessionNotice } from "../src/cli.ts"
import type { ExecuteResponse } from "../src/relay-schema.ts"

const session: ExecuteResponse["session"] = {
  id: "schedules-check",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:01.000Z",
  connected: true,
  pageUrl: null,
  stateKeys: [],
}

function executeResponse(overrides: Partial<ExecuteResponse>): ExecuteResponse {
  return {
    text: "undefined",
    isError: false,
    logs: [],
    session,
    ...overrides,
  }
}

describe("executeJsonEnvelope", () => {
  it("uses the structured wire value when present", () => {
    const envelope = executeJsonEnvelope(executeResponse({ text: "{ a: 1 }", value: { a: 1 } }))

    expect(envelope).toMatchObject({
      ok: true,
      isError: false,
      text: "{ a: 1 }",
      value: { a: 1 },
      valueUnavailable: false,
    })
  })

  it("marks value unavailable when the wire value is absent", () => {
    const envelope = executeJsonEnvelope(executeResponse({ text: "Symbol(browser)" }))

    expect(envelope.value).toBeNull()
    expect(envelope.valueUnavailable).toBe(true)
  })

  it("distinguishes a structured null result from an unavailable value", () => {
    const envelope = executeJsonEnvelope(executeResponse({ text: "null", value: null }))

    expect(envelope.value).toBeNull()
    expect(envelope.valueUnavailable).toBe(false)
  })

  it("preserves a bounded execution-context diagnostic", () => {
    const envelope = executeJsonEnvelope(executeResponse({
      isError: true,
      diagnostic: "execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
    }))

    expect(envelope.diagnostic).toContain("context-destroyed")
  })
})

describe("recreated session notice", () => {
  it("prints for a stored current session recreated by execute", () => {
    expect(shouldPrintRecreatedSessionNotice({
      explicitSessionId: undefined,
      sessionExistedInStoreBeforeCommand: true,
      result: executeResponse({ session: { ...session, created: true } }),
    })).toBe(true)
  })

  it("does not print for a freshly minted default session", () => {
    expect(shouldPrintRecreatedSessionNotice({
      explicitSessionId: undefined,
      sessionExistedInStoreBeforeCommand: false,
      result: executeResponse({ session: { ...session, created: true } }),
    })).toBe(false)
  })

  it("does not print for an explicit session", () => {
    expect(shouldPrintRecreatedSessionNotice({
      explicitSessionId: "schedules-check",
      sessionExistedInStoreBeforeCommand: true,
      result: executeResponse({ session: { ...session, created: true } }),
    })).toBe(false)
  })

  it("formats the one-line stderr notice", () => {
    expect(formatRecreatedSessionNotice("schedules-check")).toBe(
      "Recreated session 'schedules-check' — relay had no such session; page and state were reset.",
    )
  })
})
