import { Schema } from "effect"

/**
 * Shared wire contract for the relay HTTP API.
 *
 * These schemas are the single source of truth for the JSON shapes exchanged
 * between the relay's HTTP responders (`src/http-api.ts`) and its clients
 * (`src/relay-client.ts`, used by the CLI and the MCP server). Server-side
 * producers derive their types from here so the contract cannot drift.
 */

export const SessionSummary = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  connected: Schema.Boolean,
  pageUrl: Schema.NullOr(Schema.String),
  stateKeys: Schema.Array(Schema.String),
  readOnly: Schema.optionalKey(Schema.Boolean),
})

export interface SessionSummary extends Schema.Schema.Type<typeof SessionSummary> {}

export const ExecuteSessionSummary = SessionSummary.pipe(Schema.fieldsAssign({
  created: Schema.optionalKey(Schema.Boolean),
}))

export interface ExecuteSessionSummary extends Schema.Schema.Type<typeof ExecuteSessionSummary> {}

export const SessionContainer = Schema.Struct({
  session: SessionSummary,
})

export interface SessionContainer extends Schema.Schema.Type<typeof SessionContainer> {}

export const SessionsContainer = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
})

export interface SessionsContainer extends Schema.Schema.Type<typeof SessionsContainer> {}

export const SessionDeleted = Schema.Struct({
  deleted: Schema.Boolean,
  id: Schema.String,
})

export interface SessionDeleted extends Schema.Schema.Type<typeof SessionDeleted> {}

export const TargetSelection = Schema.Struct({
  urlIncludes: Schema.optionalKey(Schema.NonEmptyString),
  index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).check(Schema.makeFilter((selection) => {
  const hasUrl = selection.urlIncludes !== undefined
  const hasIndex = selection.index !== undefined
  return hasUrl !== hasIndex ? undefined : "targetSelection must contain exactly one of urlIncludes or index"
}))

export interface TargetSelection extends Schema.Schema.Type<typeof TargetSelection> {}

export const ExecuteRequest = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  code: Schema.String,
  createIfMissing: Schema.Boolean,
  targetSelection: Schema.optionalKey(TargetSelection),
})

export interface ExecuteRequest extends Schema.Schema.Type<typeof ExecuteRequest> {}

export const SessionAdoptRequest = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  createIfMissing: Schema.Boolean,
  targetSelection: TargetSelection,
})

export interface SessionAdoptRequest extends Schema.Schema.Type<typeof SessionAdoptRequest> {}

export const SessionNewRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  readOnly: Schema.optionalKey(Schema.Boolean),
})

export interface SessionNewRequest extends Schema.Schema.Type<typeof SessionNewRequest> {}

export const SessionIdRequest = Schema.Struct({
  id: Schema.String,
})

export interface SessionIdRequest extends Schema.Schema.Type<typeof SessionIdRequest> {}

export const SessionAdoptResponse = Schema.Struct({
  session: ExecuteSessionSummary,
  adoptedUrl: Schema.String,
  adoptedTargetId: Schema.String,
})

export interface SessionAdoptResponse extends Schema.Schema.Type<typeof SessionAdoptResponse> {}

export const ExecuteLogLocation = Schema.Struct({
  url: Schema.String,
  lineNumber: Schema.Number,
  columnNumber: Schema.Number,
})

export interface ExecuteLogLocation extends Schema.Schema.Type<typeof ExecuteLogLocation> {}

export const ExecuteLogEntry = Schema.Struct({
  source: Schema.Literals(["script", "page"]),
  type: Schema.String,
  text: Schema.String,
  location: Schema.optionalKey(ExecuteLogLocation),
  repeatCount: Schema.optionalKey(Schema.Number),
})

export interface ExecuteLogEntry extends Schema.Schema.Type<typeof ExecuteLogEntry> {}

export const ExecuteLogSummary = Schema.Struct({
  totalCount: Schema.Number,
  returnedCount: Schema.Number,
  repeatedCount: Schema.Number,
  omittedCount: Schema.Number,
})

export interface ExecuteLogSummary extends Schema.Schema.Type<typeof ExecuteLogSummary> {}

/**
 * What changed in the browser during one execute call: URL movement, main
 * frame navigations, error counts, and human handoffs. Delivered with the
 * call that caused it so agents never fish warnings out of a later response.
 */
export const ExecuteAftermath = Schema.Struct({
  startUrl: Schema.NullOr(Schema.String),
  endUrl: Schema.NullOr(Schema.String),
  navigations: Schema.Array(Schema.String),
  consoleErrorCount: Schema.Number,
  pageErrorCount: Schema.Number,
  handoffs: Schema.Number,
})

export interface ExecuteAftermath extends Schema.Schema.Type<typeof ExecuteAftermath> {}

export const ExecuteMedia = Schema.Struct({
  type: Schema.Literal("image"),
  mimeType: Schema.String,
  data: Schema.String,
  size: Schema.Number,
})

export interface ExecuteMedia extends Schema.Schema.Type<typeof ExecuteMedia> {}

export const ExecuteResponse = Schema.Struct({
  text: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
  media: Schema.optionalKey(Schema.Array(ExecuteMedia)),
  isError: Schema.Boolean,
  logs: Schema.Array(ExecuteLogEntry),
  logSummary: Schema.optionalKey(ExecuteLogSummary),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  diagnostic: Schema.optionalKey(Schema.String),
  aftermath: Schema.optionalKey(ExecuteAftermath),
  session: ExecuteSessionSummary,
})

export interface ExecuteResponse extends Schema.Schema.Type<typeof ExecuteResponse> {}

export const TargetSummary = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  url: Schema.String,
  tabId: Schema.optionalKey(Schema.Number),
  sessionId: Schema.optionalKey(Schema.String),
  browserControlSessionId: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.Literals(["relay", "user"])),
  crashed: Schema.optionalKey(Schema.Boolean),
})

export interface TargetSummary extends Schema.Schema.Type<typeof TargetSummary> {}

export const TargetSummaries = Schema.Array(TargetSummary)

export const ExtensionStatus = Schema.Struct({
  connected: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  activeTargets: Schema.Number,
  childTargets: Schema.optionalKey(Schema.Number),
  cdpClients: Schema.optionalKey(Schema.Number),
  sessions: Schema.optionalKey(Schema.Array(SessionSummary)),
  targets: Schema.optionalKey(TargetSummaries),
})

export interface ExtensionStatus extends Schema.Schema.Type<typeof ExtensionStatus> {}

export const RelayVersion = Schema.Struct({
  version: Schema.String,
  buildId: Schema.optionalKey(Schema.String),
})

export interface RelayVersion extends Schema.Schema.Type<typeof RelayVersion> {}

export const RecordingMode = Schema.Literals(["tab-capture", "cdp"])

export const RecordingRequestedMode = Schema.Literals(["auto", "tab-capture", "cdp"])

export const RecordingTargetRequest = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  tabId: Schema.optionalKey(Schema.Number),
})

export interface RecordingTargetRequest extends Schema.Schema.Type<typeof RecordingTargetRequest> {}

export const RecordingStartRequest = RecordingTargetRequest.pipe(Schema.fieldsAssign({
  outputPath: Schema.String,
  mode: Schema.optionalKey(RecordingRequestedMode),
  audio: Schema.optionalKey(Schema.Boolean),
  frameRate: Schema.optionalKey(Schema.Number),
  videoBitsPerSecond: Schema.optionalKey(Schema.Number),
  audioBitsPerSecond: Schema.optionalKey(Schema.Number),
  maxDurationMs: Schema.optionalKey(Schema.Number),
}))

export interface RecordingStartRequest extends Schema.Schema.Type<typeof RecordingStartRequest> {}

export const RecordingArtifactType = Schema.Literals(["webm", "mp4"])

export const RecordingStartResponse = Schema.Struct({
  success: Schema.Boolean,
  tabId: Schema.optionalKey(Schema.Number),
  startedAt: Schema.optionalKey(Schema.Number),
  path: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(RecordingMode),
  artifactType: Schema.optionalKey(RecordingArtifactType),
  error: Schema.optionalKey(Schema.String),
})

export interface RecordingStartResponse extends Schema.Schema.Type<typeof RecordingStartResponse> {}

export const RecordingStopResponse = Schema.Struct({
  success: Schema.Boolean,
  tabId: Schema.optionalKey(Schema.Number),
  duration: Schema.optionalKey(Schema.Number),
  path: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  mode: Schema.optionalKey(RecordingMode),
  artifactType: Schema.optionalKey(RecordingArtifactType),
  frameCount: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
})

export interface RecordingStopResponse extends Schema.Schema.Type<typeof RecordingStopResponse> {}

export const RecordingStatusResponse = Schema.Struct({
  isRecording: Schema.Boolean,
  tabId: Schema.optionalKey(Schema.Number),
  startedAt: Schema.optionalKey(Schema.Number),
  path: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  mode: Schema.optionalKey(RecordingMode),
  artifactType: Schema.optionalKey(RecordingArtifactType),
  frameCount: Schema.optionalKey(Schema.Number),
})

export interface RecordingStatusResponse extends Schema.Schema.Type<typeof RecordingStatusResponse> {}

export const RecordingCancelResponse = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
})

export interface RecordingCancelResponse extends Schema.Schema.Type<typeof RecordingCancelResponse> {}

export const RelayErrorCode = Schema.Literals([
  "invalid-request",
  "session-already-exists",
  "session-inactive",
  "session-not-found",
  "session-timeout",
  "setup-failed",
  "target-ambiguous",
  "target-changed",
  "target-not-found",
  "target-owned",
  "internal",
])

export type RelayErrorCode = Schema.Schema.Type<typeof RelayErrorCode>

export const ErrorEnvelope = Schema.Struct({
  error: Schema.String,
  code: Schema.optionalKey(RelayErrorCode),
})

export interface ErrorEnvelope extends Schema.Schema.Type<typeof ErrorEnvelope> {}
