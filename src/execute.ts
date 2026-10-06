import { Effect, Predicate, Schema } from "effect"
import { installPageReadTimeout } from "./page-read-timeout.ts"
import { chromium, errors, type Browser, type BrowserContext, type ConsoleMessage, type ElementHandle, type Frame, type Locator, type Page } from "playwright-core"
import * as acorn from "acorn"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import url from "node:url"
import util from "node:util"
import events from "node:events"
import stream from "node:stream"
import buffer from "node:buffer"
import http from "node:http"
import https from "node:https"
import zlib from "node:zlib"
import {
  clearGhostCursorCallouts,
  hideGhostCursor as hideGhostCursorOnPage,
  setGhostCursorCaption,
  setGhostCursorSpotlight,
  showGhostCursor as showGhostCursorOnPage,
  showGhostCursorCallout,
  showGhostCursorKeys,
  zoomGhostCursorCamera,
  type GhostCursorCalloutOptions,
  type GhostCursorCaptionOptions,
  type GhostCursorClientOptions,
  type GhostCursorSpotlightOptions,
  type GhostCursorZoomOptions,
} from "./ghost-cursor.ts"
import type { HandoffOutcome } from "./handoff.ts"
import * as AuthProfile from "./auth-profile.ts"
import * as AuthenticatedOrigin from "./authenticated-origin.ts"
import * as NetworkCapture from "./network-capture.ts"
import { AuthenticatedJsonOutcome, type AuthenticatedJsonRequest, type ExecuteAftermath, type ExecuteLogEntry, type ExecuteLogSummary, type ExecuteMedia } from "./relay-schema.ts"
import type { SessionTarget } from "./relay-types.ts"
import { executionContextFailureDiagnostic, runtimeFailureKind } from "./runtime-diagnostics.ts"
import { ariaSnapshotWithoutTextControlValues, registerAriaSnapshotSelector } from "./aria-snapshot.ts"
import { createScreenshotDiff, type ScreenshotDiffOptions, type ScreenshotDiffResult } from "./screenshot-diff.ts"
import { createWebMcpHelper, type WebMcpHelper } from "./webmcp.ts"
import { startDemonstrationRecorder, type DemonstrationResult } from "./demonstration.ts"

const nodeModules = { fs, path, os, crypto, url, util, events, stream, buffer, http, https, zlib }
const nodeModuleAliases = Object.keys(nodeModules).join(", ")

const playwrightCloseTimeoutMs = 2_000
const playwrightConnectTimeoutMs = 15_000
// CdpRuntime can spend two 3s observation windows replaying shared contexts.
// Leave room for that healthy reconnect path while bounding adopted setup.
const adoptedPageConnectTimeoutMs = 8_000
const sessionPageHealthCheckTimeoutMs = 3_000
const sessionPageHealthRetryDelayMs = 100
const handoffPageContextTimeoutMs = 15_000
const timedOut = Symbol("timed-out")
export const downloadCapabilityErrorMessage = "Downloads are unavailable in Browser Control extension-backed tabs: Chromium blocks Browser.setDownloadBehavior and Page.setDownloadBehavior through chrome.debugger, so Playwright cannot retain an artifact for download.saveAs(). Fetch the response in the page and write the returned bytes with fs when the site exposes them."
const downloadGuardedPages = new WeakSet<Page>()
const downloadGuardedContexts = new WeakSet<BrowserContext>()
const viewportZoomGuardedPages = new WeakSet<Page>()

class PlaywrightOperationError extends Schema.TaggedError<PlaywrightOperationError>()(
  "Execute.PlaywrightOperationError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["failed", "timeout"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

class SessionPageRecoveryError extends Schema.TaggedError<SessionPageRecoveryError>()(
  "Execute.SessionPageRecoveryError",
  {
    message: Schema.String,
    reason: Schema.Literals(["adopted-unresponsive", "adopted-initialization-timeout", "owned-unresponsive", "close-failed", "target-unavailable"]),
    cause: Schema.Defect(),
  },
) {}

/** Internal signal: the relay-owned page is alive but Playwright's view of it is stale; reconnect before retrying. */
class SessionPageRepairRequired extends Error {
  constructor() {
    super("Session page repair required")
  }
}

const unresponsivePageDiagnosis = (options: { readonly ownsPage: boolean; readonly repaired: boolean }): string => [
  `The ${options.ownsPage ? "relay-owned" : "adopted"} session page is unresponsive: the tab is open but its execution context did not answer automation within the health-check budget`,
  options.repaired ? " even after reconnecting to the relay" : "",
  ". The tab was kept and was not replaced. This usually means the page is mid-navigation or its main world is stalled for automation (for example, bot protection). ",
  "Retry after the page settles, navigate the tab with page.goto(), open a fresh tab with context.newPage(), or release it with `browser-control session reset`.",
].join("")

export class TargetSelectionError extends Schema.TaggedError<TargetSelectionError>()(
  "Execute.TargetSelectionError",
  {
    message: Schema.String,
    reason: Schema.Literals(["invalid", "not-found", "ambiguous"]),
  },
) {}

export const runPlaywrightOperation = Effect.fn("Execute.playwrightOperation")(<A>(options: {
  readonly label: string
  readonly timeoutMs: number
  readonly run: () => Promise<A>
}): Effect.Effect<A, Error> => Effect.tryPromise({
    try: options.run,
    catch: (cause) => new PlaywrightOperationError({
      message: cause instanceof Error ? cause.message : options.label,
      operation: options.label,
      reason: "failed",
      cause,
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () => Effect.fail(new PlaywrightOperationError({
        message: `${options.label} timed out after ${options.timeoutMs}ms`,
        operation: options.label,
        reason: "timeout",
      })),
    }),
  )
)

const runSettledPlaywrightOperation = Effect.fn("Execute.settledPlaywrightOperation")(<A>(options: {
  readonly label: string
  readonly run: () => Promise<A>
}): Effect.Effect<A, Error> => Effect.tryPromise({
  try: options.run,
  catch: (cause) => new PlaywrightOperationError({
    message: cause instanceof Error ? cause.message : options.label,
    operation: options.label,
    reason: "failed",
    cause,
  }),
}))

/**
 * Decide what to do with a default page that failed or needs a health check.
 *
 * Only a relay-owned page with nothing left to lose (a crashed renderer,
 * `about:blank`, or a `chrome-error://` document) is closed and recreated. Any
 * other live page is kept: an unresponsive execution context is a symptom of
 * Playwright's stale view of the tab or of the page itself, not proof that the
 * tab is gone, and the tab may hold login or form state the user produced.
 */
export const recoverSessionPage = Effect.fn("Execute.recoverSessionPage")(function* (options: {
  readonly ownsPage: boolean
  readonly url: string
  readonly timeoutMs: number
  readonly healthCheck: () => Promise<void>
  readonly close: () => Promise<void>
  readonly crashed?: boolean
  readonly repaired?: boolean
}) {
  const healthFailure = yield* runPlaywrightOperation({
    label: "Session page health check",
    timeoutMs: options.timeoutMs,
    run: options.healthCheck,
  }).pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )
  if (!healthFailure) {
    return "use" as const
  }
  if (!options.ownsPage) {
    return yield* new SessionPageRecoveryError({
      message: unresponsivePageDiagnosis({ ownsPage: false, repaired: options.repaired === true }),
      reason: "adopted-unresponsive",
      cause: healthFailure,
    })
  }
  if (!isDisposableSessionPage(options)) {
    if (options.repaired) {
      return yield* new SessionPageRecoveryError({
        message: unresponsivePageDiagnosis({ ownsPage: true, repaired: true }),
        reason: "owned-unresponsive",
        cause: healthFailure,
      })
    }
    return "repair" as const
  }
  const closeFailure = yield* runPlaywrightOperation({
    label: "Close unhealthy session page",
    timeoutMs: options.timeoutMs,
    run: options.close,
  }).pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )
  if (closeFailure) {
    return yield* new SessionPageRecoveryError({
      message: "The unhealthy relay-owned session page could not be closed. Run `browser-control session reset` before continuing.",
      reason: "close-failed",
      cause: closeFailure,
    })
  }
  return "recreate" as const
})

/** A relay-owned page whose document holds no user-produced state worth preserving. */
export function isDisposableSessionPage(options: { readonly url: string; readonly crashed?: boolean }): boolean {
  // Blank documents can hold setContent output, forms, and opener-written state.
  // An unknown URL is not evidence that the document is safe to discard either.
  return options.crashed === true || options.url.startsWith("chrome-error://")
}

export async function waitForPageContext(options: {
  readonly evaluate: () => Promise<void>
  readonly timeoutMs: number
  readonly retryDelayMs?: number
  readonly delay?: (milliseconds: number) => Promise<void>
}): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? sessionPageHealthRetryDelayMs
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    try {
      const result = await withTimeout(options.evaluate(), remainingMs)
      if (result === timedOut) break
      return
    } catch (error) {
      lastError = error
      const kind = runtimeFailureKind(error)
      if (kind !== "context-destroyed" && kind !== "context-missing") throw error
      const retryInMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()))
      if (retryInMs > 0) await (options.delay ?? delay)(retryInMs)
    }
  }
  throw lastError ?? new Error(`Execution context not available: it did not become available within ${options.timeoutMs}ms`)
}

export async function finishHandoff(options: {
  readonly outcome: HandoffOutcome
  readonly message: string
  readonly timeoutMs: number
  readonly evaluate: () => Promise<void>
  readonly contextTimeoutMs?: number
  readonly retryDelayMs?: number
  readonly delay?: (milliseconds: number) => Promise<void>
}): Promise<void> {
  if (options.outcome === "timeout") {
    throw new Error(`Handoff timed out after ${options.timeoutMs}ms waiting for the user: ${options.message}`)
  }
  if (options.outcome !== "resolved") {
    const targetEvent = options.outcome.reason === "target-crashed" ? "crashed" : "detached"
    throw new Error(`Handoff cancelled because its target ${targetEvent}: ${options.message}`)
  }
  const contextTimeoutMs = options.contextTimeoutMs ?? sessionPageHealthCheckTimeoutMs
  try {
    await waitForPageContext({
      evaluate: options.evaluate,
      timeoutMs: contextTimeoutMs,
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    })
  } catch (error) {
    const kind = runtimeFailureKind(error)
    if (kind !== "context-destroyed" && kind !== "context-missing") throw error
    // The user finished the handoff; only Browser Control's view of the page is stale. Keep that
    // distinction visible and let the next execute health-check and repair the same tab.
    throw new Error(
      `Handoff resolved (${options.message}), but the page execution context did not become available within ${contextTimeoutMs}ms: ${error instanceof Error ? error.message : String(error)}. The tab was kept; run a short follow-up execute so Browser Control can re-check it.`,
      { cause: error },
    )
  }
}

export function isSessionPageConnected(options: {
  readonly browserConnected: boolean
  readonly pageUrl: string | null
  readonly healthCheckRequired: boolean
}): boolean {
  return options.browserConnected && options.pageUrl !== null && !options.healthCheckRequired
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof timedOut> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(timedOut), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

type SandboxGlobals = {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly state: Record<string, unknown>
  readonly modules: typeof nodeModules
  readonly fillInput: (target: InputTarget, value: string) => Promise<void>
  readonly fillInputs: (page: Page, fields: ReadonlyArray<InputField>) => Promise<void>
  readonly screenshotWithLabels: (options?: ScreenshotWithLabelsOptions) => Promise<ScreenshotWithLabelsResult>
  readonly screenshotDiff: (options: ScreenshotDiffOptions) => Promise<ScreenshotDiffResult>
  readonly ariaSnapshot: AriaSnapshotHelper
  readonly snapshot: SnapshotHelper
  readonly ref: SnapshotRefHelper
  readonly webmcp: WebMcpHelper
  readonly showGhostCursor: (options?: ShowGhostCursorOptions) => Promise<void>
  readonly hideGhostCursor: (options?: HideGhostCursorOptions) => Promise<void>
  readonly ghostCursor: {
    readonly show: (options?: ShowGhostCursorOptions) => Promise<void>
    readonly hide: (options?: HideGhostCursorOptions) => Promise<void>
    readonly caption: (title: string | null, options?: GhostCursorCaptionOptions & { readonly page?: Page }) => Promise<void>
    readonly clearCaption: (options?: { readonly page?: Page }) => Promise<void>
    readonly callout: (target: Locator | string, label: string, options?: GhostCursorCalloutOptions & { readonly page?: Page }) => Promise<void>
    readonly clearCallouts: (options?: { readonly page?: Page }) => Promise<void>
    readonly zoom: (target: Locator | string | { readonly x: number; readonly y: number } | null, options?: GhostCursorZoomOptions & { readonly page?: Page }) => Promise<void>
    readonly resetZoom: (options?: { readonly durationMs?: number; readonly page?: Page }) => Promise<void>
    readonly spotlight: (target: Locator | string | null, options?: GhostCursorSpotlightOptions & { readonly page?: Page }) => Promise<void>
    readonly clearSpotlight: (options?: { readonly page?: Page }) => Promise<void>
    readonly keys: (keys: string | readonly string[], label?: string, options?: { readonly page?: Page }) => Promise<void>
  }
  readonly handoff: (message?: string, options?: HandoffCallOptions) => Promise<void>
  readonly demonstrate: (message?: string, options?: HandoffCallOptions) => Promise<DemonstrationResult>
  readonly network: {
    readonly start: (options?: NetworkCapture.NetworkCaptureOptions) => Promise<NetworkCapture.NetworkCaptureStatus>
    readonly status: () => NetworkCapture.NetworkCaptureStatus
    readonly stop: (options?: NetworkCapture.NetworkCaptureStopOptions) => Promise<NetworkCapture.NetworkCaptureResult>
    readonly cancel: () => Promise<{ readonly cancelled: boolean }>
  }
  readonly handoffTracker: { count: number }
}

type HandoffCallOptions = {
  readonly timeoutMs?: number
  readonly page?: Page
  readonly start?: () => unknown | Promise<unknown>
}

export type HandoffPageTarget = {
  readonly targetId: string
}

export type RequestHandoff = (options: {
  readonly message: string
  readonly timeoutMs: number
  readonly target: HandoffPageTarget
  readonly start?: () => unknown | Promise<unknown>
  readonly cancelStart?: () => Promise<void>
}) => Promise<HandoffOutcome>

const defaultHandoffTimeoutMs = 10 * 60 * 1_000

const defaultHandoffMessage = "Complete the requested task, then use the in-page continue control."

type AriaSnapshotTarget = Locator | string

type AriaSnapshotOptions = {
  readonly timeout?: number
}

type AriaSnapshotHelper = (target?: AriaSnapshotTarget, options?: AriaSnapshotOptions) => Promise<string>

type SnapshotOptions = {
  readonly within?: AriaSnapshotTarget
  readonly interactive?: boolean
  readonly compact?: boolean
  readonly diff?: boolean
  readonly delta?: boolean
  readonly find?: string | RegExp
  readonly context?: number
  readonly depth?: number
  readonly maxItems?: number
  readonly timeout?: number
}

type SnapshotHelper = (options?: SnapshotOptions) => Promise<string>
type SnapshotRefHelper = (id: string) => Locator

type SnapshotEntry = {
  readonly depth: number
  readonly baseDepth?: number
  readonly key?: string
  readonly parentKeys?: readonly string[]
  readonly role: string
  readonly name: string
  readonly identityName?: string
  readonly details?: string
  readonly selector?: string
  readonly priority: number
}

type SnapshotRefRegistry = {
  page?: Page
  url?: string
  selectors: Map<string, { readonly selector: string; readonly role: string; readonly name?: string }>
  previousSnapshot?: SnapshotBaseline
  nextRef?: number
  locatorScopes?: WeakMap<Locator, number>
  nextLocatorScope?: number
  removeNavigationListener?: () => void
}

type SnapshotRenderedEntry = {
  readonly prefix: string
  readonly details?: string
  readonly selector?: string
  readonly role?: string
  readonly identityName?: string
  readonly refId?: string
}

type SnapshotBaseline = {
  readonly page: Page
  readonly signature: string
  readonly entries: readonly SnapshotRenderedEntry[]
}

type InputTarget = AriaSnapshotTarget

export const defaultAriaSnapshotTimeoutMs = 5_000
const defaultSnapshotTimeoutMs = 10_000

type InputField = {
  readonly selector: InputTarget
  readonly value: string
}

type ShowGhostCursorOptions = GhostCursorClientOptions & {
  readonly page?: Page
}

type HideGhostCursorOptions = {
  readonly page?: Page
}

type ScreenshotWithLabelsOptions = {
  readonly page?: Page
  readonly path?: string
  readonly registry?: SnapshotRefRegistry
}

type ScreenshotWithLabelsResult = {
  readonly path?: string
  readonly image?: Buffer
  readonly size: number
  readonly labelCount: number
  readonly labels: readonly ScreenshotLabel[]
}

type ScreenshotLabel = {
  readonly ref: string
  readonly selector: string
  readonly role: string
  readonly text: string
  readonly context?: string
  readonly tagName: string
  readonly rect: ScreenshotLabelRect
}

type ScreenshotLabelRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type ExecuteTargetSelection = {
  readonly urlIncludes?: string
  readonly index?: number
}

export const defaultPageClosedWarning = "The session default page was closed; created a new page. References to the old page in state are stale."
const defaultPageRecoveredWarning = "The session default page was unresponsive; created a new page. References to the old page in state are stale."
const defaultPageCrashedWarning = "The session default page target crashed; checking it before the next execute."
export const defaultPageRepairedWarning = "The session default page stopped answering automation; Browser Control reconnected and re-resolved the same tab. References to the old page in state are stale."
const protectedExtensionUiWarning = "Chromium blocked protected extension UI, possibly a password manager. Ask the user to finish or dismiss it in the browser, then retry."
const protectedExtensionUiDiagnostic = "target/cross-extension-page"

/**
 * Playwright rewrites Chrome's "Cannot access a chrome-extension:// URL of
 * different extension" rejection into a generic destroyed-context error and
 * retries locators until they time out. When the relay reports that the tab is
 * blocked by protected extension UI, those masked failures are the block.
 */
function isMaskedProtectedUiFailure(cause: unknown): boolean {
  const kind = runtimeFailureKind(cause)
  return kind === "context-destroyed" || kind === "context-missing" || kind === "timeout"
}
export const defaultPageReplacedWarning = "The session default page target was replaced; rebound to the same browser tab. References to the old page in state are stale."

export const shouldCloseCurrentPageOnAdopt = (options: {
  readonly hasCurrentPage: boolean
  readonly ownsCurrentPage: boolean
  readonly currentPageIsSelected: boolean
  readonly currentPageIsClosed: boolean
}): boolean => {
  return options.hasCurrentPage && options.ownsCurrentPage && !options.currentPageIsSelected && !options.currentPageIsClosed
}

type ExecuteSandboxOptions = {
  readonly endpointUrl: string
  readonly sessionId?: string
  readonly requestHandoff?: RequestHandoff
  readonly onDefaultTargetChange?: (target: SessionTarget | undefined) => void
  /** Health-check budget per attempt for a page that failed with an execution-context error. */
  readonly pageHealthCheckTimeoutMs?: number
}

export type ExecuteResult = {
  readonly text: string
  readonly value?: unknown
  readonly media?: readonly ExecuteMedia[]
  readonly isError: boolean
  readonly logs: readonly ExecuteLogEntry[]
  readonly logSummary: ExecuteLogSummary
  readonly warnings: readonly string[]
  readonly diagnostic?: string
  readonly aftermath?: ExecuteAftermath
  readonly setupFailed?: true
}

class ExecuteCodeError extends Error {
  constructor(
    readonly originalError: Error,
    readonly logs: readonly ExecuteLogEntry[],
    readonly logSummary: ExecuteLogSummary,
    readonly aftermath?: ExecuteAftermath,
  ) {
    super(originalError.message, { cause: originalError })
    this.name = originalError.name
    if (originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export type ExecuteOptions = {
  readonly targetSelection?: ExecuteTargetSelection
}

export class ExecuteSandbox {
  private browser: Browser | undefined
  private page: Page | undefined
  private defaultPageTargetId: string | undefined
  private ownsPage = false
  private pageHealthCheckRequired = false
  private pageCrashed = false
  private pageProtectedUi = false
  private pendingTargetRebind: "replaced" | "repaired" | undefined
  private lastKnownNonBlankUrl: string | undefined
  private recreatedFromClosedUrl: string | undefined
  private explicitLightColorScheme = false
  private readonly state: Record<string, unknown> = {}
  private readonly snapshotRefs: SnapshotRefRegistry = { selectors: new Map() }
  private readonly networkCapture = new NetworkCapture.Recorder()
  private pendingWarnings: string[] = []
  private boundPageListeners: {
    readonly page: Page
    readonly close: () => void
    readonly navigate: (frame: Frame) => void
  } | undefined

  constructor(readonly options: ExecuteSandboxOptions) {}

  execute(code: string, options: ExecuteOptions = {}): Effect.Effect<ExecuteResult> {
    return Effect.tryPromise({
      try: async () => {
        const globals = await this.getGlobals(options)
        const { result, logs, logSummary, aftermath } = await runUserCode({ code, globals })
        await this.networkCapture.settleForOutput()
        const extracted = extractExecuteMedia(result)
        const redactedValue = this.networkCapture.redactValue(extracted.value)
        const jsonSafeResult = toJsonSafeValue(redactedValue)
        const warnings = this.finalizeWarnings(
          logSummary,
          jsonSafeResult.serializable ? undefined : `Execute result could not be represented as JSON value: ${jsonSafeResult.reason}`,
        )
        return {
          text: stringifyResult(redactedValue),
          ...(jsonSafeResult.serializable ? { value: jsonSafeResult.value } : {}),
          ...(extracted.media.length > 0 ? { media: extracted.media } : {}),
          isError: false,
          logs: this.redactCaptureLogs(logs),
          logSummary,
          warnings,
          aftermath: this.redactCaptureAftermath(aftermath),
        }
      },
      catch: (cause) => {
        if (cause instanceof ExecuteCodeError) {
          return cause
        }
        return cause instanceof Error ? cause : new Error("execute sandbox code", { cause })
      },
    }).pipe(
      Effect.uninterruptible,
      Effect.tapError(() => Effect.promise(() => this.networkCapture.settleForOutput())),
      Effect.match({
        onFailure: (error): ExecuteResult => {
          const logSummary = error instanceof ExecuteCodeError ? error.logSummary : emptyExecuteLogSummary()
          const aftermath = error instanceof ExecuteCodeError ? error.aftermath : undefined
          const diagnostic = error instanceof SessionPageRecoveryError
            ? `session-page/${error.reason}`
            : this.pageProtectedUi && isMaskedProtectedUiFailure(error)
            ? protectedExtensionUiDiagnostic
            : executionContextFailureDiagnostic(error, aftermath)
          if (diagnostic?.startsWith("execution-context/")) {
            this.pageHealthCheckRequired = true
          }
          const warnings = this.finalizeWarnings(
            logSummary,
            diagnostic === protectedExtensionUiDiagnostic ? protectedExtensionUiWarning : undefined,
            error instanceof ExecuteCodeError ? formatNodeContextWarning(error.originalError) : undefined,
            error instanceof ExecuteCodeError ? formatPointerInterceptionWarning(error.originalError) : formatPointerInterceptionWarning(error),
            diagnostic === protectedExtensionUiDiagnostic
              ? undefined
              : formatLocatorFailurePageWarning(error instanceof ExecuteCodeError ? error.originalError : error, aftermath, this.recreatedFromClosedUrl),
          )
          return {
            text: this.networkCapture.redactText(error instanceof ExecuteCodeError ? error.stack ?? error.message : error.message),
            isError: true,
            logs: this.redactCaptureLogs(error instanceof ExecuteCodeError ? error.logs : []),
            logSummary,
            warnings,
            ...(diagnostic ? { diagnostic: this.networkCapture.redactText(diagnostic) } : {}),
            ...(aftermath ? { aftermath: this.redactCaptureAftermath(aftermath) } : {}),
            ...(error instanceof ExecuteCodeError ? {} : { setupFailed: true as const }),
          }
        },
        onSuccess: (result) => {
          return result
        },
      }),
    )
  }

  authenticatedJson(
    request: Omit<AuthenticatedJsonRequest, "sessionId">,
  ): Effect.Effect<AuthenticatedJsonOutcome, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      if (request.sensitive === true && sandbox.networkCapture.status().active) {
        return AuthenticatedJsonOutcome.cases.SensitiveCaptureActive.make({})
      }
      const page = yield* sandbox.ensureSessionPage("Set up authenticated origin page")
      return yield* AuthenticatedOrigin.requestJson(page, request)
    }).pipe(Effect.uninterruptible)
  }

  private drainWarnings(): string[] {
    const warnings = this.pendingWarnings
    this.pendingWarnings = []
    return warnings
  }

  private finalizeWarnings(logSummary: ExecuteLogSummary, ...extraWarnings: Array<string | undefined>): string[] {
    const warnings = this.drainWarnings()
    for (const warning of extraWarnings) {
      if (warning) warnings.push(warning)
    }
    const logCompactionWarning = formatLogCompactionWarning(logSummary)
    if (logCompactionWarning) {
      warnings.push(logCompactionWarning)
    }
    return warnings.map((warning) => this.networkCapture.redactText(warning))
  }

  redactNetworkCaptureText(text: string): string {
    return this.networkCapture.redactText(text)
  }

  private redactCaptureLogs(logs: readonly ExecuteLogEntry[]): readonly ExecuteLogEntry[] {
    return logs.map((log) => ({
      ...log,
      text: this.networkCapture.redactText(log.text),
      ...(log.location ? {
        location: { ...log.location, url: this.networkCapture.redactUrl(log.location.url) },
      } : {}),
    }))
  }

  private redactCaptureAftermath(aftermath: ExecuteAftermath): ExecuteAftermath {
    return {
      ...aftermath,
      startUrl: aftermath.startUrl ? this.networkCapture.redactUrl(aftermath.startUrl) : aftermath.startUrl,
      endUrl: aftermath.endUrl ? this.networkCapture.redactUrl(aftermath.endUrl) : aftermath.endUrl,
      navigations: aftermath.navigations.map((url) => this.networkCapture.redactUrl(url)),
    }
  }

  disconnectSettled(): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const browser = sandbox.browser
      sandbox.browser = undefined
      sandbox.unbindDefaultPage(sandbox.defaultPageTargetId, {
        ownsPage: sandbox.ownsPage,
        pageCrashed: sandbox.pageCrashed,
        pageProtectedUi: sandbox.pageProtectedUi,
      })
      yield* sandbox.networkCapture.cancel()
      if (browser) {
        yield* runSettledPlaywrightOperation({
          label: "Disconnect sandbox browser after handoff cancellation",
          run: () => browser.close(),
        }).pipe(Effect.ignore)
      }
    })
  }

  closeSettled(): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const page = sandbox.page
      const browser = sandbox.browser
      const ownsOpenPage = page !== undefined && sandbox.ownsPage && !page.isClosed()
      sandbox.browser = undefined
      sandbox.unbindDefaultPage(undefined, { notify: true })
      yield* sandbox.networkCapture.cancel()

      if (ownsOpenPage) {
        yield* runSettledPlaywrightOperation({
          label: "Close sandbox page after adoption",
          run: () => page.close(),
        }).pipe(Effect.ignore)
      }
      if (browser) {
        yield* runSettledPlaywrightOperation({
          label: "Close sandbox browser connection after adoption",
          run: () => browser.close(),
        }).pipe(Effect.ignore)
      }
    })
  }

  adoptPage(targetId: string): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      // The manager reserves and validates the exact registry generation. Adoption
      // binds that identity, not renderer readiness: a cold CDP connection waits
      // for every announced page to initialize, which a busy user tab cannot do.
      const currentPage = sandbox.page
      const sameTarget = sandbox.defaultPageTargetId === targetId
      yield* sandbox.networkCapture.cancel()
      if (shouldCloseCurrentPageOnAdopt({
        hasCurrentPage: currentPage !== undefined,
        ownsCurrentPage: sandbox.ownsPage,
        currentPageIsSelected: sameTarget,
        currentPageIsClosed: currentPage?.isClosed() ?? true,
      }) && currentPage) {
        // Keep the old binding until close settles. A failed close must not
        // publish the new identity or orphan an open relay-owned page.
        yield* runSettledPlaywrightOperation({
          label: "Close the previous session page during adoption",
          run: () => currentPage.close(),
        })
      }
      sandbox.unbindDefaultPage(targetId)
    }).pipe(Effect.uninterruptible)
  }

  /** Forget the bound page; a target id is re-resolved exactly on the next execute. */
  private unbindDefaultPage(
    targetId: string | undefined,
    options: {
      readonly ownsPage?: boolean
      readonly pageCrashed?: boolean
      readonly pageProtectedUi?: boolean
      readonly rebind?: "replaced" | "repaired"
      readonly notify?: boolean
    } = {},
  ): void {
    this.clearPageListeners()
    this.page = undefined
    this.defaultPageTargetId = targetId
    this.ownsPage = options.ownsPage ?? false
    this.pageHealthCheckRequired = false
    this.pageCrashed = options.pageCrashed ?? false
    this.pageProtectedUi = options.pageProtectedUi ?? false
    this.pendingTargetRebind = targetId ? options.rebind : undefined
    this.networkCapture.bindPage(undefined)
    if (options.notify) this.notifyDefaultTargetChange()
  }

  private async connectContext(): Promise<{ readonly browser: Browser; readonly context: BrowserContext }> {
    if (!this.browser?.isConnected()) {
      const hadBrowser = this.browser !== undefined
      const staleBrowser = this.browser
      if (staleBrowser) {
        await Effect.runPromise(runPlaywrightOperation({
          label: "Close stale browser connection before reconnecting",
          timeoutMs: playwrightCloseTimeoutMs,
          run: () => staleBrowser.close(),
        }).pipe(Effect.ignore))
      }
      const adoptedDefaultTarget = this.defaultPageTargetId !== undefined && !this.ownsPage
      try {
        // Let Playwright own timeout/transport cleanup; never race and abandon
        // a connect promise that could bind a page after reporting failure.
        this.browser = await chromium.connectOverCDP(this.options.endpointUrl, {
          timeout: adoptedDefaultTarget ? adoptedPageConnectTimeoutMs : playwrightConnectTimeoutMs,
          ...(this.options.sessionId ? { headers: { "Browser-Control-Session-Id": encodeURIComponent(this.options.sessionId), "Browser-Control-Client-Kind": "sandbox" } } : {}),
        })
      } catch (cause) {
        if (adoptedDefaultTarget && cause instanceof errors.TimeoutError) {
          throw new SessionPageRecoveryError({
            message: `Automation connection initialization for the adopted tab did not finish within ${adoptedPageConnectTimeoutMs}ms. The tab and exact target were kept; user code did not run. Retry after the browser or page becomes responsive.`,
            reason: "adopted-initialization-timeout",
            cause,
          })
        }
        throw cause
      }
      this.unbindDefaultPage(this.defaultPageTargetId, {
        ownsPage: this.ownsPage,
        pageCrashed: this.pageCrashed,
        pageProtectedUi: this.pageProtectedUi,
        ...(this.pendingTargetRebind ? { rebind: this.pendingTargetRebind } : {}),
      })
      if (hadBrowser) {
        this.pendingWarnings.push("Relay connection was lost and re-established; the session default page was re-resolved.")
      }
    }
    const browser = this.browser
    const context = browser.contexts()[0] ?? (await browser.newContext())
    await registerAriaSnapshotSelector(context)
    installDownloadCapabilityGuards(context)
    return { browser, context }
  }

  /**
   * Drop the Playwright connection but remember the default page target so the
   * next connect re-resolves the same tab with fresh frame and context state.
   * The relay re-enables Runtime for the tab on the new connection, which is the
   * designed recovery for a page whose context events stopped reaching Playwright.
   */
  private async repairSessionPage(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    this.unbindDefaultPage(this.defaultPageTargetId, {
      ownsPage: this.ownsPage,
      pageCrashed: this.pageCrashed,
      pageProtectedUi: this.pageProtectedUi,
      rebind: "repaired",
    })
    if (browser) {
      await Effect.runPromise(runPlaywrightOperation({
        label: "Close browser connection to repair the session page",
        timeoutMs: playwrightCloseTimeoutMs,
        run: () => browser.close(),
      }).pipe(Effect.ignore))
    }
  }

  private async acquireSessionPage(targetSelection?: ExecuteTargetSelection): Promise<{
    readonly browser: Browser
    readonly context: BrowserContext
    readonly page: Page
  }> {
    let { browser, context } = await this.connectContext()
    let page: Page
    try {
      page = await this.getSessionPage({ context, ...(targetSelection ? { targetSelection } : {}) })
    } catch (error) {
      if (!(error instanceof SessionPageRepairRequired)) throw error
      await this.repairSessionPage()
      ;({ browser, context } = await this.connectContext())
      page = await this.getSessionPage({ context, ...(targetSelection ? { targetSelection } : {}) })
    }
    installPageReadTimeout(page)
    this.installViewportZoomGuard(page)
    this.networkCapture.bindPage(this.page)
    return { browser, context, page }
  }

  private ensureSessionPage(label: string): Effect.Effect<Page, Error> {
    return Effect.tryPromise({
      try: async () => (await this.acquireSessionPage()).page,
      catch: (cause) => cause instanceof Error ? cause : new Error(label, { cause }),
    })
  }

  private async getGlobals(options: ExecuteOptions): Promise<SandboxGlobals> {
    const { browser, context, page } = await this.acquireSessionPage(options.targetSelection)
    const showGhostCursor = async (options?: ShowGhostCursorOptions) => {
      const { page: targetPage = page, ...cursorOptions } = options ?? {}
      await showGhostCursorOnPage({ page: targetPage, cursorOptions })
    }
    const hideGhostCursor = async (options?: HideGhostCursorOptions) => {
      await hideGhostCursorOnPage({ page: options?.page ?? page })
    }
    const ariaSnapshot = createAriaSnapshotHelper(page)
    const { snapshot, ref } = createSnapshotHelpers(page, this.snapshotRefs)
    const handoffTracker = { count: 0 }
    const requestHandoff = this.options.requestHandoff
    const handoff = async (message?: string, options?: HandoffCallOptions) => {
      if (!requestHandoff) {
        throw new Error("handoff is not available in this sandbox; it requires a relay-backed Browser Control session")
      }
      const handoffMessage = message?.trim() || defaultHandoffMessage
      const timeoutMs = options?.timeoutMs ?? defaultHandoffTimeoutMs
      const handoffPage = options?.page ?? page
      if (handoffPage.isClosed() || handoffPage.context() !== context) {
        throw new Error("handoff requires an open page in the current browser context")
      }
      const followsDefaultPage = handoffPage === this.page
      const targetId = await pageTargetId(handoffPage)
      const outcome = await requestHandoff({
        message: handoffMessage,
        timeoutMs,
        target: { targetId },
        ...(options?.start ? { start: options.start } : {}),
        ...(options?.start ? { cancelStart: () => Effect.runPromise(this.disconnectSettled()) } : {}),
      })
      await finishHandoff({
        outcome,
        message: handoffMessage,
        timeoutMs,
        contextTimeoutMs: handoffPageContextTimeoutMs,
        evaluate: async () => {
          try {
            const currentPage = followsDefaultPage ? await this.getSessionPage({ context }) : handoffPage
            await currentPage.evaluate(() => true)
          } catch (error) {
            if ((error instanceof SessionPageRecoveryError && error.reason === "target-unavailable") || error instanceof SessionPageRepairRequired) {
              throw new Error("Execution context is not available while the handoff destination settles", { cause: error })
            }
            throw error
          }
        },
      })
      handoffTracker.count += 1
    }
    const demonstrate = async (message?: string, options?: HandoffCallOptions) => {
      const demonstrationPage = options?.page ?? page
      if (demonstrationPage.isClosed() || demonstrationPage.context() !== context) {
        throw new Error("demonstrate requires an open page in the current browser context")
      }
      const recorder = await startDemonstrationRecorder(demonstrationPage)
      try {
        await handoff(message ?? "Demonstrate the browser flow, then continue", { ...options, page: demonstrationPage })
      } catch (error) {
        await recorder.stop().catch(() => {})
        throw error
      }
      return await recorder.stop()
    }
    return {
      browser,
      context,
      page,
      state: this.state,
      modules: nodeModules,
      fillInput: (target, value) => fillInput({ page, target, value }),
      fillInputs,
      screenshotWithLabels: (screenshotOptions = {}) => screenshotWithLabels({
        ...screenshotOptions,
        page: screenshotOptions.page ?? page,
        registry: this.snapshotRefs,
      }),
      screenshotDiff: createScreenshotDiff(page),
      ariaSnapshot,
      snapshot,
      ref,
      webmcp: createWebMcpHelper(page),
      showGhostCursor,
      hideGhostCursor,
      ghostCursor: {
        show: showGhostCursor,
        hide: hideGhostCursor,
        caption: async (title, captionOptions) => {
          const { page: targetPage = page, ...rest } = captionOptions ?? {}
          await setGhostCursorCaption({ page: targetPage, title, captionOptions: rest })
        },
        clearCaption: async (clearOptions) => {
          await setGhostCursorCaption({ page: clearOptions?.page ?? page, title: null })
        },
        callout: async (target, label, calloutOptions) => {
          const { page: targetPage = page, ...rest } = calloutOptions ?? {}
          await showGhostCursorCallout({ page: targetPage, target, label, calloutOptions: rest })
        },
        clearCallouts: async (clearOptions) => {
          await clearGhostCursorCallouts({ page: clearOptions?.page ?? page })
        },
        zoom: async (target, zoomOptions) => {
          const { page: targetPage = page, ...rest } = zoomOptions ?? {}
          await zoomGhostCursorCamera({ page: targetPage, target, zoomOptions: rest })
        },
        resetZoom: async (resetOptions) => {
          const { page: targetPage = page, ...rest } = resetOptions ?? {}
          await zoomGhostCursorCamera({ page: targetPage, target: null, zoomOptions: rest })
        },
        spotlight: async (target, spotlightOptions) => {
          const { page: targetPage = page, ...rest } = spotlightOptions ?? {}
          await setGhostCursorSpotlight({ page: targetPage, target, spotlightOptions: rest })
        },
        clearSpotlight: async (clearOptions) => {
          await setGhostCursorSpotlight({ page: clearOptions?.page ?? page, target: null })
        },
        keys: async (keys, label, keyOptions) => {
          await showGhostCursorKeys({ page: keyOptions?.page ?? page, keys, ...(label ? { label } : {}) })
        },
      },
      handoff,
      demonstrate,
      network: {
        start: (options) => Effect.runPromise(this.networkCapture.start(page, options)),
        status: () => this.networkCapture.status(),
        stop: (options) => Effect.runPromise(this.networkCapture.stop(options)),
        cancel: () => Effect.runPromise(this.networkCapture.cancel()),
      },
      handoffTracker,
    }
  }

  markTargetCrashed(targetId: string): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    this.pageHealthCheckRequired = true
    this.pageCrashed = true
    if (!this.pendingWarnings.includes(defaultPageCrashedWarning)) {
      this.pendingWarnings.push(defaultPageCrashedWarning)
    }
    return true
  }

  /** Relay report that protected extension UI started or stopped blocking the default page's tab. */
  markTargetProtectedUi(targetId: string, protectedUi: boolean): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    this.pageProtectedUi = protectedUi
    return true
  }

  markTargetDetached(targetId: string): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    if (this.lastKnownNonBlankUrl) {
      this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
    }
    this.unbindDefaultPage(undefined)
    if (!this.pendingWarnings.includes(defaultPageClosedWarning)) {
      this.pendingWarnings.push(defaultPageClosedWarning)
    }
    return true
  }

  markTargetReplaced(previousTargetId: string, targetId: string): boolean {
    if (this.defaultPageTargetId !== previousTargetId) return false
    this.unbindDefaultPage(targetId, {
      ownsPage: this.ownsPage,
      rebind: "replaced",
    })
    return true
  }

  restore(target: SessionTarget | undefined): void {
    if (target) {
      this.unbindDefaultPage(target.id, { ownsPage: target.owner === "relay" })
    }
    this.pendingWarnings.push("The relay restarted; session JavaScript state and snapshot refs were reset.")
  }

  private notifyDefaultTargetChange(): void {
    this.options.onDefaultTargetChange?.(this.defaultPageTargetId
      ? { id: this.defaultPageTargetId, owner: this.ownsPage ? "relay" : "user" }
      : undefined)
  }

  private recordNonBlankUrl(url: string | null | undefined): void {
    if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) {
      this.lastKnownNonBlankUrl = url
      this.recreatedFromClosedUrl = undefined
    }
  }

  private bindDefaultPage(page: Page, targetId: string | undefined, ownsPage: boolean, notify: boolean): void {
    this.clearPageListeners()
    this.page = page
    if (targetId === undefined || targetId !== this.defaultPageTargetId) {
      this.pageCrashed = false
      this.pageProtectedUi = false
    }
    this.defaultPageTargetId = targetId
    this.ownsPage = ownsPage
    this.pendingTargetRebind = undefined
    this.recordNonBlankUrl(safePageUrl(page))
    const close = () => {
      if (this.page !== page) return
      if (this.lastKnownNonBlankUrl) {
        this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
      }
      this.unbindDefaultPage(undefined, {
        pageCrashed: this.pageCrashed,
        pageProtectedUi: this.pageProtectedUi,
        notify: true,
      })
    }
    const navigate = (frame: Frame) => {
      if (this.page === page && frame === page.mainFrame()) {
        this.pageCrashed = false
        this.recordNonBlankUrl(frame.url())
        page.setDefaultTimeout?.(30_000)
        if (this.explicitLightColorScheme) {
          void this.applyExplicitLightColorScheme(page)
        }
      }
    }
    this.boundPageListeners = { page, close, navigate }
    page.once("close", close)
    page.on("framenavigated", navigate)
    if (notify) this.notifyDefaultTargetChange()
  }

  private clearBoundPageListeners(): void {
    const bound = this.boundPageListeners
    if (!bound) return
    bound.page.off("close", bound.close)
    bound.page.off("framenavigated", bound.navigate)
    this.boundPageListeners = undefined
  }

  private clearSnapshotRefs(): void {
    this.snapshotRefs.removeNavigationListener?.()
    delete this.snapshotRefs.removeNavigationListener
    invalidateSnapshotDocument(this.snapshotRefs)
  }

  private clearPageListeners(): void {
    this.clearBoundPageListeners()
    this.clearSnapshotRefs()
  }

  getStatus(): { readonly sessionId?: string; readonly connected: boolean; readonly pageUrl: string | null; readonly stateKeys: string[] } {
    const pageUrl = this.page && !this.page.isClosed() ? this.page.url() : null
    return {
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      connected: isSessionPageConnected({
        browserConnected: Boolean(this.browser?.isConnected()),
        pageUrl,
        healthCheckRequired: this.pageHealthCheckRequired,
      }),
      pageUrl,
      stateKeys: Object.keys(this.state),
    }
  }

  networkStart(options: NetworkCapture.NetworkCaptureOptions = {}): Effect.Effect<NetworkCapture.NetworkCaptureStatus, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const page = yield* sandbox.ensureSessionPage("Set up page for network capture")
      return yield* sandbox.networkCapture.start(page, options)
    }).pipe(Effect.uninterruptible)
  }

  networkStatus(): NetworkCapture.NetworkCaptureStatus {
    return this.networkCapture.status()
  }

  networkStop(options: NetworkCapture.NetworkCaptureStopOptions = {}): Effect.Effect<NetworkCapture.NetworkCaptureResult, Error> {
    return this.networkCapture.stop(options)
  }

  networkCancel(): Effect.Effect<{ readonly cancelled: boolean }> {
    return this.networkCapture.cancel()
  }

  authRefresh(options: {
    readonly name: string
    readonly urlFilter?: string
    readonly timeoutMs?: number
  }): Effect.Effect<NetworkCapture.NetworkCaptureResult, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const page = yield* sandbox.ensureSessionPage("Set up page for auth refresh")
      yield* AuthProfile.read(options.name).pipe(Effect.asVoid)
      yield* sandbox.networkCapture.start(page, {
        ...(options.urlFilter ? { urlFilter: options.urlFilter } : {}),
      })
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 }),
          catch: (cause) => cause instanceof Error ? cause : new Error("Refresh auth profile", { cause }),
        })
        yield* Effect.tryPromise({
          try: () => page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs ?? 30_000, 5_000) }).catch(() => {}),
          catch: (cause) => cause instanceof Error ? cause : new Error("Wait for auth refresh network", { cause }),
        })
        return yield* sandbox.networkCapture.stop({ secrets: options.name, requireObservedSecrets: true })
      }).pipe(Effect.ensuring(sandbox.networkCapture.cancel()))
    }).pipe(Effect.uninterruptible)
  }

  private async getSessionPage({ context, targetSelection }: { readonly context: BrowserContext; readonly targetSelection?: ExecuteTargetSelection }): Promise<Page> {
    const selection = targetSelection ?? {}
    if (hasExplicitTargetSelection(selection)) {
      const selected = selectPage({ pages: context.pages(), selection })
      if (!selected) {
        throw new Error("No page matched target selection")
      }
      return selected
    }
    if (!this.page && this.defaultPageTargetId) {
      const targetId = this.defaultPageTargetId
      const rebind = this.pendingTargetRebind
      const replacement = await waitForPageTarget({ context, targetId, timeoutMs: sessionPageHealthCheckTimeoutMs })
      if (!replacement) {
        throw new SessionPageRecoveryError({
          message: `Playwright did not expose session page target ${targetId} after the browser connection or target changed. Retry after the browser transition settles.`,
          reason: "target-unavailable",
          cause: new Error(`Session page target unavailable: ${targetId}`),
        })
      }
      this.bindDefaultPage(replacement, targetId, this.ownsPage, false)
      if (rebind === "replaced") this.pendingWarnings.push(defaultPageReplacedWarning)
      if (rebind !== "repaired") return replacement
      this.pageHealthCheckRequired = true
      const checked = await this.checkSessionPage(replacement, { repaired: true })
      if (checked) {
        this.pendingWarnings.push(defaultPageRepairedWarning)
        return checked
      }
    }
    if (this.page && !this.page.isClosed()) {
      // A tab blocked by protected extension UI cannot answer a probe; the
      // block is named on the next failure instead of treated as a dead page.
      if ((this.pageHealthCheckRequired && !this.pageProtectedUi) || this.page.url().startsWith("chrome-error://")) {
        const page = await this.checkSessionPage(this.page, { repaired: false })
        if (page) return page
      } else {
        return this.page
      }
    }
    if (this.page?.isClosed()) {
      if (this.lastKnownNonBlankUrl) {
        this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
      }
      this.unbindDefaultPage(undefined, {
        pageCrashed: this.pageCrashed,
        pageProtectedUi: this.pageProtectedUi,
        notify: true,
      })
      this.pendingWarnings.push(defaultPageClosedWarning)
    }
    const page = await context.newPage()
    const targetId = await resolvePageTargetId(page)
    this.bindDefaultPage(page, targetId, true, true)
    if (this.recreatedFromClosedUrl) {
      this.installClosedPageReplacementGuard(page)
    }
    return page
  }

  private installClosedPageReplacementGuard(page: Page): void {
    page.setDefaultTimeout?.(2_500)
    const restoreTimeout = () => {
      this.recreatedFromClosedUrl = undefined
      page.setDefaultTimeout?.(30_000)
    }
    if (typeof page.goto === "function") {
      const originalGoto = page.goto.bind(page)
      Object.defineProperty(page, "goto", {
        configurable: true,
        value: async (...args: Parameters<Page["goto"]>) => {
          restoreTimeout()
          return await originalGoto(...args)
        },
      })
    }
    if (typeof page.setContent === "function") {
      const originalSetContent = page.setContent.bind(page)
      Object.defineProperty(page, "setContent", {
        configurable: true,
        value: async (...args: Parameters<Page["setContent"]>) => {
          restoreTimeout()
          return await originalSetContent(...args)
        },
      })
    }
  }

  private async applyExplicitLightColorScheme(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page)
      try {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: "light" },
            { name: "__bc_explicit__", value: "1" },
          ],
        })
      } finally {
        await cdp.detach().catch(() => {})
      }
    } catch {}
  }

  private installViewportZoomGuard(page: Page): void {
    if (viewportZoomGuardedPages.has(page)) return
    if (typeof page.emulateMedia === "function") {
      const originalEmulateMedia = page.emulateMedia.bind(page)
      Object.defineProperty(page, "emulateMedia", {
        configurable: true,
        value: async (options?: Parameters<Page["emulateMedia"]>[0]) => {
          if (options && "colorScheme" in options) {
            this.explicitLightColorScheme = options.colorScheme === "light"
          }
          await originalEmulateMedia(options)
          if (this.explicitLightColorScheme) {
            await this.applyExplicitLightColorScheme(page)
          }
        },
      })
    }
    if (typeof page.setViewportSize === "function") {
      const originalSetViewportSize = page.setViewportSize.bind(page)
      Object.defineProperty(page, "setViewportSize", {
        configurable: true,
        value: async (size: { width: number; height: number }) => {
          await originalSetViewportSize(size)
          try {
            const measured = await withTimeout(
              page.evaluate(() => ({
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                dpr: window.devicePixelRatio,
              })),
              1_000,
            )
            if (
              measured !== timedOut
              && (Math.abs(measured.innerWidth - size.width) > 2 || Math.abs(measured.innerHeight - size.height) > 2)
            ) {
              const warning = `Viewport size ${size.width}x${size.height} resulted in CSS viewport ${measured.innerWidth}x${measured.innerHeight} (devicePixelRatio=${Number(measured.dpr.toFixed(3))}) due to browser zoom on this origin.`
              if (!this.pendingWarnings.includes(warning)) {
                this.pendingWarnings.push(warning)
              }
            }
          } catch {}
        },
      })
    }
    viewportZoomGuardedPages.add(page)
  }

  /**
   * Health-check the current default page. Returns the page when it is usable,
   * `undefined` after a disposable relay-owned page was closed so the caller
   * recreates it, throws `SessionPageRepairRequired` when a live relay-owned
   * page should be re-resolved over a fresh connection, and otherwise fails
   * with a `SessionPageRecoveryError` diagnosis while keeping the tab.
   */
  private async checkSessionPage(page: Page, options: { readonly repaired: boolean }): Promise<Page | undefined> {
    const timeoutMs = this.options.pageHealthCheckTimeoutMs ?? sessionPageHealthCheckTimeoutMs
    const sandbox = this
    const recovery = await Effect.runPromise(recoverSessionPage({
      ownsPage: this.ownsPage,
      // Read these after the asynchronous probe: navigation may have recovered
      // an error document or cleared the crash while its old context failed.
      get url() { return page.url() },
      timeoutMs,
      get crashed() { return sandbox.pageCrashed },
      repaired: options.repaired,
      healthCheck: () => waitForPageContext({
        timeoutMs,
        evaluate: async () => {
          await page.evaluate(() => true)
        },
      }),
      close: () => page.close(),
    }))
    if (recovery === "use") {
      this.pageHealthCheckRequired = false
      this.pageCrashed = false
      return page
    }
    if (recovery === "repair") {
      throw new SessionPageRepairRequired()
    }
    this.unbindDefaultPage(undefined, { notify: true })
    this.pendingWarnings.push(defaultPageRecoveredWarning)
    return undefined
  }
}

async function waitForPageTarget(options: {
  readonly context: BrowserContext
  readonly targetId: string
  readonly timeoutMs: number
}): Promise<Page | undefined> {
  return await waitForExactTarget({
    targetId: options.targetId,
    timeoutMs: options.timeoutMs,
    candidates: () => options.context.pages(),
    getTargetId: resolvePageTargetId,
  })
}

export async function waitForExactTarget<T>(options: {
  readonly targetId: string
  readonly timeoutMs: number
  readonly candidates: () => readonly T[]
  readonly getTargetId: (candidate: T) => Promise<string | undefined>
  readonly delay?: (milliseconds: number) => Promise<void>
}): Promise<T | undefined> {
  const deadline = Date.now() + options.timeoutMs
  const cachedTargetIds = new Map<T, string | undefined>()
  const inFlightTargetIds = new Map<T, Promise<{ readonly candidate: T; readonly targetId: string | undefined }>>()
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return undefined
    const candidates = options.candidates()
    for (const candidate of candidates) {
      const cached = cachedTargetIds.get(candidate)
      if (cached === options.targetId) return candidate
      if (cached !== undefined || inFlightTargetIds.has(candidate)) continue
      inFlightTargetIds.set(candidate, options.getTargetId(candidate).then(
        (targetId) => ({ candidate, targetId }),
        () => ({ candidate, targetId: undefined }),
      ))
    }
    const retryInMs = Math.min(sessionPageHealthRetryDelayMs, Math.max(0, deadline - Date.now()))
    if (retryInMs <= 0) return undefined
    if (inFlightTargetIds.size > 0) {
      const resolved = await withTimeout(Promise.race(inFlightTargetIds.values()), retryInMs)
      if (resolved !== timedOut) {
        inFlightTargetIds.delete(resolved.candidate)
        if (resolved.targetId !== undefined) cachedTargetIds.set(resolved.candidate, resolved.targetId)
        if (resolved.targetId === options.targetId) return resolved.candidate
      }
      continue
    }
    await (options.delay ?? delay)(retryInMs)
  }
}

export function installDownloadCapabilityGuard(page: Page): void {
  if (downloadGuardedPages.has(page)) {
    return
  }
  const waitForEvent = page.waitForEvent.bind(page) as (event: string, ...args: unknown[]) => Promise<unknown>
  Object.defineProperty(page, "waitForEvent", {
    configurable: true,
    value: (event: string, ...args: unknown[]) => {
      if (event === "download") {
        return Promise.reject(new Error(downloadCapabilityErrorMessage))
      }
      return waitForEvent(event, ...args)
    },
  })
  downloadGuardedPages.add(page)
}

export function installDownloadCapabilityGuards(context: BrowserContext): void {
  if (downloadGuardedContexts.has(context)) {
    return
  }
  for (const page of context.pages()) {
    installDownloadCapabilityGuard(page)
  }
  context.on("page", installDownloadCapabilityGuard)
  downloadGuardedContexts.add(context)
}

export function hasExplicitTargetSelection(selection: ExecuteTargetSelection | undefined): boolean {
  return Boolean(selection?.urlIncludes) || selection?.index !== undefined
}

export function selectTarget<T>({
  targets,
  selection,
  getUrl,
  getIndex,
}: {
  readonly targets: readonly T[]
  readonly selection: ExecuteTargetSelection
  readonly getUrl: (target: T) => string
  readonly getIndex?: (target: T, fallbackIndex: number) => number
}): T | undefined {
  if (selection.urlIncludes && selection.index !== undefined) {
    throw new TargetSelectionError({ reason: "invalid", message: "Use only one target selector: --target-url or --target-index" })
  }
  if (selection.urlIncludes) {
    const matches = targets.filter((candidate) => {
      return getUrl(candidate).includes(selection.urlIncludes ?? "")
    })
    if (matches.length === 0) {
      throw new TargetSelectionError({
        reason: "not-found",
        message: `No existing attached page URL includes ${selection.urlIncludes}. Target selectors do not navigate or open pages: use page.goto() in the session page, or attach the intended user tab with the Browser Control toolbar first.`,
      })
    }
    if (matches.length > 1) {
      const candidates = targets.flatMap((candidate, index) => matches.includes(candidate) ? [`[${getIndex ? getIndex(candidate, index) : index}] ${getUrl(candidate)}`] : [])
      throw new TargetSelectionError({
        reason: "ambiguous",
        message: `Multiple attached pages (${matches.length}) match URL ${selection.urlIncludes}; use a more specific --target-url or --target-index. Matches: ${candidates.join(", ")}`,
      })
    }
    return matches[0]
  }
  if (selection.index !== undefined) {
    if (selection.index < 0) {
      throw new TargetSelectionError({ reason: "invalid", message: "Target index must be a non-negative integer" })
    }
    const target = targets[selection.index]
    if (!target) {
      throw new TargetSelectionError({
        reason: "not-found",
        message: `No existing attached page at index ${selection.index}; ${targets.length} page(s) available. Target selectors do not create pages.`,
      })
    }
    return target
  }
  if (targets.length === 0) {
    throw new TargetSelectionError({
      reason: "not-found",
      message: "No attached pages available. Attach the intended user tab with the Browser Control toolbar first.",
    })
  }
  if (targets.length > 1) {
    const candidates = targets.map((candidate, index) => `[${getIndex ? getIndex(candidate, index) : index}] ${getUrl(candidate)}`)
    throw new TargetSelectionError({
      reason: "ambiguous",
      message: `Multiple attached pages (${targets.length}); use --target-url or --target-index to choose one. Matches: ${candidates.join(", ")}`,
    })
  }
  return targets[0]
}

function selectPage({ pages, selection }: { readonly pages: readonly Page[]; readonly selection: ExecuteTargetSelection }): Page | undefined {
  return selectTarget({ targets: pages, selection, getUrl: (page) => page.url() })
}

async function resolvePageTargetId(page: Page): Promise<string | undefined> {
  return await Effect.runPromise(
    runPlaywrightOperation({
      label: "Resolve session page target id",
      timeoutMs: playwrightCloseTimeoutMs,
      run: () => pageTargetId(page),
    }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (targetId) => targetId,
      }),
    ),
  )
}

export async function pageTargetId(page: Page): Promise<string> {
  if (page.isClosed()) {
    throw new Error("Cannot identify the CDP target for a closed page")
  }
  const session = await page.context().newCDPSession(page)
  try {
    const result = await session.send("Target.getTargetInfo")
    const targetId = result.targetInfo?.targetId
    if (!targetId) {
      throw new Error("Target.getTargetInfo did not return a target id for the handoff page")
    }
    return targetId
  } finally {
    await session.detach()
  }
}

export function createAriaSnapshotHelper(page: Pick<Page, "locator">): AriaSnapshotHelper {
  return async (target, options) => {
    const locator = target === undefined ? page.locator("body") : Predicate.isString(target) ? page.locator(target) : target
    return await ariaSnapshotWithoutTextControlValues(locator, {
      timeout: options?.timeout ?? defaultAriaSnapshotTimeoutMs,
    })
  }
}

/** Refs and diff baselines never survive the document they were captured from. */
function invalidateSnapshotDocument(registry: SnapshotRefRegistry): void {
  registry.selectors.clear()
  delete registry.page
  delete registry.url
  delete registry.previousSnapshot
}

export function createSnapshotHelpers(page: Page, registry: SnapshotRefRegistry): {
  readonly snapshot: SnapshotHelper
  readonly ref: SnapshotRefHelper
} {
  const refRoots = new WeakMap<Locator, { readonly selector: string; readonly role: string; readonly name?: string }>()
  const snapshot: SnapshotHelper = async (options = {}) => {
    const within = options.within
    const withinSelector = Predicate.isString(within) ? within : undefined
    const withinLocator = within !== undefined && !Predicate.isString(within) ? within : undefined
    const refRoot = withinLocator ? refRoots.get(withinLocator) : undefined
    const locator = withinLocator && !refRoot ? withinLocator : undefined
    let locatorScope: number | undefined
    if (locator) {
      const scopes = registry.locatorScopes ??= new WeakMap()
      locatorScope = scopes.get(locator)
      if (locatorScope === undefined) {
        locatorScope = registry.nextLocatorScope ?? 1
        registry.nextLocatorScope = locatorScope + 1
        scopes.set(locator, locatorScope)
      }
    }
    const depth = Math.max(1, Math.min(16, Math.floor(options.depth ?? 10)))
    const maxItems = Math.max(1, Math.min(200, Math.floor(options.maxItems ?? 80)))
    const settings = {
      compact: options.compact ?? true,
      depth,
      interactive: options.interactive ?? false,
      maxCandidates: Math.max(1_000, maxItems * 20),
      maxItems,
      rootSelector: withinSelector ?? refRoot?.selector,
      rootRole: refRoot?.role,
      rootName: refRoot?.name,
    }
    const signature = JSON.stringify({
      compact: settings.compact,
      depth: settings.depth,
      interactive: settings.interactive,
      maxItems: settings.maxItems,
      scope: withinSelector !== undefined
        ? { kind: "selector", selector: withinSelector }
        : refRoot
        ? { kind: "ref", selector: refRoot.selector, role: refRoot.role, name: refRoot.name }
        : locator
        ? { kind: "locator", scope: locatorScope }
        : { kind: "page" },
    })
    const previousSnapshot = registry.previousSnapshot
    if (options.diff && options.delta) {
      throw new Error("snapshot() accepts either diff or delta, not both")
    }
    if (options.diff && !previousSnapshot) {
      throw new Error("snapshot({ diff: true }) requires a previous snapshot() baseline in this session")
    }
    if (options.diff && (previousSnapshot?.page !== page || previousSnapshot.signature !== signature)) {
      throw new Error("snapshot({ diff: true }) must use the same page and snapshot options as the previous snapshot")
    }

    registry.removeNavigationListener?.()
    registry.selectors.clear()
    delete registry.page
    delete registry.url
    let navigatedDuringCapture = false
    const onFrameNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return
      navigatedDuringCapture = true
      invalidateSnapshotDocument(registry)
    }
    const removeNavigationListener = () => page.off("framenavigated", onFrameNavigated)
    page.on("framenavigated", onFrameNavigated)
    registry.removeNavigationListener = removeNavigationListener

    const capture = (rootOrSettings: Element | typeof settings, locatorSettings?: typeof settings) => {
      type BrowserEntry = SnapshotEntry
      const settings = locatorSettings ?? rootOrSettings as typeof locatorSettings & typeof rootOrSettings

      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim()
      const truncate = (value: string, maxLength: number): string => {
        if (value.length <= maxLength) return value
        const prefix = value.slice(0, maxLength + 1)
        const boundary = prefix.lastIndexOf(" ")
        return `${prefix.slice(0, boundary >= Math.floor(maxLength * 0.6) ? boundary : maxLength).trimEnd()}...`
      }
      const quote = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      const styleCache = new WeakMap<Element, CSSStyleDeclaration>()
      const styleOf = (element: Element): CSSStyleDeclaration => {
        let cached = styleCache.get(element)
        if (!cached) {
          cached = window.getComputedStyle(element)
          styleCache.set(element, cached)
        }
        return cached
      }
      const visibleCache = new WeakMap<Element, boolean>()
      const isVisible = (element: Element): boolean => {
        const cached = visibleCache.get(element)
        if (cached !== undefined) return cached
        const style = styleOf(element)
        let result = true
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          result = false
        } else if (style.display === "contents") {
          const children = [
            ...Array.from(element.children ?? []),
            ...Array.from(element.shadowRoot?.children ?? []),
          ]
          result = children.some(isVisible)
        } else {
          const rect = element.getBoundingClientRect()
          result = rect.width >= 1 && rect.height >= 1
        }
        visibleCache.set(element, result)
        return result
      }
      const explicitAriaName = (element: Element): string => {
        const ariaLabel = element.getAttribute("aria-label")
        if (ariaLabel) return normalize(ariaLabel)
        const labelledBy = element.getAttribute("aria-labelledby")
        if (labelledBy) {
          const rootNode = element.getRootNode() as Document | ShadowRoot
          const labelled = normalize(labelledBy.split(/\s+/).map((id) => (rootNode.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? "").join(" "))
          if (labelled) return labelled
        }
        return ""
      }
      const titleName = (element: Element): string => normalize(element.getAttribute("title") ?? "")
      const labelledName = (element: Element): string => explicitAriaName(element) || titleName(element)
      const safeTextCache = new WeakMap<Element, string>()
      const safeText = (element: Element): string => {
        const cached = safeTextCache.get(element)
        if (cached !== undefined) return cached
        const parts: string[] = []
        const nearestBlock = (start: Element | null): Element => {
          let current = start
          while (current && current !== element && element.contains(current)) {
            const display = styleOf(current).display
            if (display && display !== "inline" && display !== "contents") return current
            current = current.parentElement
          }
          return element
        }
        let lastBlock: Element | undefined
        const rootStyle = styleOf(element)
        if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || rootStyle.display === "none" || rootStyle.visibility === "hidden" || rootStyle.opacity === "0") {
          safeTextCache.set(element, "")
          return ""
        }
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
          acceptNode(node) {
            if (node instanceof Element) {
              if (node.matches("input, textarea, select, script, style, noscript, template")) {
                return NodeFilter.FILTER_REJECT
              }
              const style = styleOf(node)
              if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                return NodeFilter.FILTER_REJECT
              }
              if (node !== element && (node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby"))) {
                const ariaText = explicitAriaName(node)
                if (ariaText) {
                  parts.push(` ${ariaText} `)
                  lastBlock = undefined
                }
                return NodeFilter.FILTER_REJECT
              }
            }
            return NodeFilter.FILTER_ACCEPT
          },
        })
        let node = walker.nextNode()
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) {
            const block = nearestBlock(node.parentElement)
            if (lastBlock && lastBlock !== block) parts.push(" ")
            parts.push(node.textContent ?? "")
            lastBlock = block
          } else if (node instanceof HTMLImageElement) {
            const alt = node.getAttribute("alt")
            if (alt) parts.push(` ${alt} `)
            lastBlock = undefined
          } else if (typeof HTMLSlotElement !== "undefined" && node instanceof HTMLSlotElement) {
            for (const assigned of node.assignedNodes({ flatten: true })) {
              if (assigned.nodeType === Node.TEXT_NODE) {
                parts.push(assigned.textContent ?? "")
              } else if (assigned instanceof Element) {
                parts.push(safeText(assigned))
              }
            }
            lastBlock = undefined
          } else if (node instanceof Element && node.tagName === "BR") {
            parts.push(" ")
            lastBlock = undefined
          }
          node = walker.nextNode()
        }
        const result = normalize(parts.join(""))
        safeTextCache.set(element, result)
        return result
      }
      const authorAccessibleName = (element: Element): string => {
        const labelled = explicitAriaName(element)
        if (labelled) return labelled
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLButtonElement
        ) {
          const label = element.labels?.[0]
          if (label) {
            const labelText = safeText(label)
            if (labelText) return labelText
          }
        }
        if (element instanceof HTMLInputElement && (element.type === "button" || element.type === "submit" || element.type === "reset")) {
          const buttonValue = normalize(element.value || (element.type === "submit" ? "Submit" : element.type === "reset" ? "Reset" : ""))
          if (buttonValue) return buttonValue
        }
        const title = titleName(element)
        if (title) return title
        const placeholder = element.getAttribute("placeholder")
        if (placeholder) return normalize(placeholder)
        return ""
      }
      const accessibleNameCache = new WeakMap<Element, string>()
      const accessibleName = (element: Element): string => {
        const cached = accessibleNameCache.get(element)
        if (cached !== undefined) return cached
        let result = ""
        const labelled = explicitAriaName(element)
        if (labelled) {
          result = labelled
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          result = authorAccessibleName(element)
        } else {
          const alt = element.getAttribute("alt")
          const childAria = element.querySelector?.("[aria-label]")?.getAttribute("aria-label") || element.querySelector?.("svg title")?.textContent || ""
          result = normalize(alt || safeText(element) || titleName(element) || childAria)
        }
        accessibleNameCache.set(element, result)
        return result
      }
      const roleFor = (element: Element): string => {
        const explicit = element.getAttribute("role")
        if (explicit) return explicit
        if (/^H[1-6]$/.test(element.tagName)) return "heading"
        if (element instanceof HTMLAnchorElement || (element.tagName.toLowerCase() === "a" && element.hasAttribute("href"))) return "link"
        if (element instanceof HTMLButtonElement) return "button"
        // Chromium exposes native disclosure controls without an ARIA button role.
        if (element.tagName === "SUMMARY") return "summary"
        if (element instanceof HTMLTextAreaElement) return "textbox"
        if (element instanceof HTMLSelectElement) return element.hasAttribute("multiple") || element.size > 1 ? "listbox" : "combobox"
        if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox") return "checkbox"
          if (element.type === "radio") return "radio"
          if (element.type === "number") return "spinbutton"
          if (element.type === "range") return "slider"
          if (["email", "search", "tel", "text", "url"].includes(element.type)) {
            const listId = element.getAttribute("list")?.trim().split(/\s+/)[0]
            const list = listId ? (element.getRootNode() as Document | ShadowRoot).getElementById(listId) : null
            if (list?.tagName === "DATALIST") return "combobox"
          }
          if (element.type === "search") return "searchbox"
          if (element.type === "button" || element.type === "submit" || element.type === "reset" || element.type === "file") return "button"
          return "textbox"
        }
        if (element instanceof HTMLDialogElement) return "dialog"
        if (element instanceof HTMLFieldSetElement || element.tagName === "DETAILS") return "group"
        if (element instanceof HTMLTableElement) return "table"
        if (element instanceof HTMLTableRowElement) return "row"
        if (element instanceof HTMLUListElement || element instanceof HTMLOListElement) return "list"
        if (element instanceof HTMLLIElement) return "listitem"
        if (element.tagName === "PRE" || element.tagName === "CODE") return "code"
        if (element.tagName === "NAV") return "navigation"
        return element.tagName.toLowerCase()
      }
      const structuralName = (element: Element, role: string): string => {
        const labelled = labelledName(element)
        if (labelled) return labelled
        if (element instanceof HTMLFieldSetElement) return normalize(element.querySelector(":scope > legend")?.textContent ?? "")
        if (element instanceof HTMLTableElement) return normalize(element.caption?.textContent ?? "")
        if (element instanceof HTMLDetailsElement) return normalize(element.querySelector(":scope > summary")?.textContent ?? "")
        if (role === "dialog" || role === "alertdialog" || role === "group") {
          return normalize(element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent ?? "")
        }
        if (role === "code") return normalize(element.textContent ?? "")
        if (role === "row") {
          const cells = Array.from(element.children).filter((child) => child.matches("th, td, [role='columnheader'], [role='rowheader'], [role='cell'], [role='gridcell']"))
          const values = cells.map((cell) => safeText(cell))
          if (values.length === 0) return safeText(element)
          const headerCells = cells.filter((cell) => cell.matches("th, [role='columnheader'], [role='rowheader']"))
          const table = element.closest("table, [role='table'], [role='grid']")
          const tableRows = table ? Array.from(table.querySelectorAll("tr, [role='row']")) : []
          const headerRow = tableRows.find((row) => {
            if (row === element) return false
            const rowCells = Array.from(row.children).filter((child) => child.matches("th, td, [role='columnheader'], [role='rowheader'], [role='cell'], [role='gridcell']"))
            return rowCells.length > 0 && (rowCells.every((cell) => cell.matches("th, [role='columnheader']")) || rowCells.some((cell) => cell.matches("th[scope='col'], [role='columnheader']")))
          })
          if (headerRow) {
            const headers = Array.from(headerRow.children)
              .filter((child) => child.matches("th, [role='columnheader']"))
              .map((cell) => safeText(cell))
            if (headers.length === values.length && headers.every(Boolean)) {
              return values.map((value, index) => `${headers[index]}: ${value}`).join(" | ")
            }
          }
          if (headerCells.length === cells.length) return values.join(" | ")
          if (headerCells.length > 0) {
            const headers = headerCells.map((cell) => safeText(cell)).filter(Boolean)
            const data = cells.filter((cell) => !headerCells.includes(cell)).map((cell) => safeText(cell)).filter(Boolean)
            return headers.length === 1 && data.length > 0 ? `${headers[0]}: ${data.join(" | ")}` : values.join(" | ")
          }
          return values.join(" | ")
        }
        if (role === "listitem") return safeText(element)
        return ""
      }
      let autoScopedMain = false
      const root = rootOrSettings instanceof Element
        ? rootOrSettings
        : (() => {
            if (settings.rootSelector) {
              const matches = document.querySelectorAll(settings.rootSelector)
              if (matches.length !== 1) {
                throw new Error(`snapshot within expects exactly one match for selector: ${settings.rootSelector}; got ${matches.length}`)
              }
              return matches[0] as Element
            }
            const fallbackRoot = (document.body ?? document.documentElement) as Element | null
            if (!fallbackRoot) return null
            const dialogs = Array.from(document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog']")).filter(isVisible)
            const modals = dialogs.filter((dialog) => dialog.matches(":modal, [aria-modal='true']"))
            if (modals.length === 1) return modals[0] as Element
            const isOpenListboxOrMenu = (menu: Element): boolean => {
              if (!isVisible(menu)) return false
              if (menu.getAttribute("aria-label") === "slider" || menu.getAttribute("aria-roledescription") === "carousel") return false
              const items = Array.from(menu.querySelectorAll("[role='option'], [role^='menuitem']")).filter(isVisible)
              return items.length > 0 && !items.some((item) => item.getAttribute("role") === "option" && item.querySelector?.("a[href], button"))
            }
            const portalMenus = Array.from(document.querySelectorAll("[role='listbox'], [role='menu']")).filter(isOpenListboxOrMenu)
            const mains = Array.from(document.querySelectorAll("main")).filter(isVisible)
            // Portals commonly sit beside main. Keep them in scope even when
            // several dialogs are open or the dialog is non-modal.
            if (dialogs.length > 0 || (mains.length === 1 && portalMenus.some((menu) => !mains[0]!.contains?.(menu)))) {
              return fallbackRoot
            }
            if (mains.length === 1) {
              autoScopedMain = true
              return mains[0] as Element
            }
            return fallbackRoot
          })()
      if (!root) {
        return { entries: [], truncated: false }
      }
      if ((settings.rootRole && roleFor(root) !== settings.rootRole) || (settings.rootName && accessibleName(root) !== settings.rootName)) {
        throw new Error("Snapshot ref no longer identifies the captured element; call snapshot() again")
      }
      const detailsFor = (element: Element): string | undefined => {
        const details: string[] = []
        if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox" || element.type === "radio") details.push(element.checked ? "checked" : "unchecked")
        }
        const ariaChecked = element.getAttribute("aria-checked")
        if ((ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed") && !(element instanceof HTMLInputElement)) {
          details.push(ariaChecked === "true" ? "checked" : ariaChecked === "false" ? "unchecked" : "checked=mixed")
        }
        if (element instanceof HTMLSelectElement) {
          const selected = element.selectedOptions[0]?.textContent
          if (selected) details.push(`selected="${quote(normalize(selected).slice(0, 80))}"`)
          details.push(`${element.options.length} options`)
        }
        if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
          if (element.disabled) details.push("disabled")
        }
        if (element.getAttribute("aria-disabled") === "true" && !details.includes("disabled")) {
          details.push("disabled")
        }
        const expanded = element.getAttribute("aria-expanded")
        if (expanded) details.push(`expanded=${expanded}`)
        if (element instanceof HTMLDetailsElement) details.push(`expanded=${element.open}`)
        if (element instanceof HTMLDialogElement) {
          details.push(`open=${element.open}`)
          const modal = element.getAttribute("aria-modal")
          if (modal) details.push(`modal=${modal}`)
        }
        if (element.tagName === "SUMMARY" && element.parentElement instanceof HTMLDetailsElement) details.push(`expanded=${element.parentElement.open}`)
        const selected = element.getAttribute("aria-selected")
        if (selected) details.push(`selected=${selected}`)
        const current = element.getAttribute("aria-current")
        if (current) details.push(`current=${current}`)
        if (element instanceof HTMLTableElement) details.push(`${element.rows.length} rows`)
        if (element instanceof HTMLUListElement || element instanceof HTMLOListElement) details.push(`${element.children.length} items`)
        if (element instanceof HTMLFieldSetElement) details.push(`${element.elements.length} controls`)
        return details.length ? details.join(" ") : undefined
      }
      const isShadowRoot = (node: unknown): node is ShadowRoot =>
        typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot
      const parentElementOrHost = (node: Element | null): Element | null => {
        if (!node) return null
        if (node.parentElement) return node.parentElement
        const rootNode = node.getRootNode?.()
        return isShadowRoot(rootNode) ? rootNode.host : null
      }
      const closestDeep = (element: Element, selector: string): Element | null => {
        let current: Element | null = element
        while (current) {
          const match = current.closest?.(selector) ?? null
          if (match) return match
          const rootNode = current.getRootNode?.()
          current = isShadowRoot(rootNode) ? rootNode.host : null
        }
        return null
      }
      const querySelectorAllDeep = (scope: Element | Document | ShadowRoot, selector: string): Element[] => {
        if (!scope.children) {
          return Array.from(scope.querySelectorAll(selector))
        }
        const results: Element[] = []
        const visit = (node: Element | Document | ShadowRoot) => {
          for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
            if (child.matches(selector)) results.push(child)
            if (child.shadowRoot) visit(child.shadowRoot)
            if (child.firstElementChild) visit(child)
          }
        }
        if (scope instanceof Element && scope.shadowRoot) visit(scope.shadowRoot)
        visit(scope)
        return results
      }
      const localCssCache = new WeakMap<Element, string>()
      const localCssPath = (element: Element, scope: Document | ShadowRoot): string => {
        const cached = localCssCache.get(element)
        if (cached !== undefined) return cached
        const compute = (): string => {
          const id = element.getAttribute("id")
          if (id) {
            const candidate = `#${CSS.escape(id)}`
            if (scope.querySelectorAll(candidate).length === 1) return candidate
          }
          for (const attribute of ["data-testid", "data-test-id", "data-test", "name", "aria-label", "placeholder"]) {
            const value = element.getAttribute(attribute)
            if (value) {
              const candidate = `[${attribute}="${CSS.escape(value)}"]`
              if (scope.querySelectorAll(candidate).length === 1) return candidate
            }
          }
          const tag = element.tagName.toLowerCase()
          const role = element.getAttribute("role")
          const roleSuffix = role ? `[role="${quote(role)}"]` : ""
          let checkedClasses = 0
          for (const className of element.classList ?? []) {
            if (className.includes(":") || className.includes("[") || className.includes("/")) continue
            if (++checkedClasses > 4) break
            const candidate = `${tag}.${CSS.escape(className)}${roleSuffix}`
            if (scope.querySelectorAll(candidate).length === 1) return candidate
          }
          const parent = element.parentElement
          if (!parent) {
            if (isShadowRoot(scope)) {
              const siblings = Array.from(scope.children).filter((sibling) => sibling.tagName === element.tagName)
              return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
            }
            return tag
          }
          const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName)
          return `${localCssPath(parent, scope)} > ${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
        }
        const result = compute()
        localCssCache.set(element, result)
        return result
      }
      const cssPath = (element: Element): string => {
        const rootNode = element.getRootNode?.()
        if (isShadowRoot(rootNode)) {
          return `${cssPath(rootNode.host)} >> ${localCssPath(element, rootNode)}`
        }
        return localCssPath(element, document)
      }
      const rootHeadings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")).map((heading) => {
        const candidate = /^H([1-6])$/.exec(heading.tagName)?.[1]
        return {
          heading,
          level: candidate ? Number(candidate) : Number(heading.getAttribute("aria-level") ?? 1),
        }
      })
      const headingDepthCache = new WeakMap<Element, number>()
      const headingDepth = (element: Element): number => {
        const cached = headingDepthCache.get(element)
        if (cached !== undefined) return cached
        const ownLevel = /^H([1-6])$/.exec(element.tagName)?.[1]
        if (ownLevel) {
          const depth = Number(ownLevel) - 1
          headingDepthCache.set(element, depth)
          return depth
        }
        let treeTarget = element
        while (isShadowRoot(treeTarget.getRootNode?.())) {
          treeTarget = (treeTarget.getRootNode() as ShadowRoot).host
        }
        let level = 0
        for (const { heading, level: candidateLevel } of rootHeadings) {
          if (heading === treeTarget || (heading.compareDocumentPosition(treeTarget) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
          level = candidateLevel
        }
        headingDepthCache.set(element, level)
        return level
      }

      const structuralSelector = "fieldset, [role='group'], dialog, [role='dialog'], [role='alertdialog'], [role='listbox'], [role='menu'], [role='tablist'], details, table, [role='table'], tr, [role='row'], ul, ol, [role='list'], li, [role='listitem'], pre"
      const interactiveSelector = [
        "a[href]", "button", "input", "textarea", "select", "summary",
        "[role='button']", "[role='link']", "[role='tab']",
        "[role='menuitem']", "[role='menuitemcheckbox']", "[role='menuitemradio']",
        "[role='option']", "[role='switch']", "[role='checkbox']", "[role='radio']",
        "[role='combobox']", "[role='searchbox']", "[role='textbox']",
        "[role='slider']", "[role='spinbutton']", "[role='treeitem']",
        "[contenteditable]",
      ].join(",")
      const structuralKeys = new WeakMap<Element, string>()
      let nextStructuralKey = 1
      const structuralKey = (element: Element): string => {
        const existing = structuralKeys.get(element)
        if (existing) return existing
        const key = `s${nextStructuralKey++}`
        structuralKeys.set(element, key)
        return key
      }
      const structuralParentKeys = (element: Element): string[] => {
        const keys: string[] = []
        let parent = parentElementOrHost(element)
        while (parent && parent !== root) {
          if (parent.matches(structuralSelector)) keys.push(structuralKey(parent))
          parent = parentElementOrHost(parent)
        }
        return keys
      }
      const primaryLinks = new WeakMap<Element, Element | null>()
      const isPrimaryLink = (element: Element): boolean => {
        if (
          element.closest?.("h1, h2, h3, h4, h5, h6, [role='heading']") ||
          element.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']")
        ) {
          return true
        }
        const group = element.closest("article, li, tr, dt, [role='listitem'], [role='row']")
        if (!group || !root.contains(group)) return false
        if (!primaryLinks.has(group)) {
          const rawLinks = Array.from(group.querySelectorAll("a[href]"))
          if (group.matches("article, [role='article']") && rawLinks.length > 12) {
            primaryLinks.set(group, null)
            return false
          }
          const links = rawLinks.filter(isVisible)
          let primary: Element | null = null
          let primaryScore = -1
          for (const link of links) {
            const name = accessibleName(link)
            const headingBonus = link.closest("h1, h2, h3, h4, h5, h6, [role='heading']") ? 1_000 : 0
            const commentBonus = /\b\d+\s+comments?\b/i.test(name) ? 500 : 0
            const score = name.length + headingBonus + commentBonus
            if (score > primaryScore) {
              primary = link
              primaryScore = score
            }
          }
          primaryLinks.set(group, primary)
        }
        if (primaryLinks.get(group) !== element) return false
        if (group.matches("tr, [role='row']")) {
          const groupTextLength = safeText(group).length
          return groupTextLength > 0 && accessibleName(element).length / groupTextLength >= 0.15
        }
        return true
      }
      const isLayoutTable = (table: Element | null): boolean => {
        if (!table || !settings.compact) return false
        if (table.querySelector?.("table, [role='table']")) return true
        const hasHeaders = Boolean(
          labelledName(table) ||
          (table as HTMLTableElement).caption ||
          table.querySelector?.("th, [role='columnheader'], [role='rowheader']"),
        )
        if (hasHeaders) return false
        const rowCount = table instanceof HTMLTableElement
          ? table.rows.length
          : table.querySelectorAll("tr, [role='row']").length
        return rowCount <= 1 || rowCount >= 20
      }
      const isRedundantHeadingForLink = (element: Element): boolean => {
        if (!settings.compact || element === root) return false
        const parentInteractive = element.closest?.("a[href], button, [role='button'], [role='option'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']")
        if (parentInteractive && (root.contains?.(parentInteractive) ?? true) && isVisible(parentInteractive)) {
          return true
        }
        const headingText = accessibleName(element)
        if (!headingText) return false
        const childLinks = Array.from(element.querySelectorAll?.("a[href]") ?? []).filter(isVisible)
        if (childLinks.length === 1) {
          const linkText = accessibleName(childLinks[0]!)
          if (linkText && (linkText === headingText || linkText.startsWith(headingText))) {
            return true
          }
        }
        const card = element.closest?.("article, [role='article']")
        if (card && (root.contains?.(card) ?? true)) {
          const rawCardLinks = Array.from(card.querySelectorAll("a[href]"))
          if (rawCardLinks.length <= 12 && rawCardLinks.filter(isVisible).some((link) => accessibleName(link) === headingText)) {
            return true
          }
        }
        return false
      }
      const seenCardLinks = new WeakMap<Element, Set<string>>()
      const isDuplicateCardLink = (element: Element, displayName: string): boolean => {
        if (!settings.compact || !displayName || !element.matches("a[href]")) return false
        const card = element.closest?.("article, [role='article'], li, [role='listitem'], tr, [role='row']")
        if (!card || !(root.contains?.(card) ?? true)) return false
        const href = element.getAttribute("href") ?? ""
        if (!href) return false
        let seen = seenCardLinks.get(card)
        if (!seen) {
          seen = new Set<string>()
          seenCardLinks.set(card, seen)
        }
        const key = `${href}\0${displayName}`
        if (seen.has(key)) return true
        seen.add(key)
        return false
      }
      const isRedundantListItem = (element: Element): boolean => {
        if (!settings.compact || element === root) return false
        if (element.querySelector?.("ul, ol, [role='list'], h1, h2, h3, h4, h5, h6, [role='heading']")) {
          return true
        }
        if (element.querySelector?.("p")) return false
        const controls = Array.from(element.querySelectorAll?.("a[href], button") ?? []).filter(isVisible)
        if (controls.length === 0) return false
        const itemLength = safeText(element).length
        return itemLength > 0 && controls.some((control) => accessibleName(control).length >= itemLength * 0.65)
      }
      const priorityFor = (options: { readonly role: string; readonly interactive: boolean; readonly primaryLink: boolean; readonly structuralEssential: boolean; readonly inActiveOverlay: boolean }): number => {
        if (options.role === "alert" || options.role === "status" || options.role === "navigation" || options.structuralEssential || options.inActiveOverlay) return -1
        if (options.role === "heading") return 0
        if (options.role === "link" && options.primaryLink) return 0
        if (options.interactive && (options.role !== "link" || options.primaryLink)) return 1
        if (options.role === "link") return 3
        return 2
      }

      type PendingEntry = BrowserEntry & { readonly interactiveElement?: Element }
      const entries: PendingEntry[] = []
      let truncated = false
      const add = (entry: PendingEntry): void => {
        if (entry.depth > settings.depth) return
        if (entries.length >= settings.maxCandidates) {
          truncated = true
          return
        }
        entries.push(entry)
      }
      const candidateSelector = [
        "h1", "h2", "h3", "h4", "h5", "h6", "[role='heading']",
        "nav", "[role='navigation']", "[role='alert']", "[role='status']", "p",
        structuralSelector,
        interactiveSelector,
      ].join(",")
      const headerSelector = "input, textarea, select, button, [role='searchbox'], [role='combobox'], [role='button'], a[href][aria-label]"
      const headerRoots = autoScopedMain && typeof document.querySelectorAll === "function"
        ? Array.from(document.querySelectorAll("header, [role='banner']")).filter((h) => isVisible(h) && !root.contains?.(h))
        : []
      const headerCandidateSet = new Set(
        headerRoots.flatMap((h) =>
          querySelectorAllDeep(h, headerSelector).filter((el) => !el.closest?.("nav, [role='navigation']")),
        ),
      )
      const candidates = [
        ...headerCandidateSet,
        ...(root.matches(candidateSelector) ? [root] : []),
        ...querySelectorAllDeep(root, candidateSelector),
      ]
      const collapsedNavigation = new Set<Element>()
      const nonCollapsibleNavigation = new WeakSet<Element>()
      let reservedLists = 0

      for (const element of candidates) {
        if (entries.length >= settings.maxCandidates) {
          truncated = true
          break
        }
        if (settings.compact && !headerCandidateSet.has(element)) {
          const navigation = closestDeep(element, "nav, [role='navigation'], aside, [role='complementary'], [data-slot='sidebar'], [data-sidebar='sidebar']")
          if (navigation && collapsedNavigation.has(navigation)) {
            continue
          }
          if (navigation && navigation !== root && !navigation.contains?.(root) && !nonCollapsibleNavigation.has(navigation)) {
            const isCollapsibleNav = isVisible(navigation) && (
              navigation.matches("nav, [role='navigation']") ||
              (querySelectorAllDeep(navigation, "a[href]").length >= 8 && !navigation.querySelector?.("h1, main, [role='main'], input, textarea, select"))
            )
            if (isCollapsibleNav) {
              collapsedNavigation.add(navigation)
              const count = querySelectorAllDeep(navigation, "a[href], button").length
              add({ depth: headingDepth(navigation), role: "navigation", name: truncate(labelledName(navigation), 100) || "Navigation", details: `${count} controls`, priority: 0 })
              continue
            }
            nonCollapsibleNavigation.add(navigation)
          }
        }
        if (!isVisible(element)) continue
        const role = roleFor(element)
        const isHeading = role === "heading"
        if (isHeading && isRedundantHeadingForLink(element)) continue
        if (
          role === "combobox" &&
          !(element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) &&
          element.querySelector?.("input, textarea, select")
        ) {
          continue
        }
        if (role === "option" && element.querySelector?.("a[href], button")) {
          continue
        }
        const isInteractive = element.matches(interactiveSelector)
        const isSafetyText = role === "alert" || role === "status"
        const isParagraph = element.matches("p")
        const isStructural = !isInteractive && element.matches(structuralSelector)
        if (isStructural) {
          if (role === "listbox" && (element.getAttribute("aria-label") === "slider" || element.getAttribute("aria-roledescription") === "carousel")) {
            continue
          }
          if (role === "listitem" && isRedundantListItem(element)) {
            continue
          }
          if (role === "table" && isLayoutTable(element)) {
            continue
          }
          if (role === "row" && (element.querySelector?.("table, [role='table']") || isLayoutTable(element.closest?.("table, [role='table']") ?? null))) {
            continue
          }
        }
        if (!isHeading && !isInteractive && !isSafetyText && !isStructural && (settings.interactive || !isParagraph)) continue
        if (settings.interactive && isParagraph && !isSafetyText) continue
        if (
          settings.compact &&
          isParagraph &&
          !isSafetyText &&
          element.parentElement?.matches("li, [role='listitem']") &&
          !isRedundantListItem(element.parentElement) &&
          safeText(element).length >= safeText(element.parentElement).length * 0.8
        ) {
          continue
        }
        const displayName = isStructural ? structuralName(element, role) : accessibleName(element)
        if (isInteractive && isDuplicateCardLink(element, displayName)) continue
        const nameFromAuthorOnly = role === "combobox" || role === "listbox" || role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "slider"
        const identityName = isInteractive
          ? (nameFromAuthorOnly ? authorAccessibleName(element) : displayName)
          : displayName
        const isDisabled = ((element as HTMLButtonElement).disabled === true) || element.getAttribute("aria-disabled") === "true"
        if (isInteractive && isDisabled && !displayName && !element.getAttribute("name")) continue
        const fallbackName = role === "group" ? "Group"
          : role === "dialog" || role === "alertdialog" ? "Dialog"
          : role === "listbox" ? "Listbox"
          : role === "menu" ? "Menu"
          : role === "table" ? "Table"
          : role === "list" ? "List"
          : role === "tablist" ? "Tab list"
          : isInteractive ? element.getAttribute("name") || element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-test") || role
          : ""
        const name = truncate(displayName || fallbackName, isParagraph || isSafetyText || isStructural ? 180 : 120)
        if (!name) continue
        const details = isHeading ? `level=${headingDepth(element) + 1}` : detailsFor(element)
        const primaryLink = (role === "link" && isPrimaryLink(element)) || headerCandidateSet.has(element)
        const baseDepth = headingDepth(element)
        const parentKeys = structuralParentKeys(element)
        const overlayAncestor = element.closest?.("dialog, [role='dialog'], [role='alertdialog'], [role='listbox'], [role='menu']") ?? null
        const inActiveOverlay = Boolean(
          (isInteractive || role === "dialog" || role === "alertdialog" || role === "listbox" || role === "menu") &&
          overlayAncestor &&
          overlayAncestor.getAttribute("aria-label") !== "slider" &&
          overlayAncestor.getAttribute("aria-roledescription") !== "carousel",
        )
        add({
          depth: baseDepth + parentKeys.length,
          baseDepth,
          ...(isStructural ? { key: structuralKey(element) } : {}),
          ...(parentKeys.length > 0 ? { parentKeys } : {}),
          role,
          name,
          ...(isInteractive && identityName ? { identityName } : {}),
          ...(isInteractive ? { interactiveElement: element } : {}),
          ...(details ? { details } : {}),
          priority: priorityFor({
            role: headerCandidateSet.has(element) ? "heading" : role,
            interactive: isInteractive,
            primaryLink,
            inActiveOverlay,
            // Repeated list wrappers and code blocks must not exhaust the budget before
            // headings, primary links, and interactive controls.
            structuralEssential: isStructural &&
              role !== "row" &&
              role !== "listitem" &&
              role !== "code" &&
              (role !== "group" || Boolean(displayName)) &&
              (role !== "list" || reservedLists++ < Math.max(1, Math.floor(settings.maxItems / 10))),
          }),
        })
      }
      const selected: BrowserEntry[] = entries
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => left.entry.priority - right.entry.priority || left.index - right.index)
        .slice(0, settings.maxItems)
        .sort((left, right) => left.index - right.index)
        .map(({ entry: { interactiveElement, ...rest } }) => ({
          ...rest,
          ...(interactiveElement ? { selector: cssPath(interactiveElement) } : {}),
        }))
      const needsSettle = Boolean(
        !settings.rootSelector &&
        typeof MutationObserver !== "undefined" &&
        document.body &&
        (
          Boolean(document.querySelector?.("[aria-busy='true'], .skeleton:not(.no-skeleton)")) ||
          (selected.length === 0 && typeof performance !== "undefined" && performance.now() < 2_500)
        ),
      )
      return {
        entries: selected,
        truncated: truncated || selected.length < entries.length,
        ...(needsSettle ? { needsSettle: true } : {}),
      }
    }
    // tsx/esbuild can inject calls to its module-scoped __name helper into this
    // callback. Playwright serializes only the callback, so provide that helper
    // inside the serialized function rather than leaking a build detail into the
    // page execution context.
    const browserCapture = new Function(
      "rootOrSettings",
      "locatorSettings",
      `const __name = (target) => target
return (${capture.toString()})(rootOrSettings, locatorSettings)`,
    ) as typeof capture
    const timeoutMs = options.timeout ?? defaultSnapshotTimeoutMs
    let result: Awaited<ReturnType<typeof capture>>
    if (locator) {
      result = await locator.evaluate(browserCapture, settings, { timeout: timeoutMs })
    } else {
      const deadline = Date.now() + timeoutMs
      let captureAttempts = 0
      while (true) {
        navigatedDuringCapture = false
        try {
          result = await Effect.runPromise(runPlaywrightOperation({
            label: "Compact snapshot",
            timeoutMs: Math.max(100, deadline - Date.now()),
            run: () => page.evaluate(browserCapture, settings),
          }))
          if (navigatedDuringCapture && !options.diff && ++captureAttempts < 3 && Date.now() + sessionPageHealthRetryDelayMs < deadline) {
            await delay(sessionPageHealthRetryDelayMs)
            continue
          }
          if (result.needsSettle && !options.diff && captureAttempts === 0 && Date.now() + 120 < deadline) {
            captureAttempts++
            await page.evaluate(`new Promise((resolve) => {
              let quietTimer = window.setTimeout(done, 120);
              const maxTimer = window.setTimeout(done, 550);
              const observer = new MutationObserver(() => {
                window.clearTimeout(quietTimer);
                quietTimer = window.setTimeout(done, 55);
              });
              function done() {
                observer.disconnect();
                window.clearTimeout(quietTimer);
                window.clearTimeout(maxTimer);
                resolve();
              }
              if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
              } else {
                done();
              }
            })`).catch(() => {})
            continue
          }
          break
        } catch (error) {
          if (withinSelector !== undefined && /not a valid selector|querySelectorAll/i.test(error instanceof Error ? error.message : String(error))) {
            result = await page.locator(withinSelector).evaluate(browserCapture, { ...settings, rootSelector: undefined }, { timeout: timeoutMs })
            break
          }
          const kind = runtimeFailureKind(error)
          if ((kind === "context-destroyed" || kind === "context-missing") && !options.diff && Date.now() + sessionPageHealthRetryDelayMs < deadline) {
            await delay(sessionPageHealthRetryDelayMs)
            continue
          }
          throw error
        }
      }
    }

    if (navigatedDuringCapture) {
      removeNavigationListener()
      delete registry.removeNavigationListener
      throw new Error("Page navigated while snapshot() was capturing; call snapshot() again")
    }
    registry.page = page
    registry.url = page.url()
    registry.selectors.clear()
    const structuralEntries = new Map(result.entries.flatMap((entry) => entry.key ? [[entry.key, entry] as const] : []))
    const resolvedDepths = new Map<SnapshotEntry, number>()
    const resolvedDepth = (entry: SnapshotEntry): number => {
      const cached = resolvedDepths.get(entry)
      if (cached !== undefined) return cached
      const parent = entry.parentKeys?.map((key) => structuralEntries.get(key)).find((candidate) => candidate !== undefined)
      const depth = parent ? resolvedDepth(parent) + 1 : entry.baseDepth ?? entry.depth
      resolvedDepths.set(entry, depth)
      return depth
    }
    const minimumDepth = result.entries.reduce((minimum, entry) => Math.min(minimum, resolvedDepth(entry)), Number.POSITIVE_INFINITY)
    const depthOffset = Number.isFinite(minimumDepth) ? minimumDepth : 0
    const rawEntries: SnapshotRenderedEntry[] = result.entries.map((entry) => {
      const name = entry.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      return {
        prefix: `${"  ".repeat(Math.max(0, resolvedDepth(entry) - depthOffset))}- ${entry.role} "${name}"`,
        ...(entry.details ? { details: entry.details } : {}),
        ...(entry.selector ? { selector: entry.selector, role: entry.role } : {}),
        ...(entry.identityName ? { identityName: entry.identityName } : {}),
      }
    })
    if (result.truncated) rawEntries.push({ prefix: `- ... truncated after ${maxItems} items` })

    const compatiblePrevious = previousSnapshot?.page === page && previousSnapshot.signature === signature
      ? previousSnapshot
      : undefined
    // Ref ids must not identify a new document or incompatible capture later.
    let nextRef = registry.nextRef ?? 1
    const reusableRefs = new Map<string, string[]>()
    for (const entry of compatiblePrevious?.entries ?? []) {
      if (!entry.refId) continue
      const key = snapshotRefIdentity(entry)
      if (!key) continue
      const refs = reusableRefs.get(key) ?? []
      refs.push(entry.refId)
      reusableRefs.set(key, refs)
    }
    const entries = rawEntries.map((entry): SnapshotRenderedEntry => {
      const key = snapshotRefIdentity(entry)
      if (!key) return entry
      const reused = reusableRefs.get(key)?.shift()
      return { ...entry, refId: reused ?? `e${nextRef++}` }
    })
    registry.nextRef = nextRef

    const registerRef = (entry: SnapshotRenderedEntry, id: string): void => {
      if (!entry.selector || !entry.role) return
      registry.selectors.set(id, {
        selector: entry.selector,
        role: entry.role,
        ...(entry.identityName ? { name: entry.identityName } : {}),
      })
    }

    for (const entry of entries) {
      if (entry.refId) registerRef(entry, entry.refId)
    }

    const useDiff = options.diff === true || (options.delta === true && compatiblePrevious !== undefined)
    if (!useDiff) {
      const lines = entries.map((entry) => {
        return formatSnapshotLine(entry, entry.refId)
      })
      registry.previousSnapshot = { page, signature, entries }
      return options.find === undefined
        ? lines.join("\n")
        : findSnapshotLines(lines, options.find, options.context)
    }

    const operations = diffSnapshotEntries(compatiblePrevious?.entries ?? [], entries)
    const lines: string[] = []
    let additions = 0
    let removals = 0
    let unchanged = 0
    for (const operation of operations) {
      if (operation.kind === "unchanged") {
        unchanged++
        continue
      }
      if (operation.kind === "removed") {
        removals++
        lines.push(formatSnapshotDiffLine("-", operation.entry))
        continue
      }
      additions++
      lines.push(formatSnapshotDiffLine("+", operation.entry, operation.entry.refId))
    }
    lines.push(`${additions} ${additions === 1 ? "addition" : "additions"}, ${removals} ${removals === 1 ? "removal" : "removals"}, ${unchanged} unchanged`)
    registry.previousSnapshot = { page, signature, entries }
    return lines.join("\n")
  }

  const ref: SnapshotRefHelper = (id) => {
    if (!Predicate.isString(id) || !id.trim()) {
      throw new Error(`Unknown snapshot ref: ${String(id)}; call snapshot() to get current refs`)
    }
    const normalized = id.startsWith("@") ? id.slice(1) : id
    if (registry.page !== page || registry.url !== page.url()) {
      throw new Error("Snapshot refs are stale after a page change; call snapshot() again")
    }
    const snapshotRef = registry.selectors.get(normalized)
    if (!snapshotRef) {
      throw new Error(`Unknown snapshot ref: ${id}; call snapshot() to get current refs`)
    }
    const locator = page.locator(snapshotRef.selector)
    const role = snapshotRefAriaRole(snapshotRef.role)
    const resolved = role
      ? locator.and(page.getByRole(role, snapshotRef.name ? { name: snapshotRef.name, exact: true } : undefined))
      : locator
    refRoots.set(resolved, snapshotRef)
    return resolved
  }

  return { snapshot, ref }
}

function snapshotRefIdentity(entry: SnapshotRenderedEntry): string | undefined {
  if (!entry.selector || !entry.role) return undefined
  return JSON.stringify([entry.selector, entry.role, entry.identityName ?? null])
}

function findSnapshotLines(lines: readonly string[], query: string | RegExp, requestedContext: number | undefined): string {
  const context = Math.max(0, Math.min(10, Math.floor(requestedContext ?? 2)))
  const matches: number[] = []
  for (const [index, line] of lines.entries()) {
    const matched = Predicate.isString(query)
      ? line.toLowerCase().includes(query.toLowerCase())
      : (() => {
          query.lastIndex = 0
          return query.test(line)
        })()
    if (matched) matches.push(index)
  }
  if (matches.length === 0) {
    return `No snapshot lines matched ${Predicate.isString(query) ? JSON.stringify(query) : query.toString()}.`
  }
  const included = new Set<number>()
  for (const index of matches) {
    for (let candidate = Math.max(0, index - context); candidate <= Math.min(lines.length - 1, index + context); candidate++) {
      included.add(candidate)
    }
  }
  const output: string[] = []
  let previous = -2
  for (const index of [...included].sort((left, right) => left - right)) {
    if (index > previous + 1) output.push("...")
    output.push(lines[index]!)
    previous = index
  }
  return [`${matches.length} matching snapshot ${matches.length === 1 ? "line" : "lines"}:`, ...output].join("\n")
}

function formatSnapshotLine(entry: SnapshotRenderedEntry, id?: string): string {
  const suffix = [id ? `ref=${id}` : undefined, entry.details].filter(Boolean).join(" ")
  return `${entry.prefix}${suffix ? ` [${suffix}]` : ""}`
}

function formatSnapshotDiffLine(marker: "+" | "-", entry: SnapshotRenderedEntry, id?: string): string {
  const line = formatSnapshotLine(entry, id)
  const bullet = /^(\s*)- (.*)$/.exec(line)
  return bullet ? `${marker} ${bullet[1]}${bullet[2]}` : `${marker} ${line}`
}

function diffSnapshotEntries(
  previous: readonly SnapshotRenderedEntry[],
  current: readonly SnapshotRenderedEntry[],
): readonly (
  | { readonly kind: "unchanged"; readonly entry: SnapshotRenderedEntry }
  | { readonly kind: "removed"; readonly entry: SnapshotRenderedEntry }
  | { readonly kind: "added"; readonly entry: SnapshotRenderedEntry }
)[] {
  const previousLines = previous.map((entry) => formatSnapshotLine(entry))
  const currentLines = current.map((entry) => formatSnapshotLine(entry))
  const lengths = Array.from({ length: previous.length + 1 }, () => Array<number>(current.length + 1).fill(0))
  for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex--) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex--) {
      lengths[previousIndex]![currentIndex] = previousLines[previousIndex] === currentLines[currentIndex]
        ? lengths[previousIndex + 1]![currentIndex + 1]! + 1
        : Math.max(lengths[previousIndex + 1]![currentIndex]!, lengths[previousIndex]![currentIndex + 1]!)
    }
  }

  const operations: Array<
    | { readonly kind: "unchanged"; readonly entry: SnapshotRenderedEntry }
    | { readonly kind: "removed"; readonly entry: SnapshotRenderedEntry }
    | { readonly kind: "added"; readonly entry: SnapshotRenderedEntry }
  > = []
  let previousIndex = 0
  let currentIndex = 0
  while (previousIndex < previous.length || currentIndex < current.length) {
    if (
      previousIndex < previous.length &&
      currentIndex < current.length &&
      previousLines[previousIndex] === currentLines[currentIndex]
    ) {
      operations.push({ kind: "unchanged", entry: current[currentIndex]! })
      previousIndex++
      currentIndex++
      continue
    }
    if (
      previousIndex < previous.length &&
      (currentIndex >= current.length || lengths[previousIndex + 1]![currentIndex]! >= lengths[previousIndex]![currentIndex + 1]!)
    ) {
      operations.push({ kind: "removed", entry: previous[previousIndex]! })
      previousIndex++
      continue
    }
    operations.push({ kind: "added", entry: current[currentIndex]! })
    currentIndex++
  }
  return operations
}

function snapshotRefAriaRole(role: string): Parameters<Page["getByRole"]>[0] | undefined {
  switch (role) {
    case "button":
    case "checkbox":
    case "combobox":
    case "link":
    case "listbox":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "option":
    case "radio":
    case "searchbox":
    case "slider":
    case "spinbutton":
    case "switch":
    case "tab":
    case "textbox":
    case "treeitem":
      return role
    default:
      return undefined
  }
}

async function fillInput(options: { readonly page: Page; readonly target: InputTarget; readonly value: string }): Promise<void> {
  if (Predicate.isString(options.target)) {
    await fillInputs(options.page, [{ selector: options.target, value: options.value }])
    return
  }
  const locator = options.target
  await locator.evaluate((element, nextValue) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
      const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, nextValue)
      } else {
        element.value = nextValue
      }
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = nextValue
    } else {
      throw new Error("fillInput expects an input, textarea, or contenteditable locator")
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }, options.value, { timeout: 30_000 })
}

export async function fillInputs(page: Page, fields: ReadonlyArray<InputField>): Promise<void> {
  const locatorHandles: ElementHandle[] = []
  try {
    const resolvedFields: Array<{ readonly target: string | ElementHandle; readonly label: string; readonly value: string }> = []
    for (const field of fields) {
      if (Predicate.isString(field.selector)) {
        resolvedFields.push({ target: field.selector, label: `selector: ${field.selector}`, value: field.value })
        continue
      }
      const matches = await field.selector.elementHandles()
      locatorHandles.push(...matches)
      if (matches.length !== 1) {
        throw new Error(`fillInputs expects exactly one match for locator; got ${matches.length}`)
      }
      resolvedFields.push({ target: matches[0]!, label: "locator", value: field.value })
    }

    await page.evaluate((inputFields) => {
      return inputFields.map((field) => {
        let element: Node | undefined
        if (typeof field.target === "string") {
          const matches: Element[] = []
          const roots: Array<Document | ShadowRoot> = [document]
          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index]
            if (!root) continue
            matches.push(...root.querySelectorAll(field.target))
            for (const candidate of root.querySelectorAll("*")) {
              if (candidate.shadowRoot) roots.push(candidate.shadowRoot)
            }
          }
          if (matches.length !== 1) {
            if (matches.length === 0) {
              throw new Error(`fillInputs found no match for ${field.label} in the document or open shadow roots; closed shadow roots are unavailable. Try locator.fill() if Playwright can resolve the field.`)
            }
            throw new Error(`fillInputs expects exactly one match for ${field.label}; got ${matches.length}`)
          }
          element = matches[0]
        } else {
          element = field.target
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
          const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
          const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
          if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, field.value)
          } else {
            element.value = field.value
          }
        } else if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = field.value
        } else {
          throw new Error(`fillInputs expects input, textarea, or contenteditable ${field.label}`)
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: field.value }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
        return field.label
      })
    }, resolvedFields)
  } finally {
    await Promise.all(locatorHandles.map((handle) => handle.dispose().catch(() => {})))
  }
}

async function screenshotWithLabels(options: ScreenshotWithLabelsOptions = {}): Promise<ScreenshotWithLabelsResult> {
  if (!options.page) {
    throw new Error("screenshotWithLabels requires a page")
  }
  if (options.path !== undefined && !path.isAbsolute(options.path)) {
    throw new Error("screenshotWithLabels requires an absolute path")
  }

  const page = options.page
  const labels = await showScreenshotLabels(page)
  if (options.registry) {
    const registry = options.registry
    registry.removeNavigationListener?.()
    registry.selectors.clear()
    registry.page = page
    registry.url = page.url()
    for (const label of labels) {
      registry.selectors.set(label.ref, {
        selector: label.selector,
        role: "screenshot-label",
      })
    }
    const onFrameNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return
      invalidateSnapshotDocument(registry)
    }
    const removeNavigationListener = () => page.off("framenavigated", onFrameNavigated)
    page.on("framenavigated", onFrameNavigated)
    registry.removeNavigationListener = removeNavigationListener
  }
  try {
    const screenshot = await page.screenshot(options.path ? { path: options.path } : {})
    return {
      ...(options.path ? { path: options.path } : { image: screenshot }),
      size: screenshot.byteLength,
      labelCount: labels.length,
      labels,
    }
  } finally {
    await hideScreenshotLabels(page)
  }
}

async function showScreenshotLabels(page: Page): Promise<readonly ScreenshotLabel[]> {
  return await page.evaluate(() => {
    type BrowserLabel = {
      readonly ref: string
      readonly selector: string
      readonly role: string
      readonly text: string
      readonly context?: string
      readonly tagName: string
      readonly rect: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
    }

    const containerId = "__browser_control_screenshot_labels__"
    const markerClass = "__browser_control_screenshot_label__"
    const browserControlWindow = window as Window & { __browserControlScreenshotLabelsTimer?: number }
    if (browserControlWindow.__browserControlScreenshotLabelsTimer) {
      window.clearTimeout(browserControlWindow.__browserControlScreenshotLabelsTimer)
      delete browserControlWindow.__browserControlScreenshotLabelsTimer
    }
    document.getElementById(containerId)?.remove()

    const selectors = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      "[onclick]",
      "[contenteditable]",
    ]
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        if (rect.width < 4 || rect.height < 4) {
          return false
        }
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
          return false
        }
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0"
      })
      .slice(0, 80)

    const selectorForElement = (element: Element): string => {
      const id = element.getAttribute("id")
      if (id) {
        return `#${CSS.escape(id)}`
      }
      const testId = element.getAttribute("data-testid")
      if (testId) {
        return `[data-testid="${CSS.escape(testId)}"]`
      }
      const dataTest = element.getAttribute("data-test")
      if (dataTest) {
        return `[data-test="${CSS.escape(dataTest)}"]`
      }
      const name = element.getAttribute("name")
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
      }
      const parent = element.parentElement
      if (!parent) {
        return element.tagName.toLowerCase()
      }
      const siblings = Array.from(parent.children).filter((child) => {
        return child.tagName === element.tagName
      })
      const index = siblings.indexOf(element) + 1
      return `${selectorForElement(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`
    }

    const roleForElement = (element: Element): string => {
      const explicitRole = element.getAttribute("role")
      if (explicitRole) {
        return explicitRole
      }
      if (element instanceof HTMLAnchorElement) {
        return "link"
      }
      if (element instanceof HTMLButtonElement) {
        return "button"
      }
      if (element instanceof HTMLInputElement) {
        return element.type || "input"
      }
      if (element instanceof HTMLTextAreaElement) {
        return "textarea"
      }
      if (element instanceof HTMLSelectElement) {
        return "select"
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return "contenteditable"
      }
      return element.getAttribute("onclick") ? "onclick" : element.tagName.toLowerCase()
    }

    const textForElement = (element: Element): string => {
      const ariaLabel = element.getAttribute("aria-label")
      const title = element.getAttribute("title")
      const placeholder = element.getAttribute("placeholder")
      const value = element instanceof HTMLInputElement ? element.value : ""
      return (ariaLabel || placeholder || value || title || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
    }

    const normalizeText = (value: string): string => {
      return value.replace(/\s+/g, " ").trim()
    }

    const trimContext = (value: string): string => {
      return normalizeText(value).slice(0, 60)
    }

    const accessibleTextForElement = (element: Element): string => {
      const ariaLabel = element.getAttribute("aria-label")
      if (ariaLabel) {
        return ariaLabel
      }
      const labelledBy = element.getAttribute("aria-labelledby")
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
        if (normalizeText(text)) {
          return text
        }
      }
      if (element instanceof HTMLFieldSetElement) {
        const legend = element.querySelector(":scope > legend")
        if (legend?.textContent) {
          return legend.textContent
        }
      }
      const heading = element.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")
      if (heading?.textContent) {
        return heading.textContent
      }
      return element.textContent ?? ""
    }

    const nearestPrecedingHeading = (element: Element): string => {
      const elementRect = element.getBoundingClientRect()
      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"))
      let nearest: Element | undefined
      let nearestDistance = Number.POSITIVE_INFINITY
      for (const heading of headings) {
        const rect = heading.getBoundingClientRect()
        if (rect.bottom > elementRect.top || rect.right < 0 || rect.left > window.innerWidth) {
          continue
        }
        const distance = elementRect.top - rect.bottom
        if (distance < nearestDistance) {
          nearest = heading
          nearestDistance = distance
        }
      }
      return nearest?.textContent ?? ""
    }

    const contextForElement = (element: Element, ownText: string): string | undefined => {
      const contextElement = element.closest("tr, [role='row'], li, [role='listitem'], fieldset, section, article, form, [aria-label], [aria-labelledby]")
      const rawContext = contextElement && contextElement !== element
        ? accessibleTextForElement(contextElement)
        : nearestPrecedingHeading(element)
      const context = trimContext(rawContext)
      const label = trimContext(ownText)
      if (!context || context.toLowerCase() === label.toLowerCase()) {
        return undefined
      }
      return context
    }

    const labels: BrowserLabel[] = candidates.map((element, index) => {
      const rect = element.getBoundingClientRect()
      const text = textForElement(element)
      const context = contextForElement(element, text)
      return {
        ref: `e${index + 1}`,
        selector: selectorForElement(element),
        role: roleForElement(element),
        text,
        ...(context ? { context } : {}),
        tagName: element.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    })

    const container = document.createElement("div")
    container.id = containerId
    container.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"

    const style = document.createElement("style")
    style.textContent = `
      .${markerClass} {
        position: fixed;
        min-width: 18px;
        box-sizing: border-box;
        padding: 1px 4px;
        border: 1px solid #7c3aed;
        border-radius: 4px;
        background: #a78bfa;
        color: #111827;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        box-shadow: 0 1px 3px rgba(17, 24, 39, 0.35);
      }
    `
    container.appendChild(style)

    const markers = labels.map((label) => {
      const marker = document.createElement("div")
      marker.className = markerClass
      marker.textContent = label.ref
      marker.style.left = `${Math.max(0, label.rect.x)}px`
      marker.style.top = `${Math.max(0, label.rect.y - 18)}px`
      return marker
    })
    container.append(...markers)

    document.documentElement.appendChild(container)
    browserControlWindow.__browserControlScreenshotLabelsTimer = window.setTimeout(() => {
      document.getElementById(containerId)?.remove()
      delete browserControlWindow.__browserControlScreenshotLabelsTimer
    }, 30_000)
    return labels
  })
}

async function hideScreenshotLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserControlWindow = window as Window & { __browserControlScreenshotLabelsTimer?: number }
    if (browserControlWindow.__browserControlScreenshotLabelsTimer) {
      window.clearTimeout(browserControlWindow.__browserControlScreenshotLabelsTimer)
      delete browserControlWindow.__browserControlScreenshotLabelsTimer
    }
    document.getElementById("__browser_control_screenshot_labels__")?.remove()
  })
}

const maxTrackedNavigations = 25
const maxCapturedPageLogs = 50
const maxCapturedScriptLogs = 100

type ExecuteLogCaptureSnapshot = {
  readonly logs: readonly ExecuteLogEntry[]
  readonly summary: ExecuteLogSummary
  readonly consoleErrorCount: number
  readonly pageErrorCount: number
}

export function createExecuteLogCapture(limits: {
  readonly page?: number
  readonly script?: number
} = {}): {
  readonly add: (entry: ExecuteLogEntry) => void
  readonly snapshot: () => ExecuteLogCaptureSnapshot
} {
  const pageLimit = limits.page ?? maxCapturedPageLogs
  const scriptLimit = limits.script ?? maxCapturedScriptLogs
  const logs: ExecuteLogEntry[] = []
  const pageEntryIndexes = new Map<string, number>()
  let pageEntries = 0
  let scriptEntries = 0
  let totalCount = 0
  let repeatedCount = 0
  let omittedCount = 0
  let consoleErrorCount = 0
  let pageErrorCount = 0

  const add = (entry: ExecuteLogEntry): void => {
    totalCount += 1
    if (entry.type === "error") {
      consoleErrorCount += 1
    } else if (entry.type === "pageerror") {
      pageErrorCount += 1
    }

    if (entry.source === "page") {
      const key = pageLogKey(entry)
      const existingIndex = pageEntryIndexes.get(key)
      if (existingIndex !== undefined) {
        const existing = logs[existingIndex]
        if (existing) {
          logs[existingIndex] = { ...existing, repeatCount: (existing.repeatCount ?? 0) + 1 }
          repeatedCount += 1
          return
        }
      }
      if (pageEntries >= pageLimit) {
        omittedCount += 1
        return
      }
      pageEntryIndexes.set(key, logs.length)
      pageEntries += 1
      logs.push(entry)
      return
    }

    if (scriptEntries >= scriptLimit) {
      omittedCount += 1
      return
    }
    scriptEntries += 1
    logs.push(entry)
  }

  return {
    add,
    snapshot: () => ({
      logs: [...logs],
      summary: {
        totalCount,
        returnedCount: logs.length,
        repeatedCount,
        omittedCount,
      },
      consoleErrorCount,
      pageErrorCount,
    }),
  }
}

function pageLogKey(entry: ExecuteLogEntry): string {
  const routineCategory = routinePageLogCategory(entry)
  if (routineCategory) {
    return JSON.stringify([entry.type, routineCategory])
  }
  return JSON.stringify([
    entry.type,
    entry.text,
    entry.location?.url ?? null,
    entry.location?.lineNumber ?? null,
    entry.location?.columnNumber ?? null,
  ])
}

function routinePageLogCategory(entry: ExecuteLogEntry): string | undefined {
  if (entry.source !== "page") return undefined
  const text = entry.text.toLowerCase()
  if (/^(?:error with permissions-policy header|permissions-policy header warning|permissions policy violation|\[violation\] potential permissions policy violation)/.test(text)) {
    return "browser-permissions-policy"
  }
  if (!text.includes("err_blocked_by_client")) return undefined
  const resource = entry.location?.url.toLowerCase() ?? ""
  const analyticsMarkers = [
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "connect.facebook.net",
    "/analytics",
    "analytics.",
  ]
  return analyticsMarkers.some((marker) => resource.includes(marker)) ? "blocked-analytics-resource" : undefined
}

function emptyExecuteLogSummary(): ExecuteLogSummary {
  return {
    totalCount: 0,
    returnedCount: 0,
    repeatedCount: 0,
    omittedCount: 0,
  }
}

function formatLogCompactionWarning(summary: ExecuteLogSummary): string | undefined {
  if (summary.repeatedCount === 0 && summary.omittedCount === 0) {
    return undefined
  }
  return `Captured ${summary.totalCount} console/page events: returned ${summary.returnedCount}, folded ${summary.repeatedCount} repeated page entries, and omitted ${summary.omittedCount} after limits (page=${maxCapturedPageLogs}, script=${maxCapturedScriptLogs}). Aftermath error counts include all events.`
}

const pageOnlyGlobalPattern = /^(window|document|localStorage|sessionStorage|location|navigator|getComputedStyle) is not defined$/

/** Explain failures caused by treating Node-side execute code as page code. */
export function formatNodeContextWarning(error: Error): string | undefined {
  const pageGlobal = error.name === "ReferenceError" ? pageOnlyGlobalPattern.exec(error.message)?.[1] : undefined
  if (pageGlobal) {
    return `Execute code runs in Node, where \`${pageGlobal}\` is undefined. Read page globals inside page.evaluate(() => ...).`
  }
  if (error.name === "TypeError" && error.message.startsWith("Failed to parse URL from ")) {
    return "Execute code runs in Node, so fetch has no page origin or cookies. Use page.evaluate(() => fetch(...)) for same-origin requests."
  }
  if (error.name === "TypeError" && /The "cb" argument must be of type function/i.test(error.message)) {
    return "The execute `fs` alias is callback-style `node:fs`; use `await fs.promises.writeFile(...)` / `await fs.promises.readFile(...)` or `fs.writeFileSync(...)`."
  }
  return undefined
}

const pointerInterceptionPattern = /(<[a-zA-Z][^>\n]*>[^\n]*?)\s+intercepts pointer events/
const locatorFailurePattern = /waiting for locator\(|waiting for getBy|strict mode violation:/i

/** Extract the covering element when Playwright times out because another element intercepts pointer events. */
export function formatPointerInterceptionWarning(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const blocker = pointerInterceptionPattern.exec(error.message)?.[1]
  if (!blocker) return undefined
  return `Pointer action was blocked because ${blocker} intercepts pointer events. Dismiss the covering dialog/banner or scroll the target clear of sticky chrome instead of retrying the same click.`
}

function formatBoundedPageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.origin === "null" ? rawUrl.slice(0, 96) : `${parsed.origin}${parsed.pathname}`.slice(0, 120)
  } catch {
    return rawUrl.slice(0, 96)
  }
}

function formatLocatorFailurePageWarning(
  error: unknown,
  aftermath: ExecuteAftermath | undefined,
  recreatedFromClosedUrl?: string,
): string | undefined {
  if (!(error instanceof Error) || !locatorFailurePattern.test(error.message)) return undefined
  const rawUrl = aftermath?.endUrl ?? aftermath?.startUrl
  if (rawUrl !== "about:blank") return undefined
  if (recreatedFromClosedUrl) {
    return `Locator failed on about:blank because the previous session page (${formatBoundedPageUrl(recreatedFromClosedUrl)}) was closed. Call page.goto(...) to reopen it before querying controls.`
  }
  return "Locator failed on page about:blank. Navigate with page.goto(...) or adopt an attached tab before querying controls."
}

export async function runUserCode({ code, globals }: { readonly code: string; readonly globals: SandboxGlobals }): Promise<{
  readonly result: unknown
  readonly logs: readonly ExecuteLogEntry[]
  readonly logSummary: ExecuteLogSummary
  readonly aftermath: ExecuteAftermath
}> {
  const logCapture = createExecuteLogCapture()
  const navigations: string[] = []
  const onConsole = (message: ConsoleMessage) => {
    logCapture.add({
      source: "page",
      type: message.type(),
      text: message.text(),
      location: message.location(),
    })
  }
  const onPageError = (error: Error) => {
    logCapture.add({
      source: "page",
      type: "pageerror",
      text: error.stack ?? error.message,
    })
  }
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== globals.page.mainFrame() || navigations.length >= maxTrackedNavigations) {
      return
    }
    navigations.push(frame.url())
  }
  const sandboxConsole = createSandboxConsole({ addLog: logCapture.add })
  const startUrl = safePageUrl(globals.page)
  globals.page.on("console", onConsole)
  globals.page.on("pageerror", onPageError)
  globals.page.on("framenavigated", onFrameNavigated)
  const buildResultMetadata = () => {
    const captured = logCapture.snapshot()
    return {
      logs: captured.logs,
      logSummary: captured.summary,
      aftermath: {
        startUrl,
        endUrl: safePageUrl(globals.page),
        navigations,
        consoleErrorCount: captured.consoleErrorCount,
        pageErrorCount: captured.pageErrorCount,
        handoffs: globals.handoffTracker.count,
      },
    } satisfies { readonly logs: readonly ExecuteLogEntry[]; readonly logSummary: ExecuteLogSummary; readonly aftermath: ExecuteAftermath }
  }
  try {
    const AsyncFunction = async function () {}.constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction("console", ...sandboxGlobalKeys, wrapCodeWithModuleAliases(code))
    const result = await fn(sandboxConsole, ...sandboxGlobalKeys.map((key) => globals[key]))
    return { result, ...buildResultMetadata() }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("execute sandbox code", { cause })
    const metadata = buildResultMetadata()
    throw new ExecuteCodeError(error, metadata.logs, metadata.logSummary, metadata.aftermath)
  } finally {
    globals.page.off("console", onConsole)
    globals.page.off("pageerror", onPageError)
    globals.page.off("framenavigated", onFrameNavigated)
  }
}

const sandboxGlobalKeys = [
  "browser",
  "context",
  "page",
  "state",
  "modules",
  "fillInput",
  "fillInputs",
  "screenshotWithLabels",
  "screenshotDiff",
  "ariaSnapshot",
  "snapshot",
  "ref",
  "webmcp",
  "showGhostCursor",
  "hideGhostCursor",
  "ghostCursor",
  "handoff",
  "demonstrate",
  "network",
] as const satisfies readonly (keyof Omit<SandboxGlobals, "handoffTracker">)[]

function safePageUrl(page: Page): string | null {
  try {
    return page.isClosed() ? null : page.url()
  } catch {
    return null
  }
}

function createSandboxConsole(options: { readonly addLog: (entry: ExecuteLogEntry) => void }): Pick<Console, "debug" | "error" | "info" | "log" | "warn"> {
  const capture = (type: ExecuteLogEntry["type"], values: readonly unknown[]) => {
    options.addLog({
      source: "script",
      type,
      text: values.map(formatLogValue).join(" "),
    })
  }
  return {
    debug: (...values: readonly unknown[]) => {
      capture("debug", values)
    },
    error: (...values: readonly unknown[]) => {
      capture("error", values)
    },
    info: (...values: readonly unknown[]) => {
      capture("info", values)
    },
    log: (...values: readonly unknown[]) => {
      capture("log", values)
    },
    warn: (...values: readonly unknown[]) => {
      capture("warn", values)
    },
  }
}

function formatLogValue(value: unknown): string {
  if (Predicate.isString(value)) {
    return value
  }
  return util.inspect(value, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000 })
}

export function getAutoReturnExpression(code: string): string | null {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      sourceType: "script",
    })
    if (ast.body.length !== 1) {
      return null
    }
    const statement = ast.body[0]
    if (statement?.type !== "ExpressionStatement") {
      return null
    }
    const expression = statement.expression
    if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") {
      return null
    }
    if (expression.type === "UnaryExpression" && expression.operator === "delete") {
      return null
    }
    if (expression.type === "SequenceExpression" && expression.expressions.some((item) => {
      return item.type === "AssignmentExpression"
    })) {
      return null
    }
    return code.slice(expression.start, expression.end)
  } catch {
    return null
  }
}

export function wrapCode(code: string): string {
  const expression = getAutoReturnExpression(code)
  if (expression) {
    return `return await (${expression})`
  }
  return code
}

function wrapCodeWithModuleAliases(code: string): string {
  return `const { ${nodeModuleAliases} } = modules;\n{\n${wrapCode(code)}\n}`
}

function stringifyResult(result: unknown): string {
  if (Predicate.isString(result)) {
    return result
  }
  if (result === undefined) {
    return "undefined"
  }
  return util.inspect(result, { depth: 3, colors: false, maxArrayLength: 50, maxStringLength: 4000 })
}

type JsonSafeResult =
  | { readonly serializable: true; readonly value: unknown }
  | { readonly serializable: false; readonly reason: string }

const maxJsonSafeDepth = 8
const maxJsonSafeBytes = 32 * 1024

export function extractExecuteMedia(value: unknown): { readonly value: unknown; readonly media: readonly ExecuteMedia[] } {
  const media: ExecuteMedia[] = []
  const seen = new WeakMap<object, unknown>()

  const replace = (item: unknown): unknown => {
    if (Buffer.isBuffer(item)) {
      const mimeType = imageMimeType(item)
      if (!mimeType) return item
      const image = {
        type: "image" as const,
        mimeType,
        data: item.toString("base64"),
        size: item.byteLength,
      }
      media.push(image)
      return { type: image.type, mimeType: image.mimeType, size: image.size }
    }
    if (!Predicate.isObjectOrArray(item)) return item
    const previous = seen.get(item)
    if (previous !== undefined) return previous
    if (Array.isArray(item)) {
      const output: unknown[] = []
      seen.set(item, output)
      for (const value of item) output.push(replace(value))
      return output
    }
    if (item instanceof Map) {
      const output = new Map<unknown, unknown>()
      seen.set(item, output)
      for (const [key, value] of item) output.set(replace(key), replace(value))
      return output
    }
    if (item instanceof Set) {
      const output = new Set<unknown>()
      seen.set(item, output)
      for (const value of item) output.add(replace(value))
      return output
    }
    if (!isPlainJsonContainer(item)) return item
    const output: Record<string, unknown> = {}
    seen.set(item, output)
    for (const key of safeObjectKeys(item) ?? []) {
      try {
        output[key] = replace(item[key as keyof typeof item])
      } catch {
        // Match structured-result conversion: skip inaccessible properties.
      }
    }
    return output
  }

  return { value: replace(value), media }
}

function imageMimeType(value: Buffer): string | undefined {
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
    return "image/jpeg"
  }
  if (value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp"
  }
  return undefined
}

/**
 * Best-effort structured execute value for machine consumers.
 *
 * Only plain JSON-ish data is preserved, with Map converted to a plain object
 * when all keys are strings and Set converted to an array. Class instances (for
 * example Playwright Page/Locator/Response objects) are not serialized: a
 * top-level instance omits `value` entirely, while nested instances are omitted
 * from object branches and become `null` in array branches. Throwing proxies or
 * other unexpected conversion failures also omit `value`; throwing getters on
 * otherwise plain objects are skipped property-by-property. Oversized values are
 * also omitted so `value` stays compact for agents; `text` remains the human
 * fallback for every result.
 */
export function toJsonSafeValue(value: unknown): JsonSafeResult {
  try {
    const seen = new WeakSet<object>()
    const converted = convertJsonSafe(value, { seen, depth: 0 })
    if (converted.omit) {
      return { serializable: false, reason: converted.reason }
    }
    const jsonText = safeJsonStringify(converted.value)
    if (jsonText === undefined) {
      return { serializable: false, reason: "JSON serialization failed" }
    }
    if (Buffer.byteLength(jsonText, "utf8") > maxJsonSafeBytes) {
      return { serializable: false, reason: `JSON value exceeds ${maxJsonSafeBytes} bytes` }
    }
    return { serializable: true, value: converted.value }
  } catch (cause) {
    return { serializable: false, reason: cause instanceof Error && cause.message ? cause.message : "JSON conversion failed" }
  }
}

type JsonSafeConversion =
  | { readonly omit: false; readonly value: unknown }
  | { readonly omit: true; readonly reason: string }

function convertJsonSafe(value: unknown, options: { readonly seen: WeakSet<object>; readonly depth: number }): JsonSafeConversion {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) {
    return { omit: false, value }
  }
  if (Predicate.isNumber(value)) {
    return { omit: false, value: Number.isFinite(value) ? value : null }
  }
  if (Predicate.isBigInt(value)) {
    return { omit: false, value: value.toString() }
  }
  if (value === undefined) {
    return { omit: true, reason: "undefined" }
  }
  if (Predicate.isFunction(value)) {
    return { omit: true, reason: "function value" }
  }
  if (Predicate.isSymbol(value)) {
    return { omit: true, reason: "symbol value" }
  }
  if (!Predicate.isObjectOrArray(value)) {
    return { omit: true, reason: "unsupported value" }
  }
  const isMap = value instanceof Map
  const isSet = !isMap && value instanceof Set
  if (!isMap && !isSet && !isPlainJsonContainer(value)) {
    return { omit: true, reason: "class instance" }
  }
  if (options.seen.has(value)) {
    return { omit: true, reason: "circular reference" }
  }
  if (options.depth >= maxJsonSafeDepth) {
    return { omit: true, reason: "maximum object depth exceeded" }
  }
  options.seen.add(value)
  try {
    if (isMap) {
      try {
        const output: Record<string, unknown> = {}
        let entries: IterableIterator<[unknown, unknown]>
        try {
          entries = value.entries()
        } catch {
          return { omit: true, reason: "map entries unavailable" }
        }
        for (const [key, item] of entries) {
          if (!Predicate.isString(key)) {
            return { omit: true, reason: "map contains non-string key" }
          }
          const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
          if (!converted.omit) output[key] = converted.value
        }
        return { omit: false, value: output }
      } catch {
        return { omit: true, reason: "map iteration failed" }
      }
    }
    if (isSet) {
      try {
        const output: unknown[] = []
        let values: IterableIterator<unknown>
        try {
          values = value.values()
        } catch {
          return { omit: true, reason: "set values unavailable" }
        }
        for (const item of values) {
          const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
          output.push(converted.omit ? null : converted.value)
        }
        return { omit: false, value: output }
      } catch {
        return { omit: true, reason: "set iteration failed" }
      }
    }
    if (Array.isArray(value)) {
      let length: number
      try {
        length = value.length
      } catch {
        return { omit: true, reason: "array length unavailable" }
      }
      const items: unknown[] = []
      for (let index = 0; index < length; index++) {
        let item: unknown
        try {
          item = value[index]
        } catch {
          items.push(null)
          continue
        }
        const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
        items.push(converted.omit ? null : converted.value)
      }
      return {
        omit: false,
        value: items,
      }
    }
    const output: Record<string, unknown> = {}
    const keys = safeObjectKeys(value)
    if (!keys) {
      return { omit: true, reason: "object keys unavailable" }
    }
    for (const key of keys) {
      let item: unknown
      try {
        item = value[key as keyof typeof value]
      } catch {
        continue
      }
      const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
      if (!converted.omit) {
        output[key] = converted.value
      }
    }
    return { omit: false, value: output }
  } finally {
    options.seen.delete(value)
  }
}

function isPlainJsonContainer<T extends object>(value: T): boolean {
  if (Array.isArray(value)) {
    return true
  }
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    return false
  }
  return prototype === Object.prototype || prototype === null
}

function safeObjectKeys<T extends object>(value: T): string[] | undefined {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
