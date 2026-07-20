import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AuthenticatedOriginInternal from "./authenticated-origin.ts"
import * as RelayClient from "./relay-client.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"
import type {
  AuthenticatedJsonMethod,
  AuthenticatedJsonOutcome,
  SessionSummary,
} from "./relay-schema.ts"

export type Json = Schema.Schema.Type<typeof Schema.Json>

export class ClientError extends Schema.TaggedErrorClass<ClientError>()(
  "BrowserControlClient.Error",
  {
    message: Schema.String,
    reason: Schema.Literals(["connect", "session", "invalid-request"]),
    code: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.Number),
  },
) {}

export class OriginMismatch extends Schema.TaggedErrorClass<OriginMismatch>()(
  "AuthenticatedOrigin.OriginMismatch",
  {
    expectedOrigin: Schema.String,
    actualOrigin: Schema.String,
    message: Schema.String,
  },
) {}

export class HttpError extends Schema.TaggedErrorClass<HttpError>()(
  "AuthenticatedOrigin.HttpError",
  {
    status: Schema.Number,
    method: Schema.String,
    message: Schema.String,
  },
) {}

export class RequestFailed extends Schema.TaggedErrorClass<RequestFailed>()(
  "AuthenticatedOrigin.RequestFailed",
  {
    method: Schema.String,
    message: Schema.String,
  },
) {}

export class RequestOutcomeUnknown extends Schema.TaggedErrorClass<RequestOutcomeUnknown>()(
  "AuthenticatedOrigin.RequestOutcomeUnknown",
  {
    method: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidResponse extends Schema.TaggedErrorClass<InvalidResponse>()(
  "AuthenticatedOrigin.InvalidResponse",
  {
    reason: Schema.Literals(["invalid-json", "too-large"]),
    status: Schema.Number,
    maxResponseBytes: Schema.optionalKey(Schema.Number),
    message: Schema.String,
  },
) {}

export class ResponseDecodeFailed extends Schema.TaggedErrorClass<ResponseDecodeFailed>()(
  "AuthenticatedOrigin.ResponseDecodeFailed",
  {
    message: Schema.String,
  },
) {}

export class SensitiveCaptureActive extends Schema.TaggedErrorClass<SensitiveCaptureActive>()(
  "AuthenticatedOrigin.SensitiveCaptureActive",
  {
    message: Schema.String,
  },
) {}

export type Error =
  | ClientError
  | OriginMismatch
  | HttpError
  | RequestFailed
  | RequestOutcomeUnknown
  | InvalidResponse
  | ResponseDecodeFailed
  | SensitiveCaptureActive

export interface JsonOptions<S extends Schema.Top> {
  readonly path: `/${string}`
  readonly method?: AuthenticatedJsonMethod
  readonly body?: Json
  readonly response: S
  readonly sensitive?: boolean
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

export interface AuthenticatedOrigin {
  readonly origin: string
  readonly json: {
    <S extends Schema.Top>(
      options: JsonOptions<S> & { readonly sensitive: true },
    ): Effect.Effect<Redacted.Redacted<S["Type"]>, Error, S["DecodingServices"]>
    <S extends Schema.Top>(
      options: JsonOptions<S> & { readonly sensitive?: false },
    ): Effect.Effect<S["Type"], Error, S["DecodingServices"]>
  }
}

/** Reveal a sensitive response using Browser Control's Effect runtime. */
export const reveal = <A>(value: Redacted.Redacted<A>): A => Redacted.value(value)

export interface AuthenticatedOriginOptions {
  readonly origin: string
  /** Explicitly navigate here when the session page is not already on `origin`. */
  readonly startUrl?: string
}

export interface Session {
  readonly id: string
  readonly summary: SessionSummary
  readonly authenticatedOrigin: (
    options: AuthenticatedOriginOptions,
  ) => Effect.Effect<AuthenticatedOrigin, ClientError>
}

export interface EnsureSessionOptions {
  readonly id: string
  readonly readOnly?: boolean
}

export interface Interface {
  readonly ensureSession: (
    options: EnsureSessionOptions,
  ) => Effect.Effect<Session, ClientError>
  readonly resetSession: (id: string) => Effect.Effect<Session, ClientError>
}

export interface MakeOptions {
  readonly endpoint?: string
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode-ai/browser-control/BrowserControlClient",
) {}

export const make = Effect.fn("BrowserControlClient.make")(function* (options: MakeOptions = {}) {
  const relay = yield* RelayClient.make(options).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((error) => clientError("connect", error)),
  )
  const readiness = yield* RelayLifecycle.ensureRelay({
    relay,
    // The consumer may run under Bun; the relay is a Node application.
    start: RelayLifecycle.startManagedRelay(fileURLToPath(import.meta.url), "node", []),
  }).pipe(Effect.mapError((error) => clientError("connect", error)))
  if (readiness.buildProblem) {
    return yield* Effect.fail(new ClientError({
      message: readiness.buildProblem,
      reason: "connect",
    }))
  }
  yield* RelayLifecycle.ensureExtensionConnected({
    relay,
    waitForReconnect: readiness.started,
  }).pipe(Effect.mapError((error) => clientError("connect", error)))

  const ensureSession = Effect.fn("BrowserControlClient.ensureSession")(function* (
    sessionOptions: EnsureSessionOptions,
  ) {
    const summary = yield* relay.sessionEnsure(sessionOptions.id, {
      ...(sessionOptions.readOnly === undefined ? {} : { readOnly: sessionOptions.readOnly }),
    }).pipe(Effect.mapError((error) => clientError("session", error)))
    return makeSession(relay, summary)
  })

  const resetSession = Effect.fn("BrowserControlClient.resetSession")(function* (id: string) {
    const summary = yield* relay.sessionReset(id).pipe(
      Effect.mapError((error) => clientError("session", error)),
    )
    return makeSession(relay, summary)
  })

  return Service.of({ ensureSession, resetSession })
})

export const layer = (options: MakeOptions = {}): Layer.Layer<Service, ClientError> =>
  Layer.effect(Service, make(options))

function makeSession(relay: RelayClient.Interface, summary: SessionSummary): Session {
  return {
    id: summary.id,
    summary,
    authenticatedOrigin: (options) => Effect.try({
      try: () => makeAuthenticatedOrigin(relay, summary.id, options),
      catch: (cause) => cause instanceof ClientError
        ? cause
        : new ClientError({
            message: cause instanceof globalThis.Error ? cause.message : "Invalid authenticated origin",
            reason: "invalid-request",
          }),
    }),
  }
}

function makeAuthenticatedOrigin(
  relay: RelayClient.Interface,
  sessionId: string,
  options: AuthenticatedOriginOptions,
): AuthenticatedOrigin {
  const origin = AuthenticatedOriginInternal.normalizeOrigin(options.origin)
  const startUrl = options.startUrl === undefined ? undefined : new URL(options.startUrl, origin)
  if (startUrl && startUrl.origin !== origin) {
    throw new ClientError({
      message: `Authenticated origin startUrl must stay on ${origin}`,
      reason: "invalid-request",
    })
  }

  function json<S extends Schema.Top>(
    request: JsonOptions<S> & { readonly sensitive: true },
  ): Effect.Effect<Redacted.Redacted<S["Type"]>, Error, S["DecodingServices"]>
  function json<S extends Schema.Top>(
    request: JsonOptions<S> & { readonly sensitive?: false },
  ): Effect.Effect<S["Type"], Error, S["DecodingServices"]>
  function json<S extends Schema.Top>(
    request: JsonOptions<S>,
  ): Effect.Effect<S["Type"] | Redacted.Redacted<S["Type"]>, Error, S["DecodingServices"]> {
    const method = request.method ?? "GET"
    if (method === "GET" && request.body !== undefined) {
      return Effect.fail(new ClientError({
        message: "GET authenticated origin requests cannot include a body",
        reason: "invalid-request",
      }))
    }
    const mutation = method !== "GET"
    return relay.authenticatedJson({
      sessionId,
      origin,
      ...(startUrl ? { startUrl: startUrl.toString() } : {}),
      method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.sensitive === true ? { sensitive: true } : {}),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.maxResponseBytes === undefined ? {} : { maxResponseBytes: request.maxResponseBytes }),
    }).pipe(
      Effect.mapError((error): Error => mutation && (
          error instanceof RelayClient.RelayUnreachable || error instanceof RelayClient.RelayDecodeFailed
        )
        ? unknownOutcome(method)
        : clientError("session", error)),
      Effect.flatMap((outcome) => decodeOutcome(outcome, method, mutation, request)),
    )
  }

  return { origin, json }
}

function decodeOutcome<S extends Schema.Top>(
  outcome: AuthenticatedJsonOutcome,
  method: AuthenticatedJsonMethod,
  mutation: boolean,
  request: JsonOptions<S>,
): Effect.Effect<S["Type"] | Redacted.Redacted<S["Type"]>, Error, S["DecodingServices"]> {
  switch (outcome._tag) {
    case "Success": {
      if (request.sensitive === true) {
        return Schema.decodeUnknownEffect(Schema.RedactedFromValue(request.response, {
          label: "Browser Control authenticated response",
          disallowEncode: true,
        }))(outcome.value).pipe(
          Effect.mapError(() => mutation
            ? unknownOutcome(method)
            : new ResponseDecodeFailed({ message: "Sensitive authenticated response did not match the expected schema" })),
        )
      }
      return Schema.decodeUnknownEffect(request.response)(outcome.value).pipe(
        Effect.mapError((cause) => mutation
          ? unknownOutcome(method)
          : new ResponseDecodeFailed({ message: `Authenticated response did not match the expected schema: ${cause.message}` })),
      )
    }
    case "OriginMismatch":
      return Effect.fail(new OriginMismatch({
        expectedOrigin: outcome.expectedOrigin,
        actualOrigin: outcome.actualOrigin,
        message: `Session page origin ${outcome.actualOrigin} does not match ${outcome.expectedOrigin}`,
      }))
    case "HttpError":
      return Effect.fail(new HttpError({
        status: outcome.status,
        method,
        message: `Authenticated ${method} request was rejected with HTTP ${outcome.status}`,
      }))
    case "RequestFailed":
      return Effect.fail(mutation || outcome.outcome === "unknown"
        ? unknownOutcome(method)
        : new RequestFailed({ method, message: `Authenticated ${method} request failed before it was sent` }))
    case "InvalidJson":
      return Effect.fail(mutation
        ? unknownOutcome(method)
        : new InvalidResponse({
            reason: "invalid-json",
            status: outcome.status,
            message: "Authenticated response was not valid JSON",
          }))
    case "ResponseTooLarge":
      return Effect.fail(mutation
        ? unknownOutcome(method)
        : new InvalidResponse({
            reason: "too-large",
            status: outcome.status,
            maxResponseBytes: outcome.maxResponseBytes,
            message: `Authenticated response exceeded ${outcome.maxResponseBytes} bytes`,
          }))
    case "SensitiveCaptureActive":
      return Effect.fail(new SensitiveCaptureActive({
        message: "Sensitive authenticated requests are blocked while session network capture is active",
      }))
  }
}

function unknownOutcome(method: AuthenticatedJsonMethod): RequestOutcomeUnknown {
  return new RequestOutcomeUnknown({
    method,
    message: `Authenticated ${method} request outcome is unknown; reconcile state before retrying`,
  })
}

function clientError(reason: ClientError["reason"], error: unknown): ClientError {
  if (error instanceof ClientError) return error
  if (error instanceof RelayClient.RelayRejected) {
    return new ClientError({
      message: error.message,
      reason,
      status: error.status,
      ...(error.code ? { code: error.code } : {}),
    })
  }
  return new ClientError({
    message: error instanceof globalThis.Error ? error.message : "Browser Control request failed",
    reason,
  })
}

export * as BrowserControlClient from "./browser-control-client.ts"
export * as AuthenticatedOrigin from "./browser-control-client.ts"
