#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, FileSystem, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createDoctorReport, formatDoctorReport } from "./doctor.ts"
import { runMcpServer } from "./mcp.ts"
import * as RelayClient from "./relay-client.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"
import type { ExecuteAftermath, ExecuteLogEntry, ExecuteResponse } from "./relay-schema.ts"
import { startRelay } from "./relay.ts"
import { defaultJournalBaseDir, formatJournalEntry, readJournalEntries } from "./session-journal.ts"
import * as SessionStore from "./session-store.ts"
import { browserControlVersion } from "./version.ts"

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sessionIdConfig = Config.option(Config.string("BROWSER_CONTROL_SESSION"))
const targetUrlConfig = Config.option(Config.string("BROWSER_CONTROL_TARGET_URL"))
const targetIndexConfig = Config.option(Config.int("BROWSER_CONTROL_TARGET_INDEX"))

const readExecuteFile = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path.resolve(filePath)).pipe(
    Effect.mapError((cause) => new Error(`read execute file ${filePath}`, { cause })),
  )
})

const ensureCliRelay = Effect.fnUntraced(function* () {
  const relay = yield* RelayClient.Service
  const readiness = yield* RelayLifecycle.ensureRelay({ relay })
  if (readiness.started) {
    yield* Console.error(`Started Browser Control relay at ${relay.endpoint}`)
  }
  if (readiness.buildProblem) {
    return yield* Effect.fail(new Error(readiness.buildProblem))
  }
  return readiness
})

const ensureCliRelayAndExtension = Effect.fnUntraced(function* () {
  const relay = yield* RelayClient.Service
  const readiness = yield* ensureCliRelay()
  yield* RelayLifecycle.ensureExtensionConnected({ relay, waitForReconnect: readiness.started })
})

const resolveExistingSessionId = Effect.fnUntraced(function* (explicitSessionId: string | undefined) {
  const store = yield* SessionStore.Service
  const sessionId = explicitSessionId ?? (yield* store.read)
  if (!sessionId) {
    return yield* Effect.fail(new Error("No session provided and no current Browser Control session exists"))
  }
  yield* ensureSessionExists(sessionId)
  return sessionId
})

const ensureSessionExists = Effect.fnUntraced(function* (id: string) {
  const relay = yield* RelayClient.Service
  yield* ensureCliRelay()
  const sessions = yield* relay.sessions
  const exists = sessions.some((session) => {
    return session.id === id
  })
  if (!exists) {
    return yield* Effect.fail(new Error(`Session not found: ${id}`))
  }
})

const recordingTarget = Effect.fnUntraced(function* (options: {
  readonly session: Option.Option<string>
  readonly tabId: Option.Option<number>
}) {
  const sessionId = optionString(options.session)
  const tabId = optionNumber(options.tabId)
  if (sessionId && tabId !== undefined) {
    return yield* Effect.fail(new Error("Use only one recording target selector: --session or --tab-id"))
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(tabId === undefined ? {} : { tabId }),
  }
})

const parseRecordingModeOption = Effect.fnUntraced(function* (value: string | undefined) {
  if (value === undefined) {
    return undefined
  }
  if (value === "auto" || value === "tab-capture" || value === "cdp") {
    return value
  }
  return yield* Effect.fail(new Error("Recording mode must be auto, tab-capture, or cdp"))
})

function formatExecuteLogs(logs: readonly ExecuteLogEntry[]): string {
  return [
    "Console logs:",
    ...logs.map((log) => {
      const location = log.location?.url ? ` ${log.location.url}:${log.location.lineNumber}:${log.location.columnNumber}` : ""
      return `[${log.source}:${log.type}]${location} ${log.text}`
    }),
  ].join("\n")
}

/** One-line aftermath summary, or null when nothing interesting happened. */
function formatAftermath(aftermath: ExecuteAftermath): string | null {
  const parts: string[] = []
  if (aftermath.startUrl !== aftermath.endUrl) {
    parts.push(`Page: ${aftermath.startUrl ?? "none"} -> ${aftermath.endUrl ?? "none"}`)
  }
  if (aftermath.navigations.length > 1) {
    parts.push(`navigations=${aftermath.navigations.length}`)
  }
  if (aftermath.pageErrorCount > 0) {
    parts.push(`pageErrors=${aftermath.pageErrorCount}`)
  }
  if (aftermath.handoffs > 0) {
    parts.push(`handoffs=${aftermath.handoffs}`)
  }
  return parts.length > 0 ? parts.join(" ") : null
}

type ExecuteJsonEnvelope = {
  readonly ok: boolean
  readonly isError: boolean
  readonly text: string
  readonly value: unknown | null
  readonly valueUnavailable: boolean
  readonly error?: { readonly _tag: string; readonly message: string }
  readonly logs: readonly ExecuteLogEntry[]
  readonly warnings: readonly string[]
  readonly diagnostic?: string
  readonly aftermath?: ExecuteAftermath
  readonly session?: ExecuteResponse["session"]
}

export function executeJsonEnvelope(result: ExecuteResponse): ExecuteJsonEnvelope {
  const hasStructuredValue = Object.hasOwn(result, "value") && result.value !== undefined
  return {
    ok: !result.isError,
    isError: result.isError,
    text: result.text,
    value: hasStructuredValue ? result.value : null,
    valueUnavailable: !hasStructuredValue,
    ...(result.isError ? { error: { _tag: "ScriptError", message: result.text } } : {}),
    logs: result.logs,
    warnings: result.warnings ?? [],
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    ...(result.aftermath ? { aftermath: result.aftermath } : {}),
    session: result.session,
  }
}

export function formatSessionContinuation(sessionId: string): string {
  return `Session: ${sessionId}. Continue with --session ${sessionId}.`
}

function errorJsonEnvelope(error: unknown): ExecuteJsonEnvelope {
  const tag = typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string" ? error._tag : "Error"
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, isError: true, text: message, value: null, valueUnavailable: true, error: { _tag: tag, message }, logs: [], warnings: [] }
}

function optionString(value: Option.Option<string>): string | undefined {
  return Option.isSome(value) ? value.value : undefined
}

function optionNumber(value: Option.Option<number>): number | undefined {
  return Option.isSome(value) ? value.value : undefined
}

const serve = Command.make(
  "serve",
  {},
  Effect.fn("Cli.serve")(function* () {
    const port = yield* RelayClient.portConfig
    yield* Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* startRelay({ port })
        yield* Console.log(`browser-control relay listening at ${relay.url}`)
        yield* Console.log("Load extension/dist as an unpacked extension and click the toolbar button to attach a tab.")
        yield* Effect.never
      }),
    )
  }),
).pipe(Command.withDescription("Start the local Browser Control relay"))

const execute = Command.make(
  "execute",
  {
    code: Argument.string("code").pipe(Argument.variadic({ min: 0 })),
    file: Flag.string("file").pipe(Flag.optional, Flag.withDescription("Read execute code from a file")),
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Continue an existing Browser Control session; omit to create a fresh one")),
    targetUrl: Flag.string("target-url").pipe(Flag.optional, Flag.withDescription("Use the attached page whose URL contains this text")),
    targetIndex: Flag.integer("target-index").pipe(Flag.optional, Flag.withDescription("Use the attached page at this zero-based index")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print a machine-readable result envelope: { ok, isError, text, value, valueUnavailable, error?, logs, warnings, diagnostic?, aftermath, session }")),
  },
  Effect.fn("Cli.execute")(function* ({ code, file, session, targetUrl, targetIndex, json }) {
    const run = Effect.gen(function* () {
      const relay = yield* RelayClient.Service
      const filePath = optionString(file)
      if (code.length > 0 && filePath) {
        return yield* Effect.fail(new Error("Use either positional code or --file, not both"))
      }
      if (code.length === 0 && !filePath) {
        return yield* Effect.fail(new Error("Execute requires positional code or --file <path>"))
      }
      const executeCode = filePath ? yield* readExecuteFile(filePath) : code.join(" ")
      yield* ensureCliRelayAndExtension()
      const explicitSessionId = optionString(session) ?? Option.getOrUndefined(yield* sessionIdConfig)
      const targetUrlValue = optionString(targetUrl) ?? Option.getOrUndefined(yield* targetUrlConfig)
      const targetIndexValue = optionNumber(targetIndex) ?? Option.getOrUndefined(yield* targetIndexConfig)
      if (targetIndexValue !== undefined && targetIndexValue < 0) {
        return yield* Effect.fail(new Error("Target index must be a non-negative integer"))
      }
      if (targetUrlValue && targetIndexValue !== undefined) {
        return yield* Effect.fail(new Error("Use only one target selector: --target-url/BROWSER_CONTROL_TARGET_URL or --target-index/BROWSER_CONTROL_TARGET_INDEX"))
      }
      const result = yield* relay.execute({
        ...(explicitSessionId ? { sessionId: explicitSessionId } : {}),
        code: executeCode,
        createIfMissing: !explicitSessionId,
        ...(targetUrlValue || targetIndexValue !== undefined
          ? {
            targetSelection: {
              ...(targetUrlValue ? { urlIncludes: targetUrlValue } : {}),
              ...(targetIndexValue !== undefined ? { index: targetIndexValue } : {}),
            },
          }
          : {}),
      })
      if (!explicitSessionId) {
        yield* Console.error(formatSessionContinuation(result.session.id))
      }
      return result
    })
    if (json) {
      const envelope = yield* run.pipe(
        Effect.map(executeJsonEnvelope),
        Effect.catch((error) => Effect.succeed(errorJsonEnvelope(error))),
      )
      yield* Console.log(JSON.stringify(envelope, null, 2))
      if (!envelope.ok) {
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      return
    }
    const outcome = yield* Effect.result(run)
    if (outcome._tag === "Failure") {
      yield* Console.error(outcome.failure.message)
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
      return
    }
    const result = outcome.success
    const print = result.isError ? Console.error : Console.log
    yield* print(result.text)
    if (result.logs.length > 0) {
      yield* print(formatExecuteLogs(result.logs))
    }
    yield* Effect.forEach(result.warnings ?? [], (warning) => print(`Warning: ${warning}`))
    if (result.diagnostic) {
      yield* print(`Diagnostic: ${result.diagnostic}`)
    }
    const aftermath = result.aftermath ? formatAftermath(result.aftermath) : null
    if (aftermath) {
      yield* print(aftermath)
    }
    if (result.isError) {
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }
  }),
).pipe(Command.withDescription("Execute Playwright code against the attached browser"))

const sessionNew = Command.make(
  "new",
  {
    name: Argument.string("name").pipe(Argument.optional, Argument.withDescription("Optional lowercase session id")),
    readOnly: Flag.boolean("read-only").pipe(Flag.withDescription("Create a read-only session: the relay rejects input-dispatching CDP so scripts can inspect but not click or type")),
  },
  Effect.fn("Cli.sessionNew")(function* ({ name, readOnly }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const store = yield* SessionStore.Service
    const result = yield* relay.sessionNew(optionString(name), readOnly ? { readOnly: true } : {})
    yield* store.write(result.id)
    yield* Console.log(result.id)
  }),
).pipe(Command.withDescription("Create a Browser Control session and make it current"))

const sessionList = Command.make(
  "list",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON")),
  },
  Effect.fn("Cli.sessionList")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const store = yield* SessionStore.Service
    const sessions = yield* relay.sessions
    const current = yield* store.read
    if (json) {
      yield* Console.log(JSON.stringify({ current: current ?? undefined, sessions }, null, 2))
      return
    }
    if (sessions.length === 0) {
      yield* Console.log("No sessions")
      return
    }
    yield* Effect.forEach(sessions, (item) => {
      const marker = item.id === current ? "*" : " "
      const page = item.pageUrl ?? "no page yet"
      const keys = item.stateKeys.length ? ` state=${item.stateKeys.join(",")}` : ""
      const readOnly = item.readOnly ? " read-only" : ""
      return Console.log(`${marker} ${item.id} ${page}${keys}${readOnly}`)
    })
  }),
).pipe(Command.withDescription("List Browser Control sessions"))

const sessionCurrent = Command.make(
  "current",
  {},
  Effect.fn("Cli.sessionCurrent")(function* () {
    const store = yield* SessionStore.Service
    const current = yield* store.read
    yield* Console.log(current ?? "none")
  }),
).pipe(Command.withDescription("Print the current default session"))

const sessionUse = Command.make(
  "use",
  {
    id: Argument.string("id"),
  },
  Effect.fn("Cli.sessionUse")(function* ({ id }) {
    const store = yield* SessionStore.Service
    yield* ensureSessionExists(id)
    yield* store.write(id)
    yield* Console.log(id)
  }),
).pipe(Command.withDescription("Set the current default session"))

const sessionReset = Command.make(
  "reset",
  {
    id: Argument.string("id").pipe(Argument.optional),
  },
  Effect.fn("Cli.sessionReset")(function* ({ id }) {
    const relay = yield* RelayClient.Service
    const sessionId = yield* resolveExistingSessionId(optionString(id))
    const session = yield* relay.sessionReset(sessionId)
    yield* Console.log(session.id)
  }),
).pipe(Command.withDescription("Reset a Browser Control session state and page"))

const sessionAdopt = Command.make(
  "adopt",
  {
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Adopt into an existing Browser Control session; omit to create a fresh one")),
    targetUrl: Flag.string("target-url").pipe(Flag.optional, Flag.withDescription("Adopt the attached page whose URL contains this text")),
    targetIndex: Flag.integer("target-index").pipe(Flag.optional, Flag.withDescription("Adopt the attached page at this zero-based target index")),
  },
  Effect.fn("Cli.sessionAdopt")(function* ({ session, targetUrl, targetIndex }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const explicitSessionId = optionString(session) ?? Option.getOrUndefined(yield* sessionIdConfig)
    const targetUrlValue = optionString(targetUrl)
    const targetIndexValue = optionNumber(targetIndex)
    if (!targetUrlValue && targetIndexValue === undefined) {
      return yield* Effect.fail(new Error("session adopt requires --target-url or --target-index"))
    }
    if (targetIndexValue !== undefined && targetIndexValue < 0) {
      return yield* Effect.fail(new Error("Target index must be a non-negative integer"))
    }
    if (targetUrlValue && targetIndexValue !== undefined) {
      return yield* Effect.fail(new Error("Use only one target selector: --target-url or --target-index"))
    }
    const result = yield* relay.sessionAdopt({
      ...(explicitSessionId ? { sessionId: explicitSessionId } : {}),
      createIfMissing: !explicitSessionId,
      targetSelection: {
        ...(targetUrlValue ? { urlIncludes: targetUrlValue } : {}),
        ...(targetIndexValue !== undefined ? { index: targetIndexValue } : {}),
      },
    })
    yield* Console.log(`${result.session.created ? "Created and adopted" : "Adopted"} session '${result.session.id}' default page: ${result.adoptedUrl}`)
    if (result.session.created) {
      yield* Console.error(formatSessionContinuation(result.session.id))
    }
  }),
).pipe(Command.withDescription("Make an attached tab the session's default page"))

const sessionDelete = Command.make(
  "delete",
  {
    id: Argument.string("id").pipe(Argument.optional),
  },
  Effect.fn("Cli.sessionDelete")(function* ({ id }) {
    const relay = yield* RelayClient.Service
    const store = yield* SessionStore.Service
    const sessionId = yield* resolveExistingSessionId(optionString(id))
    yield* relay.sessionDelete(sessionId)
    const current = yield* store.read
    if (current === sessionId) {
      yield* store.clear
    }
    yield* Console.log(sessionId)
  }),
).pipe(Command.withDescription("Delete a Browser Control session"))

const session = Command.make("session").pipe(
  Command.withDescription("Manage Browser Control sessions"),
  Command.withSubcommands([sessionNew, sessionList, sessionCurrent, sessionUse, sessionReset, sessionAdopt, sessionDelete]),
)

const status = Command.make(
  "status",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON")),
  },
  Effect.fn("Cli.status")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    const store = yield* SessionStore.Service
    const relayResult = yield* Effect.result(relay.version)
    if (relayResult._tag === "Failure") {
      if (!(relayResult.failure instanceof RelayClient.RelayUnreachable)) {
        if (json) {
          yield* Console.log(JSON.stringify({
            endpoint: relay.endpoint,
            relay: { running: false, error: relayResult.failure.message },
            extension: null,
            sessions: [],
            targets: [],
          }, null, 2))
        } else {
          yield* Console.error(`Relay status failed: ${relayResult.failure.message}`)
        }
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
        return
      }
      const stopped = RelayLifecycle.stoppedRelayStatus(relay.endpoint)
      if (json) {
        yield* Console.log(JSON.stringify(stopped, null, 2))
      } else {
        yield* Console.log(`Relay: stopped (${relay.endpoint})`)
        yield* Console.log("Run browser-control execute to start it automatically.")
      }
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
      return
    }
    const version = relayResult.success
    const buildProblem = RelayLifecycle.relayBuildProblem(version)
    const [extensionStatus, current] = yield* Effect.all([relay.extensionStatus, store.read])
    const collections = RelayLifecycle.statusCollections(extensionStatus)
    const [sessions, targets] = collections
      ? [collections.sessions, collections.targets]
      : yield* Effect.all([relay.sessions, relay.targets])
    if (json) {
      yield* Console.log(JSON.stringify({
        endpoint: relay.endpoint,
        relay: { running: true, version: version.version, buildId: version.buildId ?? null, stale: buildProblem !== undefined },
        extension: extensionStatus,
        currentSession: current ?? null,
        sessions,
        targets,
      }, null, 2))
      if (buildProblem) {
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      return
    }
    yield* Console.log(`Relay: ${relay.endpoint} (${version.version})`)
    if (buildProblem) {
      yield* Console.log(`Warning: ${buildProblem}`)
    }
    yield* Console.log(`Extension: ${extensionStatus.connected ? "connected" : "disconnected"}${extensionStatus.version ? ` (${extensionStatus.version})` : ""}`)
    yield* Console.log(`Active targets: ${extensionStatus.activeTargets}`)
    if (extensionStatus.childTargets !== undefined) {
      yield* Console.log(`Child targets: ${extensionStatus.childTargets}`)
    }
    if (extensionStatus.cdpClients !== undefined) {
      yield* Console.log(`CDP clients: ${extensionStatus.cdpClients}`)
    }
    yield* Console.log(`Current session: ${current ?? "none"}`)
    if (sessions.length === 0) {
      yield* Console.log("Sessions: none")
    } else {
      yield* Console.log("Sessions:")
      yield* Effect.forEach(sessions, (item) => {
        const marker = item.id === current ? "*" : " "
        return Console.log(`${marker} ${item.id} ${item.pageUrl ?? "no page yet"}`)
      })
    }
    if (targets.length === 0) {
      yield* Console.log("Targets: none")
    } else {
      yield* Console.log("Targets:")
      yield* Effect.forEach(targets, (target, index) => {
        const tab = target.tabId === undefined ? "" : ` tab=${target.tabId}`
        const browserControlSession = target.browserControlSessionId ? ` session=${target.browserControlSessionId}` : ""
        const owner = target.owner ? ` owner=${target.owner}` : ""
        const health = target.crashed ? " crashed=true" : ""
        return Console.log(`- [${index}] ${target.type} ${target.id}${tab}${browserControlSession}${owner}${health} ${target.url || "about:blank"}`)
      })
    }
    if (buildProblem) {
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }
  }),
).pipe(Command.withDescription("Show relay, extension, and target status"))

const recordingStart = Command.make(
  "start",
  {
    outputPath: Argument.string("output-path").pipe(Argument.withDescription("Path to write the recording artifact; tabCapture requires .webm, CDP accepts .webm or .mp4")),
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Record the page for this Browser Control or CDP session id")),
    tabId: Flag.integer("tab-id").pipe(Flag.optional, Flag.withDescription("Record this attached Chrome tab id")),
    mode: Flag.string("mode").pipe(Flag.optional, Flag.withDescription("Recording mode: auto, tab-capture, or cdp. auto uses CDP for relay-owned tabs and tabCapture for user-owned tabs")),
    audio: Flag.boolean("audio").pipe(Flag.withDescription("Include tab audio")),
    frameRate: Flag.integer("frame-rate").pipe(Flag.optional, Flag.withDescription("Output frame rate, defaults to 30 for tab-capture and 25 for CDP")),
    maxDurationMs: Flag.integer("max-duration-ms").pipe(Flag.optional, Flag.withDescription("Auto-stop guard in milliseconds, defaults to 900000")),
  },
  Effect.fn("Cli.recordingStart")(function* ({ outputPath, session, tabId, mode, audio, frameRate, maxDurationMs }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const target = yield* recordingTarget({ session, tabId })
    const modeValue = yield* parseRecordingModeOption(optionString(mode))
    const frameRateValue = optionNumber(frameRate)
    const maxDurationMsValue = optionNumber(maxDurationMs)
    const resolvedOutputPath = path.resolve(outputPath)
    const result = yield* relay.recordingStart({
      ...target,
      outputPath: resolvedOutputPath,
      ...(modeValue === undefined ? {} : { mode: modeValue }),
      audio,
      ...(frameRateValue === undefined ? {} : { frameRate: frameRateValue }),
      ...(maxDurationMsValue === undefined ? {} : { maxDurationMs: maxDurationMsValue }),
    })
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to start recording"))
    }
    yield* Console.log(`Recording started: ${result.path ?? resolvedOutputPath} tab=${result.tabId ?? "unknown"} mode=${result.mode ?? "tab-capture"} artifact=${result.artifactType ?? "webm"} mime=${result.mimeType ?? "video/webm"}`)
  }),
).pipe(Command.withDescription("Start recording an attached tab"))

const recordingStop = Command.make(
  "stop",
  {
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Stop recording for this CDP session id")),
    tabId: Flag.integer("tab-id").pipe(Flag.optional, Flag.withDescription("Stop recording for this Chrome tab id")),
  },
  Effect.fn("Cli.recordingStop")(function* ({ session, tabId }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.recordingStop(target)
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to stop recording"))
    }
    const frames = result.frameCount === undefined ? "" : `, frames=${result.frameCount}`
    yield* Console.log(`Recording saved: ${result.path ?? "unknown"} (${result.size ?? 0} bytes, ${result.duration ?? 0}ms, mode=${result.mode ?? "tab-capture"}, artifact=${result.artifactType ?? "webm"}${frames})`)
  }),
).pipe(Command.withDescription("Stop recording and write the artifact"))

const recordingStatus = Command.make(
  "status",
  {
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Check recording for this CDP session id")),
    tabId: Flag.integer("tab-id").pipe(Flag.optional, Flag.withDescription("Check recording for this Chrome tab id")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON")),
  },
  Effect.fn("Cli.recordingStatus")(function* ({ session, tabId, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.recordingStatus(target)
    if (json) {
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    if (!result.isRecording) {
      yield* Console.log("Recording: inactive")
      return
    }
    const frames = result.frameCount === undefined ? "" : ` frameCount=${result.frameCount}`
    yield* Console.log(`Recording: active tab=${result.tabId ?? "unknown"} mode=${result.mode ?? "tab-capture"} artifact=${result.artifactType ?? "webm"} path=${result.path ?? "unknown"} size=${result.size ?? 0}${frames} startedAt=${result.startedAt ?? "unknown"}`)
  }),
).pipe(Command.withDescription("Check current recording status"))

const recordingCancel = Command.make(
  "cancel",
  {
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Cancel recording for this CDP session id")),
    tabId: Flag.integer("tab-id").pipe(Flag.optional, Flag.withDescription("Cancel recording for this Chrome tab id")),
  },
  Effect.fn("Cli.recordingCancel")(function* ({ session, tabId }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.recordingCancel(target)
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to cancel recording"))
    }
    yield* Console.log("Recording cancelled")
  }),
).pipe(Command.withDescription("Cancel recording without writing a file"))

const recording = Command.make("recording").pipe(
  Command.withDescription("Record an attached tab to WebM or MP4"),
  Command.withSubcommands([recordingStart, recordingStop, recordingStatus, recordingCancel]),
)

const journal = Command.make(
  "journal",
  {
    session: Flag.string("session").pipe(Flag.optional, Flag.withAlias("s"), Flag.withDescription("Show the journal for this Browser Control session id")),
    limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription("Number of most recent entries to show, defaults to 20")),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON")),
  },
  Effect.fn("Cli.journal")(function* ({ session, limit, json }) {
    const store = yield* SessionStore.Service
    const sessionId = optionString(session) ?? Option.getOrUndefined(yield* sessionIdConfig) ?? (yield* store.read)
    if (!sessionId) {
      return yield* Effect.fail(new Error("No session provided and no current Browser Control session exists"))
    }
    const entries = yield* Effect.tryPromise({
      try: () => readJournalEntries({ baseDir: defaultJournalBaseDir(), sessionId, limit: optionNumber(limit) ?? 20 }),
      catch: (cause) => new Error(`read session journal for ${sessionId}`, { cause }),
    })
    if (json) {
      yield* Console.log(JSON.stringify({ session: sessionId, entries }, null, 2))
      return
    }
    if (entries.length === 0) {
      yield* Console.log(`No journal entries for session ${sessionId}`)
      return
    }
    yield* Console.log(`Journal for ${sessionId} (last ${entries.length}):`)
    yield* Effect.forEach(entries, (entry) => {
      return Console.log(formatJournalEntry(entry))
    })
  }),
).pipe(Command.withDescription("Show what agents did in a Browser Control session"))

const doctor = Command.make(
  "doctor",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON")),
  },
  Effect.fn("Cli.doctor")(function* ({ json }) {
    const report = yield* createDoctorReport({ packageRoot })
    if (json) {
      yield* Console.log(JSON.stringify(report, null, 2))
    } else {
      yield* Console.log(formatDoctorReport(report))
    }
    if (report.status === "fail") {
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }
  }),
).pipe(Command.withDescription("Diagnose the local Browser Control install and runtime"))

const skill = Command.make(
  "skill",
  {},
  Effect.fn("Cli.skill")(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path.join(packageRoot, "skills", "browser-control", "SKILL.md")).pipe(
      Effect.mapError((cause) => new Error("read browser-control skill", { cause })),
    )
    yield* Console.log(text.trimEnd())
  }),
).pipe(Command.withDescription("Print the Browser Control agent skill text"))

const mcp = Command.make(
  "mcp",
  {},
  Effect.fn("Cli.mcp")(function* () {
    yield* runMcpServer
  }),
).pipe(Command.withDescription("Run the Browser Control MCP server over stdio"))

const browserControl = Command.make("browser-control").pipe(
  Command.withDescription("Control the user's existing browser through the Browser Control extension"),
  Command.withSubcommands([serve, execute, session, status, recording, journal, doctor, skill, mcp]),
)

const mainLayer = Layer.mergeAll(RelayClient.layerFetch, SessionStore.layer).pipe(
  // CLI commands consume FileSystem directly in addition to SessionStore, so
  // Node services intentionally remain exposed downstream.
  Layer.provideMerge(NodeServices.layer),
)

browserControl.pipe(Command.run({ version: browserControlVersion }), Effect.provide(mainLayer), NodeRuntime.runMain)
