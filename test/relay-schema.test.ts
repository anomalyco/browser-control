import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  ExecuteRequest,
  ExecuteResponse,
  ExecuteSessionSummary,
  ErrorEnvelope,
  ExtensionStatus,
  NetworkStartRequest,
  NetworkStopResponse,
  RecordingStartRequest,
  RecordingStartResponse,
  RecordingStatusResponse,
  RelayVersion,
  SessionAdoptRequest,
  SessionAdoptResponse,
  SessionContainer,
  SessionNewRequest,
  SessionsContainer,
  SessionSummary,
  TargetSummaries,
} from "../src/relay-schema.ts"

const decodeSession = Schema.decodeUnknownSync(SessionSummary)
const decodeSessions = Schema.decodeUnknownSync(SessionsContainer)
const decodeSessionContainer = Schema.decodeUnknownSync(SessionContainer)
const decodeAdoptRequest = Schema.decodeUnknownSync(SessionAdoptRequest)
const decodeAdoptResponse = Schema.decodeUnknownSync(SessionAdoptResponse)
const encodeAdoptResponse = Schema.encodeUnknownSync(SessionAdoptResponse)
const decodeExecuteRequest = Schema.decodeUnknownSync(ExecuteRequest)
const decodeExecute = Schema.decodeUnknownSync(ExecuteResponse)
const encodeExecute = Schema.encodeUnknownSync(ExecuteResponse)
const decodeExecuteSession = Schema.decodeUnknownSync(ExecuteSessionSummary)
const decodeExtensionStatus = Schema.decodeUnknownSync(ExtensionStatus)
const decodeTargets = Schema.decodeUnknownSync(TargetSummaries)
const decodeRecordingStart = Schema.decodeUnknownSync(RecordingStartResponse)
const decodeRecordingStartRequest = Schema.decodeUnknownSync(RecordingStartRequest)
const decodeSessionNewRequest = Schema.decodeUnknownSync(SessionNewRequest)
const decodeRecordingStatus = Schema.decodeUnknownSync(RecordingStatusResponse)
const decodeRelayVersion = Schema.decodeUnknownSync(RelayVersion)
const decodeErrorEnvelope = Schema.decodeUnknownSync(ErrorEnvelope)
const decodeNetworkStartRequest = Schema.decodeUnknownSync(NetworkStartRequest)
const decodeNetworkStopResponse = Schema.decodeUnknownSync(NetworkStopResponse)

const session = {
  id: "rapid-otter-633",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:01.000Z",
  connected: true,
  pageUrl: "https://example.com",
  stateKeys: ["title"],
}

describe("relay-schema", () => {
  it("decodes a session summary", () => {
    expect(decodeSession(session)).toEqual(session)
  })

  it("decodes a session with null pageUrl", () => {
    const decoded = decodeSession({ ...session, pageUrl: null, stateKeys: [] })
    expect(decoded.pageUrl).toBeNull()
    expect(decoded.stateKeys).toEqual([])
  })

  it("rejects a session with a missing id", () => {
    const { id: _id, ...rest } = session
    expect(() => decodeSession(rest)).toThrow()
  })

  it("decodes sessions and session containers", () => {
    expect(decodeSessions({ sessions: [session] }).sessions).toHaveLength(1)
    expect(decodeSessionContainer({ session }).session.id).toBe(session.id)
  })

  it("decodes adopt requests and round-trips adopt responses", () => {
    expect(decodeAdoptRequest({
      sessionId: "rapid-otter-633",
      createIfMissing: true,
      targetSelection: { urlIncludes: "example.com" },
    }).targetSelection.urlIncludes).toBe("example.com")
    expect(decodeAdoptRequest({
      createIfMissing: true,
      targetSelection: { index: 0 },
    }).sessionId).toBeUndefined()
    const response = { session: { ...session, created: true }, adoptedUrl: "https://example.com/", adoptedTargetId: "target-2" }
    expect(encodeAdoptResponse(decodeAdoptResponse(response))).toEqual(response)
  })

  it("requires exactly one valid target selector", () => {
    expect(() => decodeAdoptRequest({ createIfMissing: true, targetSelection: {} })).toThrow()
    expect(() => decodeAdoptRequest({ createIfMissing: true, targetSelection: { urlIncludes: "" } })).toThrow()
    expect(() => decodeAdoptRequest({ createIfMissing: true, targetSelection: { urlIncludes: "example.com", index: 0 } })).toThrow()
    expect(() => decodeAdoptRequest({ createIfMissing: true, targetSelection: { index: -1 } })).toThrow()
    expect(() => decodeAdoptRequest({ createIfMissing: true, targetSelection: { index: 1.5 } })).toThrow()
    expect(decodeAdoptRequest({ createIfMissing: true, targetSelection: { urlIncludes: "example.com" } }).targetSelection).toEqual({ urlIncludes: "example.com" })
    expect(decodeAdoptRequest({ createIfMissing: true, targetSelection: { index: 0 } }).targetSelection).toEqual({ index: 0 })
  })

  it("decodes execute requests with atomic or explicit session ownership", () => {
    expect(decodeExecuteRequest({ code: "page.url()", createIfMissing: true })).toEqual({
      code: "page.url()",
      createIfMissing: true,
    })
    expect(decodeExecuteRequest({
      sessionId: "rapid-otter-633",
      code: "page.url()",
      createIfMissing: false,
      targetSelection: { index: 0 },
    }).sessionId).toBe("rapid-otter-633")
    expect(() => decodeExecuteRequest({ code: "page.url()" })).toThrow()
  })

  it("decodes the optional readOnly flag on sessions", () => {
    expect(decodeSession(session).readOnly).toBeUndefined()
    expect(decodeSession({ ...session, readOnly: true }).readOnly).toBe(true)
  })

  it("decodes an execute response with warnings and aftermath", () => {
    const decoded = decodeExecute({
      text: "ok",
      isError: false,
      logs: [],
      warnings: ["The session default page was closed; created a new page."],
      diagnostic: "execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
      aftermath: {
        startUrl: "about:blank",
        endUrl: "https://example.com/",
        navigations: ["https://example.com/"],
        consoleErrorCount: 0,
        pageErrorCount: 1,
        handoffs: 2,
      },
      session,
    })
    expect(decoded.warnings).toHaveLength(1)
    expect(decoded.diagnostic).toContain("context-destroyed")
    expect(decoded.aftermath?.endUrl).toBe("https://example.com/")
    expect(decoded.aftermath?.handoffs).toBe(2)
  })

  it("decodes and encodes execute responses with optional structured value and session-created flag", () => {
    const response = {
      text: "{ a: 1 }",
      value: { a: 1, nested: [true, null] },
      isError: false,
      logs: [],
      session: { ...session, created: true },
    }
    const decoded = decodeExecute(response)
    expect(decoded.value).toEqual({ a: 1, nested: [true, null] })
    expect(decoded.session.created).toBe(true)
    expect(encodeExecute(decoded)).toEqual(response)
    expect(decodeExecuteSession(session).created).toBeUndefined()
  })

  it("decodes and encodes native execute image media", () => {
    const response = {
      text: "Image (image/png, 8 bytes)",
      media: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 }],
      isError: false,
      logs: [],
      session,
    }
    expect(encodeExecute(decodeExecute(response))).toEqual(response)
  })

  it("decodes an execute response without warnings or aftermath (older relay)", () => {
    const decoded = decodeExecute({ text: "ok", isError: false, logs: [], session })
    expect(decoded.warnings).toBeUndefined()
    expect(decoded.aftermath).toBeUndefined()
  })

  it("decodes an execute response with logs", () => {
    const decoded = decodeExecute({
      text: "ok",
      isError: false,
      logs: [
        { source: "script", type: "log", text: "hello" },
        { source: "page", type: "error", text: "boom", location: { url: "https://example.com", lineNumber: 1, columnNumber: 2 }, repeatCount: 3 },
      ],
      logSummary: { totalCount: 5, returnedCount: 2, repeatedCount: 3, omittedCount: 0 },
      session,
    })
    expect(decoded.logs).toHaveLength(2)
    expect(decoded.logs[1]?.location?.lineNumber).toBe(1)
    expect(decoded.logs[1]?.repeatCount).toBe(3)
    expect(decoded.logSummary?.totalCount).toBe(5)
  })

  it("rejects an execute log with an unknown source", () => {
    expect(() =>
      decodeExecute({
        text: "ok",
        isError: false,
        logs: [{ source: "relay", type: "log", text: "hello" }],
        session,
      })
    ).toThrow()
  })

  it("decodes extension status with and without optional fields", () => {
    const minimal = decodeExtensionStatus({ connected: false, version: null, activeTargets: 0 })
    expect(minimal.cdpClients).toBeUndefined()
    const full = decodeExtensionStatus({
      connected: true,
      version: "0.0.5",
      activeTargets: 2,
      childTargets: 1,
      cdpClients: 3,
      sessions: [session],
      targets: [],
    })
    expect(full.childTargets).toBe(1)
    expect(full.sessions).toHaveLength(1)
  })

  it("decodes relay versions from current and older builds", () => {
    expect(decodeRelayVersion({ version: "0.1.0", buildId: "2026-07-04T02:00:00.000Z" }).buildId).toBe("2026-07-04T02:00:00.000Z")
    expect(decodeRelayVersion({ version: "0.1.0" }).buildId).toBeUndefined()
  })

  it("decodes target summaries", () => {
    const targets = decodeTargets([
      {
        id: "T1",
        type: "page",
        title: "Example",
        url: "https://example.com",
        tabId: 7,
        sessionId: "bc-tab-1",
        browserControlSessionId: "rapid-otter-633",
        owner: "relay",
        crashed: true,
      },
      { id: "T2", type: "page", title: "", url: "" },
    ])
    expect(targets[0]?.owner).toBe("relay")
    expect(targets[0]?.crashed).toBe(true)
    expect(targets[1]?.tabId).toBeUndefined()
  })

  it("rejects an invalid target owner", () => {
    expect(() => decodeTargets([{ id: "T1", type: "page", title: "", url: "", owner: "someone-else" }])).toThrow()
  })

  it("decodes recording responses", () => {
    const start = decodeRecordingStart({ success: true, tabId: 7, startedAt: 1, path: "/tmp/rec.mp4", mimeType: "video/mp4", mode: "cdp", artifactType: "mp4" })
    expect(start.mode).toBe("cdp")
    const failed = decodeRecordingStart({ success: false, error: "nope" })
    expect(failed.error).toBe("nope")
    const status = decodeRecordingStatus({ isRecording: false })
    expect(status.isRecording).toBe(false)
  })

  it("rejects malformed session and recording requests", () => {
    expect(() => decodeSessionNewRequest({ id: "alpha", readOnly: "yes" })).toThrow()
    expect(() => decodeRecordingStartRequest({
      outputPath: "/tmp/demo.webm",
      tabId: 7,
      audio: "yes",
    })).toThrow()
  })

  it("decodes bounded network capture contracts", () => {
    expect(decodeNetworkStartRequest({
      sessionId: "rapid-otter-633",
      content: "embed",
      maxBodyBytes: 100,
      maxTotalBodyBytes: 1_000,
      maxEntries: 20,
    }).maxTotalBodyBytes).toBe(1_000)
    expect(() => decodeNetworkStartRequest({ sessionId: "rapid-otter-633", maxTotalBodyBytes: 0 })).toThrow()
    expect(decodeNetworkStopResponse({
      active: false,
      startedAt: "2026-07-19T00:00:00.000Z",
      stoppedAt: "2026-07-19T00:01:00.000Z",
      entryCount: 2,
      responseCount: 2,
      failureCount: 0,
      capturedBodyBytes: 100,
      truncatedBodyCount: 0,
      droppedEntryCount: 0,
      updatedSecretRefs: ["BC_SECRET_1"],
      observedSecretRefs: ["BC_SECRET_1"],
    }).observedSecretRefs).toEqual(["BC_SECRET_1"])
  })

  it("decodes current coded and legacy relay error envelopes", () => {
    expect(decodeErrorEnvelope({ error: "missing", code: "target-not-found" })).toEqual({ error: "missing", code: "target-not-found" })
    expect(decodeErrorEnvelope({ error: "legacy" })).toEqual({ error: "legacy" })
    expect(() => decodeErrorEnvelope({ error: "bad", code: "made-up" })).toThrow()
  })
})
