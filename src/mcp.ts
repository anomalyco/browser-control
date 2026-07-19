import { NodeStdio } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Option } from "effect"
import { McpSchema, McpServer } from "effect/unstable/ai"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonObject } from "./protocol.ts"
import { getObject, parseTargetSelection } from "./relay-helpers.ts"
import * as RelayClient from "./relay-client.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"
import { browserControlVersion } from "./version.ts"

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
type CurrentSession = { id: string; established: boolean }

type ToolSpec = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly handle: (input: unknown) => Effect.Effect<unknown, Error>
}

type ExecuteArguments = {
  readonly code: string
  readonly session?: string | undefined
  readonly targetUrl?: string | undefined
  readonly targetIndex?: number | undefined
}

type AdoptArguments = {
  readonly session?: string | undefined
  readonly targetUrl?: string | undefined
  readonly targetIndex?: number | undefined
}

const emptyInputSchema = objectSchema({})

function makeToolSpecs(relay: RelayClient.Interface, currentSession: CurrentSession): readonly ToolSpec[] {
  return [
    {
      name: "execute",
      description: "Execute trusted Playwright JavaScript against the Browser Control session. The result includes console logs, warnings, a bounded execution-context diagnostic when relevant, and an aftermath summary (URL movement, navigations, error counts, handoffs).",
      inputSchema: objectSchema({
        code: { type: "string", description: "JavaScript code to execute. It receives browser, context, page, state, modules, fillInput, fillInputs, snapshot(options?) for a compact semantic outline or explicit diff against the previous snapshot, ref(id) for the latest snapshot's locator, screenshotWithLabels, ariaSnapshot(target?, { timeout }), ghostCursor (show/hide), and handoff(message, { timeoutMs })." },
        session: { type: "string", description: "Optional existing Browser Control session id. Explicit ids must already exist; omit this field to use the MCP server's current session, which is created when needed." },
        targetUrl: { type: "string", description: "Optional URL substring selecting an existing attached page. This does not navigate or open a URL; use page.goto() for that." },
        targetIndex: { type: "integer", minimum: 0, description: "Optional zero-based attached page index selector." },
      }, ["code"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const args = yield* Effect.try(() => parseExecuteArguments(input))
        yield* RelayLifecycle.ensureExtensionConnected({ relay, waitForReconnect: true })
        const sessionId = args.session ?? currentSession.id
        const result = yield* relay.execute({
          sessionId,
          code: args.code,
          createIfMissing: !args.session,
          ...(args.targetUrl || args.targetIndex !== undefined
            ? {
              targetSelection: {
                ...(args.targetUrl ? { urlIncludes: args.targetUrl } : {}),
                ...(args.targetIndex !== undefined ? { index: args.targetIndex } : {}),
              },
            }
            : {}),
        })
        const recreated = !args.session && currentSession.established && result.session.created === true
        currentSession.id = sessionId
        currentSession.established = true
        return {
          ...result,
          ...(recreated ? { notice: `Recreated session '${sessionId}' — relay had no such session; page and state were reset.` } : {}),
        }
      }),
    },
    {
      name: "status",
      description: "Return relay, extension, target, and session status.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: false,
      handle: () => Effect.gen(function* () {
        const status = yield* relay.extensionStatus
        return { endpoint: relay.endpoint, currentSession: currentSession.id, status }
      }),
    },
    {
      name: "session_new",
      description: "Create a Browser Control session and make it current for this MCP server.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Optional lowercase session id." },
        readOnly: { type: "boolean", description: "Create a read-only session: the relay rejects input-dispatching CDP so scripts can inspect but not click or type." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const requestedId = optionalStringField(input, "id")
        const readOnly = optionalBooleanField(input, "readOnly")
        const session = yield* relay.sessionNew(requestedId, readOnly ? { readOnly: true } : {})
        currentSession.id = session.id
        currentSession.established = true
        return { session }
      }),
    },
    {
      name: "session_list",
      description: "List Browser Control sessions.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: false,
      handle: () => relay.sessions.pipe(Effect.map((sessions) => ({ sessions }))),
    },
    {
      name: "session_current",
      description: "Return this MCP server's current Browser Control session id.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () => Effect.succeed({ currentSession: currentSession.id }),
    },
    {
      name: "session_use",
      description: "Set this MCP server's current Browser Control session id.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Existing Browser Control session id." },
      }, ["id"]),
      readOnly: false,
      destructive: false,
      idempotent: true,
      handle: (input) => Effect.gen(function* () {
        const id = yield* Effect.try(() => requiredStringField(input, "id"))
        yield* ensureSessionExists(relay, id)
        currentSession.id = id
        currentSession.established = true
        return { currentSession: currentSession.id }
      }),
    },
    {
      name: "session_reset",
      description: "Reset a Browser Control session's state and page.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Optional session id. Defaults to this MCP server's current session." },
      }),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const id = optionalStringField(input, "id") ?? currentSession.id
        const session = yield* relay.sessionReset(id)
        currentSession.id = id
        currentSession.established = true
        return { session }
      }),
    },
    {
      name: "session_delete",
      description: "Delete a Browser Control session.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Optional session id. Defaults to this MCP server's current session." },
      }),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const id = optionalStringField(input, "id") ?? currentSession.id
        const result = yield* relay.sessionDelete(id)
        if (currentSession.id === id) {
          currentSession.id = `mcp-${crypto.randomUUID().slice(0, 8)}`
          currentSession.established = false
        }
        return { ...result, currentSession: currentSession.id }
      }),
    },
    {
      name: "session_adopt",
      description: "Make an attached tab the Browser Control session's default page for subsequent bare execute calls.",
      inputSchema: objectSchema({
        session: { type: "string", description: "Optional existing Browser Control session id. Explicit ids must already exist; omit this field to use the MCP server's current session, which is created when needed." },
        targetUrl: { type: "string", description: "Adopt an existing attached page whose URL contains this text. This does not navigate or open a URL." },
        targetIndex: { type: "integer", minimum: 0, description: "Adopt the attached page at this zero-based target index." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const args = yield* Effect.try(() => parseAdoptArguments(input))
        const sessionId = args.session ?? currentSession.id
        const result = yield* relay.sessionAdopt({
          sessionId,
          createIfMissing: !args.session,
          targetSelection: {
            ...(args.targetUrl ? { urlIncludes: args.targetUrl } : {}),
            ...(args.targetIndex !== undefined ? { index: args.targetIndex } : {}),
          },
        })
        currentSession.id = sessionId
        currentSession.established = true
        return { ...result, confirmation: `Adopted session '${result.session.id}' default page: ${result.adoptedUrl}` }
      }),
    },
    {
      name: "network_start",
      description: "Start session-scoped network capture. Browser Control records normalized Playwright exchanges; HAR is only the optional export format. Bodies are embedded by default with per-body and total memory limits.",
      inputSchema: objectSchema({
        session: { type: "string", description: "Optional existing session id. Omit to use or create this MCP server's current session." },
        urlFilter: { type: "string", description: "Capture only request URLs containing this text." },
        resourceTypes: { type: "array", items: { type: "string" }, description: "Optional Playwright resource types such as fetch and xhr." },
        content: { type: "string", enum: ["embed", "omit"], description: "Request and response body mode. Defaults to embed." },
        maxBodyBytes: { type: "integer", minimum: 1, description: "Maximum bytes captured from each body. Defaults to 1000000." },
        maxTotalBodyBytes: { type: "integer", minimum: 1, description: "Maximum body bytes retained for the capture. Defaults to 25000000." },
        maxEntries: { type: "integer", minimum: 1, description: "Maximum captured requests. Defaults to 1000." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const object = requireObject(input)
        const explicitSession = optionalStringField(object, "session")
        const sessionId = explicitSession ?? currentSession.id
        if (explicitSession) {
          yield* ensureSessionExists(relay, sessionId)
        } else {
          const sessions = yield* relay.sessions
          if (!sessions.some((session) => session.id === sessionId)) {
            yield* relay.sessionNew(sessionId)
          }
          currentSession.established = true
        }
        yield* RelayLifecycle.ensureExtensionConnected({ relay, waitForReconnect: true })
        const content = optionalStringField(object, "content")
        if (content !== undefined && content !== "embed" && content !== "omit") {
          return yield* Effect.fail(new Error("content must be embed or omit"))
        }
        const urlFilter = optionalStringField(object, "urlFilter")
        const resourceTypes = optionalStringArrayField(object, "resourceTypes")
        const maxBodyBytes = optionalPositiveIntegerField(object, "maxBodyBytes")
        const maxTotalBodyBytes = optionalPositiveIntegerField(object, "maxTotalBodyBytes")
        const maxEntries = optionalPositiveIntegerField(object, "maxEntries")
        const result = yield* relay.networkStart({
          sessionId,
          ...(urlFilter ? { urlFilter } : {}),
          ...(resourceTypes && resourceTypes.length > 0 ? { resourceTypes } : {}),
          ...(content ? { content } : {}),
          ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
          ...(maxTotalBodyBytes === undefined ? {} : { maxTotalBodyBytes }),
          ...(maxEntries === undefined ? {} : { maxEntries }),
        })
        return { session: sessionId, ...result }
      }),
    },
    {
      name: "network_status",
      description: "Return bounded metadata for a session's active network capture. Captured values are never included.",
      inputSchema: objectSchema({ session: { type: "string", description: "Optional session id. Defaults to this MCP server's current session." } }),
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => {
        const sessionId = optionalStringField(input, "session") ?? currentSession.id
        return relay.networkStatus({ sessionId }).pipe(Effect.map((result) => ({ session: sessionId, ...result })))
      },
    },
    {
      name: "network_stop",
      description: "Stop network capture. Optionally write a credential-redacted HAR and store lossless credential values in a reusable secret profile. At least one of outputPath or secrets is required.",
      inputSchema: objectSchema({
        session: { type: "string", description: "Optional session id. Defaults to this MCP server's current session." },
        outputPath: { type: "string", description: "Optional artifact path, resolved against the MCP process working directory. The HAR contains stable ${BC_SECRET_N} references, not captured values." },
        secrets: { type: "string", description: "Optional reusable profile name for captured credential values." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const sessionId = optionalStringField(input, "session") ?? currentSession.id
        const outputPath = optionalStringField(input, "outputPath")
        const secrets = optionalStringField(input, "secrets")
        if (!outputPath && !secrets) {
          return yield* Effect.fail(new Error("network_stop requires outputPath, secrets, or both"))
        }
        return yield* relay.networkStop({
          sessionId,
          ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
          ...(secrets ? { secrets } : {}),
        })
      }),
    },
    {
      name: "network_cancel",
      description: "Cancel a session's network capture and discard its in-memory exchanges.",
      inputSchema: objectSchema({ session: { type: "string", description: "Optional session id. Defaults to this MCP server's current session." } }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => relay.networkCancel({ sessionId: optionalStringField(input, "session") ?? currentSession.id }),
    },
    {
      name: "secrets_status",
      description: "Return secret profile references, sources, and expiration metadata without revealing credential values.",
      inputSchema: objectSchema({ name: { type: "string", description: "Secret profile name." } }, ["name"]),
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => relay.authStatus({ name: requiredStringField(input, "name") }),
    },
    {
      name: "secrets_refresh",
      description: "Reload a session page, observe fresh credentials, and update a secret profile while preserving stable BC_SECRET_N references.",
      inputSchema: objectSchema({
        name: { type: "string", description: "Existing secret profile name." },
        session: { type: "string", description: "Optional session id. Defaults to this MCP server's current session." },
        urlFilter: { type: "string", description: "Observe credentials only on matching request URLs." },
        timeoutMs: { type: "integer", minimum: 1, description: "Reload timeout. Defaults to 30000." },
      }, ["name"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        const urlFilter = optionalStringField(object, "urlFilter")
        return relay.authRefresh({
          sessionId: optionalStringField(object, "session") ?? currentSession.id,
          name: requiredStringField(object, "name"),
          ...(urlFilter ? { urlFilter } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      },
    },
    {
      name: "secrets_run",
      description: "Run a local command with a captured profile injected as BC_SECRET_N environment variables. Known values are replaced with their references in stdout and stderr.",
      inputSchema: objectSchema({
        name: { type: "string", description: "Secret profile name." },
        command: { type: "string", description: "Executable path or command name." },
        args: { type: "array", items: { type: "string" }, description: "Command arguments." },
        cwd: { type: "string", description: "Optional child working directory." },
        timeoutMs: { type: "integer", minimum: 1, description: "Child timeout. Defaults to 120000." },
      }, ["name", "command"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const args = optionalStringArrayField(object, "args")
        const cwd = optionalStringField(object, "cwd")
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        return relay.authRun({
          name: requiredStringField(object, "name"),
          command: requiredStringField(object, "command"),
          ...(args ? { args } : {}),
          cwd: path.resolve(cwd ?? process.cwd()),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      },
    },
    {
      name: "skill",
      description: "Return the Browser Control agent skill instructions.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () => Effect.tryPromise({
        try: () => fs.readFile(path.join(packageRoot, "skills", "browser-control", "SKILL.md"), "utf8"),
        catch: (cause) => new Error("read browser-control skill", { cause }),
      }),
    },
  ]
}

const relayLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const relay = yield* RelayClient.Service
    const readiness = yield* RelayLifecycle.ensureRelay({ relay })
    if (readiness.buildProblem) {
      return yield* Effect.fail(new Error(readiness.buildProblem))
    }
  }),
)

const registerTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer
  const relay = yield* RelayClient.Service
  const configuredSession = Option.getOrUndefined(yield* Config.option(Config.string("BROWSER_CONTROL_SESSION")))
  const currentSession: CurrentSession = {
    id: configuredSession || `mcp-${crypto.randomUUID().slice(0, 8)}`,
    established: Boolean(configuredSession),
  }
  yield* Effect.forEach(makeToolSpecs(relay, currentSession), (spec) => {
    return server.addTool({
      tool: new McpSchema.Tool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          idempotentHint: spec.idempotent,
          openWorldHint: true,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) => {
        return spec.handle(payload).pipe(
          Effect.match({
            onFailure: (error) => toolResult({ text: mcpErrorMessage(spec.name, error.message), isError: true }),
            onSuccess: (value) => toolResultForValue(value),
          }),
        )
      },
    })
  }, { discard: true })
})

export const runMcpServer: Effect.Effect<never, Error> = Layer.launch(
  Layer.mergeAll(
    relayLayer,
    Layer.effectDiscard(registerTools),
  ).pipe(
    Layer.provide(McpServer.layerStdio({ name: "browser-control", version: browserControlVersion })),
    Layer.provide(NodeStdio.layer),
    Layer.provide(RelayClient.layerFetch),
  ),
)

const ensureSessionExists = Effect.fnUntraced(function* (relay: RelayClient.Interface, id: string) {
  const sessions = yield* relay.sessions
  const exists = sessions.some((session) => {
    return session.id === id
  })
  if (!exists) {
    return yield* Effect.fail(new Error(`Session not found: ${id}`))
  }
})

function parseExecuteArguments(input: unknown): ExecuteArguments {
  const object = requireObject(input)
  const code = requiredStringField(object, "code")
  const session = optionalStringField(object, "session")
  const targetSelection = parseMcpTargetSelection(object)
  return {
    code,
    ...(session ? { session } : {}),
    ...(targetSelection.urlIncludes ? { targetUrl: targetSelection.urlIncludes } : {}),
    ...(targetSelection.index !== undefined ? { targetIndex: targetSelection.index } : {}),
  }
}

function parseAdoptArguments(input: unknown): AdoptArguments {
  const object = requireObject(input)
  const session = optionalStringField(object, "session")
  const targetSelection = parseMcpTargetSelection(object)
  if (!targetSelection.urlIncludes && targetSelection.index === undefined) {
    throw new Error("session_adopt requires targetUrl or targetIndex")
  }
  return {
    ...(session ? { session } : {}),
    ...(targetSelection.urlIncludes ? { targetUrl: targetSelection.urlIncludes } : {}),
    ...(targetSelection.index !== undefined ? { targetIndex: targetSelection.index } : {}),
  }
}

function parseMcpTargetSelection(input: JsonObject) {
  const urlIncludes = optionalStringField(input, "targetUrl")
  return parseTargetSelection({
    ...(urlIncludes ? { urlIncludes } : {}),
    ...(input.targetIndex === undefined ? {} : { index: input.targetIndex }),
  }) ?? {}
}

function requiredStringField(input: unknown, field: string): string {
  const object = requireObject(input)
  const value = object[field]
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} is required`)
  }
  return value
}

function optionalStringField(input: unknown, field: string): string | undefined {
  const object = requireObject(input)
  const value = object[field]
  return typeof value === "string" && value ? value : undefined
}

function optionalBooleanField(input: unknown, field: string): boolean | undefined {
  const object = requireObject(input)
  const value = object[field]
  return typeof value === "boolean" ? value : undefined
}

function optionalPositiveIntegerField(input: unknown, field: string): number | undefined {
  const object = requireObject(input)
  const value = object[field]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function optionalStringArrayField(input: unknown, field: string): readonly string[] | undefined {
  const object = requireObject(input)
  const value = object[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${field} must be an array of non-empty strings`)
    }
    strings.push(item)
  }
  return strings
}

function requireObject(input: unknown): JsonObject {
  const object = getObject(input)
  if (!object) {
    throw new Error("Expected arguments object")
  }
  return object
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  return JSON.stringify(value, null, 2)
}

export function toolResultForValue(value: unknown): McpSchema.CallToolResult {
  const object = getObject(value)
  const isError = object?.isError === true
  const media = Array.isArray(object?.media)
    ? object.media.flatMap((item) => {
      const image = getObject(item)
      return image?.type === "image" && typeof image.mimeType === "string" && typeof image.data === "string"
        ? [{ data: image.data, mimeType: image.mimeType }]
        : []
    })
    : []
  if (media.length > 0) {
    const { media: _media, ...structuredContent } = object ?? {}
    const text = isError && typeof object?.text === "string" ? object.text : stringifyResult(structuredContent)
    return new McpSchema.CallToolResult({
      content: [
        McpSchema.TextContent.make({ text }),
        ...media.map((image) => McpSchema.ImageContent.make({
          data: new Uint8Array(Buffer.from(image.data, "base64")),
          mimeType: image.mimeType,
        })),
      ],
      structuredContent,
      isError,
    })
  }
  const text = isError && typeof object?.text === "string" ? object.text : stringifyResult(value)
  return toolResult({ text, ...(object ? { structuredContent: object } : {}), isError })
}

export function mcpErrorMessage(tool: string, message: string): string {
  if (!message.startsWith("Session not found:")) {
    return message
  }
  return tool === "execute" || tool === "session_adopt"
    ? `${message} Create it with session_new first, or omit the explicit session id to use the MCP current session.`
    : `${message} Create it with session_new first.`
}

function toolResult(options: { readonly text: string; readonly structuredContent?: unknown; readonly isError: boolean }): McpSchema.CallToolResult {
  return new McpSchema.CallToolResult({
    content: [McpSchema.TextContent.make({ text: options.text })],
    structuredContent: options.structuredContent,
    isError: options.isError,
  })
}

function objectSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  }
}
