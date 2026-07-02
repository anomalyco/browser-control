import { NodeStdio } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { McpSchema, McpServer } from "effect/unstable/ai"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { getObject } from "./relay-helpers.ts"
import * as RelayClient from "./relay-client.ts"
import { startRelay } from "./relay.ts"
import { browserControlVersion } from "./version.ts"

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const currentSession = { id: process.env.BROWSER_CONTROL_SESSION || `mcp-${crypto.randomUUID().slice(0, 8)}` }

type JsonObject = Record<string, unknown>

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

const emptyInputSchema = objectSchema({})

function makeToolSpecs(relay: RelayClient.Interface): readonly ToolSpec[] {
  return [
    {
      name: "execute",
      description: "Execute trusted Playwright JavaScript against the Browser Control session. The result includes console logs, warnings, and an aftermath summary (URL movement, navigations, error counts, handoffs).",
      inputSchema: objectSchema({
        code: { type: "string", description: "JavaScript code to execute. It receives browser, context, page, state, modules, fillInput, fillInputs, screenshotWithLabels, ghostCursor (show/hide), and handoff(message, { timeoutMs }) which pauses until the user clicks the Browser Control toolbar button." },
        session: { type: "string", description: "Optional existing Browser Control session id. Defaults to this MCP server's current session, which may be created if missing." },
        targetUrl: { type: "string", description: "Optional attached page URL substring selector." },
        targetIndex: { type: "integer", minimum: 0, description: "Optional zero-based attached page index selector." },
      }, ["code"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const args = yield* Effect.try(() => parseExecuteArguments(input))
        const sessionId = args.session ?? currentSession.id
        const result = yield* relay.execute({
          sessionId,
          code: args.code,
          createIfMissing: !args.session,
          targetSelection: {
            ...(args.targetUrl ? { urlIncludes: args.targetUrl } : {}),
            ...(args.targetIndex !== undefined ? { index: args.targetIndex } : {}),
          },
        })
        currentSession.id = sessionId
        return result
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
        }
        return { ...result, currentSession: currentSession.id }
      }),
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

/**
 * Embedded relay: start one in-process. If the port is already taken, probe
 * `/version` through RelayClient to confirm a Browser Control relay is
 * actually serving there before assuming it is safe to proceed.
 */
const relayLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const relay = yield* RelayClient.Service
    const port = yield* Effect.orDie(RelayClient.portConfig)
    yield* startRelay({ port }).pipe(
      Effect.catch((error) => {
        if (isAddressInUse(error)) {
          return relay.version.pipe(
            Effect.mapError(() =>
              new Error(`Port ${port} is in use but does not answer like a Browser Control relay; stop the other process or set BROWSER_CONTROL_PORT`)
            ),
          )
        }
        return Effect.fail(error)
      }),
    )
  }),
)

const registerTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer
  const relay = yield* RelayClient.Service
  yield* Effect.forEach(makeToolSpecs(relay), (spec) => {
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
            onFailure: (error) => toolResult({ text: error.stack ?? error.message, isError: true }),
            onSuccess: (value) => toolResult({ text: stringifyResult(value), structuredContent: value, isError: false }),
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
  const targetUrl = optionalStringField(object, "targetUrl")
  const targetIndex = optionalNumberField(object, "targetIndex")
  if (targetUrl && targetIndex !== undefined) {
    throw new Error("Use only one target selector: targetUrl or targetIndex")
  }
  if (targetIndex !== undefined && (!Number.isInteger(targetIndex) || targetIndex < 0)) {
    throw new Error("targetIndex must be a non-negative integer")
  }
  return {
    code,
    ...(session ? { session } : {}),
    ...(targetUrl ? { targetUrl } : {}),
    ...(targetIndex !== undefined ? { targetIndex } : {}),
  }
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

function optionalNumberField(input: unknown, field: string): number | undefined {
  const object = requireObject(input)
  const value = object[field]
  return typeof value === "number" ? value : undefined
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
    required,
    additionalProperties: false,
  }
}

function isAddressInUse(error: Error): boolean {
  const nodeError = error as NodeJS.ErrnoException
  const cause = error.cause as NodeJS.ErrnoException | undefined
  return nodeError.code === "EADDRINUSE" || cause?.code === "EADDRINUSE"
}
