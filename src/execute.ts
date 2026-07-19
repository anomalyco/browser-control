import { Effect, Schema, Scope } from "effect"
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type ElementHandle, type Frame, type Locator, type Page } from "playwright-core"
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
import { hideGhostCursor as hideGhostCursorOnPage, showGhostCursor as showGhostCursorOnPage, type GhostCursorClientOptions } from "./ghost-cursor.ts"
import type { HandoffOutcome } from "./handoff.ts"
import * as AuthProfile from "./auth-profile.ts"
import * as NetworkCapture from "./network-capture.ts"
import type { ExecuteAftermath, ExecuteLogEntry, ExecuteLogSummary, ExecuteMedia } from "./relay-schema.ts"
import { executionContextFailureDiagnostic } from "./runtime-diagnostics.ts"

const nodeModules = { fs, path, os, crypto, url, util, events, stream, buffer, http, https, zlib }
const nodeModuleAliases = Object.keys(nodeModules).join(", ")

const playwrightCloseTimeoutMs = 2_000
const playwrightConnectTimeoutMs = 15_000
const sessionPageHealthCheckTimeoutMs = 1_000
export const downloadCapabilityErrorMessage = "Downloads are unavailable in Browser Control extension-backed tabs: Chromium blocks Browser.setDownloadBehavior and Page.setDownloadBehavior through chrome.debugger, so Playwright cannot retain an artifact for download.saveAs(). Fetch the response in the page and write the returned bytes with fs when the site exposes them."
const downloadGuardedPages = new WeakSet<Page>()
const downloadGuardedContexts = new WeakSet<BrowserContext>()

export class PlaywrightOperationError extends Schema.TaggedErrorClass<PlaywrightOperationError>()(
  "Execute.PlaywrightOperationError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["failed", "timeout"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class SessionPageRecoveryError extends Schema.TaggedErrorClass<SessionPageRecoveryError>()(
  "Execute.SessionPageRecoveryError",
  {
    message: Schema.String,
    reason: Schema.Literals(["adopted-unresponsive", "close-failed"]),
    cause: Schema.Defect(),
  },
) {}

export class TargetSelectionError extends Schema.TaggedErrorClass<TargetSelectionError>()(
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

export const recoverSessionPage = Effect.fn("Execute.recoverSessionPage")(function* (options: {
  readonly ownsPage: boolean
  readonly url: string
  readonly timeoutMs: number
  readonly healthCheck: () => Promise<void>
  readonly close: () => Promise<void>
}) {
  let healthFailure: Error | undefined
  if (!options.url.startsWith("chrome-error://")) {
    healthFailure = yield* runPlaywrightOperation({
      label: "Session page health check",
      timeoutMs: options.timeoutMs,
      run: options.healthCheck,
    }).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => undefined,
      }),
    )
  } else {
    healthFailure = new Error(`Session page is showing ${options.url}`)
  }
  if (!healthFailure) {
    return "use" as const
  }
  if (!options.ownsPage) {
    return yield* Effect.fail(new SessionPageRecoveryError({
      message: "The adopted session page is unresponsive and was not replaced. Release it with `browser-control session reset` or adopt another attached tab.",
      reason: "adopted-unresponsive",
      cause: healthFailure,
    }))
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
    return yield* Effect.fail(new SessionPageRecoveryError({
      message: "The unhealthy relay-owned session page could not be closed. Run `browser-control session reset` before continuing.",
      reason: "close-failed",
      cause: closeFailure,
    }))
  }
  return "recreate" as const
})

type SandboxGlobals = {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly state: Record<string, unknown>
  readonly modules: typeof nodeModules
  readonly fillInput: (target: InputTarget, value: string) => Promise<void>
  readonly fillInputs: (page: Page, fields: ReadonlyArray<InputField>) => Promise<void>
  readonly screenshotWithLabels: (options: ScreenshotWithLabelsOptions) => Promise<ScreenshotWithLabelsResult>
  readonly ariaSnapshot: AriaSnapshotHelper
  readonly snapshot: SnapshotHelper
  readonly ref: SnapshotRefHelper
  readonly showGhostCursor: (options?: ShowGhostCursorOptions) => Promise<void>
  readonly hideGhostCursor: (options?: HideGhostCursorOptions) => Promise<void>
  readonly ghostCursor: {
    readonly show: (options?: ShowGhostCursorOptions) => Promise<void>
    readonly hide: (options?: HideGhostCursorOptions) => Promise<void>
  }
  readonly handoff: (message?: string, options?: HandoffCallOptions) => Promise<void>
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
}

export type HandoffPageTarget = {
  readonly targetId: string
}

export type RequestHandoff = (options: {
  readonly message: string
  readonly timeoutMs: number
  readonly target: HandoffPageTarget
}) => Promise<HandoffOutcome>

const defaultHandoffTimeoutMs = 10 * 60 * 1_000

const defaultHandoffMessage = "Complete the requested task, then use the in-page continue control."

export type AriaSnapshotTarget = Locator | string

export type AriaSnapshotOptions = {
  readonly timeout?: number
}

export type AriaSnapshotHelper = (target?: AriaSnapshotTarget, options?: AriaSnapshotOptions) => Promise<string>

export type SnapshotOptions = {
  readonly within?: AriaSnapshotTarget
  readonly interactive?: boolean
  readonly compact?: boolean
  readonly diff?: boolean
  readonly depth?: number
  readonly maxItems?: number
  readonly timeout?: number
}

export type SnapshotHelper = (options?: SnapshotOptions) => Promise<string>
export type SnapshotRefHelper = (id: string) => Locator

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
}

type SnapshotBaseline = {
  readonly page: Page
  readonly signature: string
  readonly entries: readonly SnapshotRenderedEntry[]
  readonly nextRef: number
}

type InputTarget = AriaSnapshotTarget

export const defaultAriaSnapshotTimeoutMs = 5_000
export const defaultSnapshotTimeoutMs = 10_000

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
  readonly page: Page
  readonly path?: string
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

export type AdoptTarget = {
  readonly targetId: string
  readonly url: string
}

export const defaultPageClosedWarning = "The session default page was closed; created a new page. References to the old page in state are stale."
export const defaultPageRecoveredWarning = "The session default page was unresponsive; created a new page. References to the old page in state are stale."
export const defaultPageCrashedWarning = "The session default page target crashed; checking it before the next execute."

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
  private readonly state: Record<string, unknown> = {}
  private readonly snapshotRefs: SnapshotRefRegistry = { selectors: new Map() }
  private readonly networkCapture = new NetworkCapture.Recorder()
  private pendingWarnings: string[] = []

  constructor(readonly options: ExecuteSandboxOptions) {}

  static scoped(options: ExecuteSandboxOptions): Effect.Effect<ExecuteSandbox, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new ExecuteSandbox(options)),
      (sandbox) => sandbox.close().pipe(Effect.ignore),
    )
  }

  execute(code: string, options: ExecuteOptions = {}): Effect.Effect<ExecuteResult> {
    return Effect.tryPromise({
      try: async () => {
        const globals = await this.getGlobals(options)
        const { result, logs, logSummary, aftermath } = await runUserCode({ code, globals })
        await this.networkCapture.settleForOutput()
        const extracted = extractExecuteMedia(result)
        const redactedValue = this.networkCapture.redactValue(extracted.value)
        const jsonSafeResult = toJsonSafeValue(redactedValue)
        const warnings = this.drainWarnings()
        const logCompactionWarning = formatLogCompactionWarning(logSummary)
        if (logCompactionWarning) {
          warnings.push(logCompactionWarning)
        }
        if (!jsonSafeResult.serializable) {
          warnings.push(`Execute result could not be represented as JSON value: ${jsonSafeResult.reason}`)
        }
        return {
          text: stringifyResult(redactedValue),
          ...(jsonSafeResult.serializable ? { value: jsonSafeResult.value } : {}),
          ...(extracted.media.length > 0 ? { media: extracted.media } : {}),
          isError: false,
          logs: this.redactCaptureLogs(logs),
          logSummary,
          warnings: warnings.map((warning) => this.networkCapture.redactText(warning)),
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
      Effect.ensuring(Effect.promise(() => this.networkCapture.settleForOutput())),
      Effect.match({
        onFailure: (error): ExecuteResult => {
          const logSummary = error instanceof ExecuteCodeError ? error.logSummary : emptyExecuteLogSummary()
          const aftermath = error instanceof ExecuteCodeError ? error.aftermath : undefined
          const diagnostic = executionContextFailureDiagnostic(error, aftermath)
          if (diagnostic?.startsWith("execution-context/") || diagnostic === "target/cross-extension-page") {
            this.pageHealthCheckRequired = true
          }
          const warnings = this.drainWarnings()
          const logCompactionWarning = formatLogCompactionWarning(logSummary)
          if (logCompactionWarning) {
            warnings.push(logCompactionWarning)
          }
          return {
            text: this.networkCapture.redactText(error instanceof ExecuteCodeError ? error.stack ?? error.message : error.message),
            isError: true,
            logs: this.redactCaptureLogs(error instanceof ExecuteCodeError ? error.logs : []),
            logSummary,
            warnings: warnings.map((warning) => this.networkCapture.redactText(warning)),
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

  private drainWarnings(): string[] {
    const warnings = this.pendingWarnings
    this.pendingWarnings = []
    return warnings
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

  close(): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const page = sandbox.page
      const browser = sandbox.browser
      const ownsOpenPage = page !== undefined && sandbox.ownsPage && !page.isClosed()
      sandbox.browser = undefined
      sandbox.page = undefined
      sandbox.defaultPageTargetId = undefined
      sandbox.ownsPage = false
      sandbox.pageHealthCheckRequired = false
      yield* sandbox.networkCapture.cancel()

      if (ownsOpenPage) {
        yield* runPlaywrightOperation({
          label: "Close sandbox page",
          timeoutMs: playwrightCloseTimeoutMs,
          run: () => page.close(),
        }).pipe(Effect.ignore)
      }
      if (browser) {
        yield* runPlaywrightOperation({
          label: "Close sandbox browser connection",
          timeoutMs: playwrightCloseTimeoutMs,
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
      sandbox.page = undefined
      sandbox.defaultPageTargetId = undefined
      sandbox.ownsPage = false
      sandbox.pageHealthCheckRequired = false
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

  adoptPage(target: AdoptTarget): Effect.Effect<string, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      if (!sandbox.browser?.isConnected()) {
        const staleBrowser = sandbox.browser
        if (staleBrowser) {
          yield* runSettledPlaywrightOperation({
            label: "Close stale browser connection before adoption",
            run: () => staleBrowser.close(),
          }).pipe(Effect.ignore)
        }
        const browser = yield* runSettledPlaywrightOperation({
          label: "Connect to the relay for session adoption",
          run: () => chromium.connectOverCDP(sandbox.options.endpointUrl, {
            timeout: playwrightConnectTimeoutMs,
            ...(sandbox.options.sessionId ? { headers: { "Browser-Control-Session-Id": sandbox.options.sessionId } } : {}),
          }),
        })
        sandbox.browser = browser
        sandbox.page = undefined
        sandbox.defaultPageTargetId = undefined
        sandbox.ownsPage = false
        sandbox.pageHealthCheckRequired = false
        sandbox.networkCapture.bindPage(undefined)
      }
      const browser = sandbox.browser
      if (!browser) {
        return yield* Effect.fail(new Error("Browser connection unavailable for session adoption"))
      }
      const existingContext = browser.contexts()[0]
      const context = existingContext ?? (yield* runSettledPlaywrightOperation({
        label: "Create a browser context for session adoption",
        run: () => browser.newContext(),
      }))
      const selected = yield* Effect.try({
        try: () => selectPageForAdopt({ pages: context.pages(), target }),
        catch: (cause) => cause instanceof Error ? cause : new Error("Select page for session adoption", { cause }),
      })
      if (!selected) {
        return yield* Effect.fail(new Error(`No attached page found for target ${target.targetId} (${target.url})`))
      }
      const currentPage = sandbox.page
      if (shouldCloseCurrentPageOnAdopt({
        hasCurrentPage: currentPage !== undefined,
        ownsCurrentPage: sandbox.ownsPage,
        currentPageIsSelected: currentPage === selected,
        currentPageIsClosed: currentPage?.isClosed() ?? true,
      }) && currentPage) {
        yield* runSettledPlaywrightOperation({
          label: "Close the previous session page during adoption",
          run: () => currentPage.close(),
        }).pipe(Effect.ignore)
      }
      sandbox.page = selected
      sandbox.defaultPageTargetId = target.targetId
      sandbox.ownsPage = false
      sandbox.pageHealthCheckRequired = false
      sandbox.networkCapture.bindPage(selected)
      return selected.url()
    })
  }

  private async getGlobals(options: ExecuteOptions): Promise<SandboxGlobals> {
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
      this.browser = await chromium.connectOverCDP(this.options.endpointUrl, {
        timeout: playwrightConnectTimeoutMs,
        ...(this.options.sessionId ? { headers: { "Browser-Control-Session-Id": this.options.sessionId } } : {}),
      })
      this.page = undefined
      this.defaultPageTargetId = undefined
      this.ownsPage = false
      this.pageHealthCheckRequired = false
      this.networkCapture.bindPage(undefined)
      if (hadBrowser) {
        this.pendingWarnings.push("Relay connection was lost and re-established; the session default page was re-resolved.")
      }
    }
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext())
    installDownloadCapabilityGuards(context)
    const targetSelection = options.targetSelection
    const page = await this.getSessionPage({ context, ...(targetSelection ? { targetSelection } : {}) })
    this.networkCapture.bindPage(this.page)
    const showGhostCursor = async (options?: ShowGhostCursorOptions) => {
      const cursorOptions = ghostCursorOptions(options)
      await showGhostCursorOnPage({ page: options?.page ?? page, ...(cursorOptions ? { cursorOptions } : {}) })
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
      const targetId = await pageTargetId(handoffPage)
      const outcome = await requestHandoff({
        message: handoffMessage,
        timeoutMs,
        target: { targetId },
      })
      if (outcome === "timeout") {
        throw new Error(`Handoff timed out after ${timeoutMs}ms waiting for the user: ${handoffMessage}`)
      }
      if (outcome !== "resolved") {
        const targetEvent = outcome.reason === "target-crashed" ? "crashed" : "detached"
        throw new Error(`Handoff cancelled because its target ${targetEvent}: ${handoffMessage}`)
      }
      handoffTracker.count += 1
    }
    return {
      browser: this.browser,
      context,
      page,
      state: this.state,
      modules: nodeModules,
      fillInput: (target, value) => fillInput({ page, target, value }),
      fillInputs,
      screenshotWithLabels,
      ariaSnapshot,
      snapshot,
      ref,
      showGhostCursor,
      hideGhostCursor,
      ghostCursor: {
        show: showGhostCursor,
        hide: hideGhostCursor,
      },
      handoff,
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
    if (!this.pendingWarnings.includes(defaultPageCrashedWarning)) {
      this.pendingWarnings.push(defaultPageCrashedWarning)
    }
    return true
  }

  markTargetDetached(targetId: string): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    this.page = undefined
    this.defaultPageTargetId = undefined
    this.ownsPage = false
    this.pageHealthCheckRequired = false
    this.networkCapture.bindPage(undefined)
    if (!this.pendingWarnings.includes(defaultPageClosedWarning)) {
      this.pendingWarnings.push(defaultPageClosedWarning)
    }
    return true
  }

  getStatus(): { readonly sessionId?: string; readonly connected: boolean; readonly pageUrl: string | null; readonly stateKeys: string[] } {
    return {
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      connected: Boolean(this.browser?.isConnected()),
      pageUrl: this.page && !this.page.isClosed() ? this.page.url() : null,
      stateKeys: Object.keys(this.state),
    }
  }

  networkStart(options: NetworkCapture.NetworkCaptureOptions = {}): Effect.Effect<NetworkCapture.NetworkCaptureStatus, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const globals = yield* Effect.tryPromise({
        try: () => sandbox.getGlobals({}),
        catch: (cause) => cause instanceof Error ? cause : new Error("Set up page for network capture", { cause }),
      })
      return yield* sandbox.networkCapture.start(globals.page, options)
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
      const globals = yield* Effect.tryPromise({
        try: () => sandbox.getGlobals({}),
        catch: (cause) => cause instanceof Error ? cause : new Error("Set up page for auth refresh", { cause }),
      })
      yield* AuthProfile.read(options.name).pipe(Effect.asVoid)
      yield* sandbox.networkCapture.start(globals.page, {
        ...(options.urlFilter ? { urlFilter: options.urlFilter } : {}),
      })
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => globals.page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 }),
          catch: (cause) => cause instanceof Error ? cause : new Error("Refresh auth profile", { cause }),
        })
        yield* Effect.tryPromise({
          try: () => globals.page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs ?? 30_000, 5_000) }).catch(() => {}),
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
    if (this.page && !this.page.isClosed()) {
      if (this.pageHealthCheckRequired || this.page.url().startsWith("chrome-error://")) {
        const page = this.page
        const recovery = await Effect.runPromise(recoverSessionPage({
          ownsPage: this.ownsPage,
          url: page.url(),
          timeoutMs: sessionPageHealthCheckTimeoutMs,
          healthCheck: async () => {
            await page.evaluate(() => true)
          },
          close: () => page.close(),
        }))
        if (recovery === "use") {
          this.pageHealthCheckRequired = false
          return page
        }
        this.page = undefined
        this.defaultPageTargetId = undefined
        this.ownsPage = false
        this.pageHealthCheckRequired = false
        this.pendingWarnings.push(defaultPageRecoveredWarning)
      } else {
        return this.page
      }
    }
    if (this.page?.isClosed()) {
      this.defaultPageTargetId = undefined
      this.pendingWarnings.push(defaultPageClosedWarning)
    }
    this.page = await context.newPage()
    this.defaultPageTargetId = await resolvePageTargetId(this.page)
    this.ownsPage = true
    return this.page
  }
}

export function installDownloadCapabilityGuard(page: Page): void {
  if (downloadGuardedPages.has(page)) {
    return
  }
  const waitForEvent = page.waitForEvent.bind(page)
  Object.defineProperty(page, "waitForEvent", {
    configurable: true,
    value: (event: string, ...args: unknown[]) => {
      if (event === "download") {
        return Promise.reject(new Error(downloadCapabilityErrorMessage))
      }
      return Reflect.apply(waitForEvent, page, [event, ...args])
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
}: {
  readonly targets: readonly T[]
  readonly selection: ExecuteTargetSelection
  readonly getUrl: (target: T) => string
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
      throw new TargetSelectionError({
        reason: "ambiguous",
        message: `Multiple attached pages (${matches.length}) match URL ${selection.urlIncludes}; use a more specific --target-url or --target-index`,
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
  if (targets.length > 1) {
    throw new TargetSelectionError({
      reason: "ambiguous",
      message: `Multiple attached pages (${targets.length}); use --target-url or --target-index to choose one`,
    })
  }
  return targets[0]
}

function selectPage({ pages, selection }: { readonly pages: readonly Page[]; readonly selection: ExecuteTargetSelection }): Page | undefined {
  return selectTarget({ targets: pages, selection, getUrl: (page) => page.url() })
}

export function selectTargetById<T>({
  targets,
  targetId,
  getTargetId,
}: {
  readonly targets: readonly T[]
  readonly targetId: string
  readonly getTargetId: (target: T) => string | undefined
}): T | undefined {
  return targets.find((target) => getTargetId(target) === targetId)
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

export function selectAdoptCandidateByUrl<T>({
  candidates,
  targetUrl,
  getUrl,
}: {
  readonly candidates: readonly T[]
  readonly targetUrl: string
  readonly getUrl: (candidate: T) => string
}): T | undefined {
  const matches = candidates.filter((candidate) => getUrl(candidate) === targetUrl)
  if (matches.length > 1) {
    throw new Error(`Multiple Playwright pages have URL ${targetUrl}; cannot safely map the validated target to a page without a relay target-id hook`)
  }
  return matches[0]
}

function selectPageForAdopt({ pages, target }: { readonly pages: readonly Page[]; readonly target: AdoptTarget }): Page | undefined {
  return selectAdoptCandidateByUrl({
    candidates: pages.filter((page) => !page.isClosed()),
    targetUrl: target.url,
    getUrl: (page) => page.url(),
  })
}

function ghostCursorOptions(options: ShowGhostCursorOptions | undefined): GhostCursorClientOptions | undefined {
  if (!options) {
    return undefined
  }
  return {
    ...(options.color ? { color: options.color } : {}),
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(options.zIndex !== undefined ? { zIndex: options.zIndex } : {}),
  }
}

export function createAriaSnapshotHelper(page: Pick<Page, "locator">): AriaSnapshotHelper {
  return async (target, options) => {
    const locator = target === undefined ? page.locator("body") : typeof target === "string" ? page.locator(target) : target
    return await locator.ariaSnapshot({ timeout: options?.timeout ?? defaultAriaSnapshotTimeoutMs })
  }
}

export function createSnapshotHelpers(page: Page, registry: SnapshotRefRegistry): {
  readonly snapshot: SnapshotHelper
  readonly ref: SnapshotRefHelper
} {
  const refRoots = new WeakMap<Locator, { readonly selector: string; readonly role: string; readonly name?: string }>()
  const snapshot: SnapshotHelper = async (options = {}) => {
    const within = options.within
    const refRoot = typeof within === "object" ? refRoots.get(within) : undefined
    const locator = typeof within === "object" && !refRoot ? within : undefined
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
    const depth = Math.max(1, Math.min(12, Math.floor(options.depth ?? 6)))
    const maxItems = Math.max(1, Math.min(200, Math.floor(options.maxItems ?? 80)))
    const settings = {
      compact: options.compact ?? true,
      depth,
      interactive: options.interactive ?? false,
      maxCandidates: Math.max(1_000, maxItems * 20),
      maxItems,
      rootSelector: typeof within === "string" ? within : refRoot?.selector,
      rootRole: refRoot?.role,
      rootName: refRoot?.name,
    }
    const signature = JSON.stringify({
      compact: settings.compact,
      depth: settings.depth,
      interactive: settings.interactive,
      maxItems: settings.maxItems,
      scope: typeof within === "string"
        ? { kind: "selector", selector: within }
        : refRoot
        ? { kind: "ref", selector: refRoot.selector, role: refRoot.role, name: refRoot.name }
        : locator
        ? { kind: "locator", scope: locatorScope }
        : { kind: "page" },
    })
    const previousSnapshot = registry.previousSnapshot
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
      registry.selectors.clear()
      delete registry.page
      delete registry.url
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
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width >= 1 && rect.height >= 1 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      }
      const labelledName = (element: Element): string => {
        const ariaLabel = element.getAttribute("aria-label")
        if (ariaLabel) return normalize(ariaLabel)
        const labelledBy = element.getAttribute("aria-labelledby")
        if (labelledBy) {
          const labelled = normalize(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "))
          if (labelled) return labelled
        }
        return normalize(element.getAttribute("title") ?? "")
      }
      const safeText = (element: Element): string => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const parts: string[] = []
        let node = walker.nextNode()
        while (node) {
          const parent = node.parentElement
          let hidden = false
          let ancestor = parent
          while (ancestor && element.contains(ancestor)) {
            const style = window.getComputedStyle(ancestor)
            if (ancestor.hasAttribute("hidden") || ancestor.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              hidden = true
              break
            }
            if (ancestor === element) break
            ancestor = ancestor.parentElement
          }
          if (!hidden && !parent?.closest("input, textarea, select, script, style")) {
            parts.push(node.textContent ?? "")
          }
          node = walker.nextNode()
        }
        return normalize(parts.join(" "))
      }
      const accessibleName = (element: Element): string => {
        const labelled = labelledName(element)
        if (labelled) return labelled
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const label = element.labels?.[0]
          if (label) return safeText(label)
          const placeholder = element.getAttribute("placeholder")
          if (placeholder) return normalize(placeholder)
          return ""
        }
        const alt = element.getAttribute("alt")
        return normalize(alt || safeText(element))
      }
      const roleFor = (element: Element): string => {
        const explicit = element.getAttribute("role")
        if (explicit) return explicit
        if (/^H[1-6]$/.test(element.tagName)) return "heading"
        if (element instanceof HTMLAnchorElement) return "link"
        if (element instanceof HTMLButtonElement || element.tagName === "SUMMARY") return "button"
        if (element instanceof HTMLTextAreaElement) return "textbox"
        if (element instanceof HTMLSelectElement) return "combobox"
        if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox") return "checkbox"
          if (element.type === "radio") return "radio"
          if (element.type === "button" || element.type === "submit" || element.type === "reset") return "button"
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
        if (role === "dialog" || role === "group") {
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
            const mains = Array.from(document.querySelectorAll("main")).filter(isVisible)
            return mains.length === 1 ? mains[0] as Element : document.body
          })()
      if ((settings.rootRole && roleFor(root) !== settings.rootRole) || (settings.rootName && accessibleName(root) !== settings.rootName)) {
        throw new Error("Snapshot ref no longer identifies the captured element; call snapshot() again")
      }
      const detailsFor = (element: Element): string | undefined => {
        const details: string[] = []
        if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox" || element.type === "radio") details.push(element.checked ? "checked" : "unchecked")
        }
        if (element instanceof HTMLSelectElement) {
          const selected = element.selectedOptions[0]?.textContent
          if (selected) details.push(`selected="${quote(normalize(selected).slice(0, 80))}"`)
          details.push(`${element.options.length} options`)
        }
        if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
          if (element.disabled) details.push("disabled")
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
      const cssPath = (element: Element): string => {
        const id = element.getAttribute("id")
        if (id) {
          const candidate = `#${CSS.escape(id)}`
          if (document.querySelectorAll(candidate).length === 1) return candidate
        }
        for (const attribute of ["data-testid", "data-test", "name", "aria-label", "placeholder"]) {
          const value = element.getAttribute(attribute)
          if (value) {
            const candidate = `[${attribute}="${quote(value)}"]`
            if (document.querySelectorAll(candidate).length === 1) return candidate
          }
        }
        const tag = element.tagName.toLowerCase()
        const role = element.getAttribute("role")
        const roleSuffix = role ? `[role="${quote(role)}"]` : ""
        for (const className of element.classList) {
          const candidate = `${tag}.${CSS.escape(className)}${roleSuffix}`
          if (document.querySelectorAll(candidate).length === 1) return candidate
        }
        const parent = element.parentElement
        if (!parent) return tag
        const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName)
        return `${cssPath(parent)} > ${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
      }
      const headingDepth = (element: Element): number => {
        const ownLevel = /^H([1-6])$/.exec(element.tagName)?.[1]
        if (ownLevel) return Number(ownLevel) - 1
        const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"))
        let level = 0
        for (const heading of headings) {
          if (heading === element || (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
          const candidate = /^H([1-6])$/.exec(heading.tagName)?.[1]
          level = candidate ? Number(candidate) : Number(heading.getAttribute("aria-level") ?? 1)
        }
        return level
      }

      const structuralSelector = "fieldset, [role='group'], dialog, [role='dialog'], [role='tablist'], details, table, [role='table'], tr, [role='row'], ul, ol, [role='list'], li, [role='listitem'], pre"
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
        let parent = element.parentElement
        while (parent && parent !== root) {
          if (parent.matches(structuralSelector)) keys.push(structuralKey(parent))
          parent = parent.parentElement
        }
        return keys
      }
      const primaryLinks = new WeakMap<Element, Element | null>()
      const isPrimaryLink = (element: Element): boolean => {
        const group = element.closest("article, li, tr, [role='listitem'], [role='row']")
        if (!group || !root.contains(group)) return false
        if (!primaryLinks.has(group)) {
          const links = Array.from(group.querySelectorAll("a[href]")).filter(isVisible)
          let primary: Element | null = null
          let primaryScore = -1
          for (const link of links) {
            const name = accessibleName(link)
            const score = name.length + (link.closest("h1, h2, h3, h4, h5, h6, [role='heading']") ? 1_000 : 0)
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
          return groupTextLength > 0 && accessibleName(element).length / groupTextLength >= 0.32
        }
        return true
      }
      const priorityFor = (options: { readonly role: string; readonly interactive: boolean; readonly primaryLink: boolean; readonly structuralEssential: boolean }): number => {
        if (options.role === "alert" || options.role === "status" || options.role === "navigation" || options.structuralEssential) return -1
        if (options.role === "heading") return 0
        if (options.role === "link" && options.primaryLink) return 0
        if (options.interactive && (options.role !== "link" || options.primaryLink)) return 1
        if (options.role === "link") return 3
        return 2
      }

      const entries: BrowserEntry[] = []
      let truncated = false
      const add = (entry: BrowserEntry): void => {
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
        "a[href]", "button", "input", "textarea", "select", "summary",
        "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[contenteditable]",
      ].join(",")
      const candidates = [
        ...(root.matches(candidateSelector) ? [root] : []),
        ...Array.from(root.querySelectorAll(candidateSelector)),
      ]
      const collapsedNavigation = new Set<Element>()

      for (const element of candidates) {
        if (entries.length >= settings.maxCandidates) {
          truncated = true
          break
        }
        if (!isVisible(element)) continue
        const navigation = element.closest("nav, [role='navigation']")
        if (settings.compact && navigation && navigation !== root) {
          if (!collapsedNavigation.has(navigation)) {
            collapsedNavigation.add(navigation)
            const count = navigation.querySelectorAll("a[href], button").length
            add({ depth: headingDepth(navigation), role: "navigation", name: truncate(labelledName(navigation), 100) || "Navigation", details: `${count} controls`, priority: 0 })
          }
          continue
        }
        const role = roleFor(element)
        const isHeading = role === "heading"
        const isInteractive = element.matches("a[href], button, input, textarea, select, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [contenteditable]")
        const isSafetyText = role === "alert" || role === "status"
        const isParagraph = element.matches("p")
        const isStructural = element.matches(structuralSelector)
        if (!isHeading && !isInteractive && !isSafetyText && !isStructural && (settings.interactive || !isParagraph)) continue
        if (settings.interactive && isParagraph && !isSafetyText) continue
        const identityName = isStructural ? structuralName(element, role) : accessibleName(element)
        const fallbackName = role === "group" ? "Group"
          : role === "dialog" ? "Dialog"
          : role === "table" ? "Table"
          : role === "list" ? "List"
          : role === "tablist" ? "Tab list"
          : isInteractive ? element.getAttribute("name") || role
          : ""
        const name = truncate(identityName || fallbackName, isParagraph || isSafetyText || isStructural ? 180 : 120)
        if (!name) continue
        const details = isHeading ? `level=${headingDepth(element) + 1}` : detailsFor(element)
        const primaryLink = role === "link" && isPrimaryLink(element)
        const baseDepth = headingDepth(element)
        const parentKeys = structuralParentKeys(element)
        add({
          depth: baseDepth + parentKeys.length,
          baseDepth,
          ...(isStructural ? { key: structuralKey(element) } : {}),
          ...(parentKeys.length > 0 ? { parentKeys } : {}),
          role,
          name,
          ...(isInteractive ? { identityName } : {}),
          ...(isInteractive ? { selector: cssPath(element) } : {}),
          ...(details ? { details } : {}),
          priority: priorityFor({
            role,
            interactive: isInteractive,
            primaryLink,
            structuralEssential: isStructural && role !== "row" && role !== "listitem",
          }),
        })
      }
      const selected = entries
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => left.entry.priority - right.entry.priority || left.index - right.index)
        .slice(0, settings.maxItems)
        .sort((left, right) => left.index - right.index)
        .map(({ entry }) => entry)
      return { entries: selected, truncated: truncated || selected.length < entries.length }
    }
    const timeoutMs = options.timeout ?? defaultSnapshotTimeoutMs
    let result: Awaited<ReturnType<typeof capture>>
    if (locator) {
      result = await locator.evaluate(capture, settings, { timeout: timeoutMs })
    } else {
      try {
        result = await Effect.runPromise(runPlaywrightOperation({
          label: "Compact snapshot",
          timeoutMs,
          run: () => page.evaluate(capture, settings),
        }))
      } catch (error) {
        if (typeof within !== "string" || !/not a valid selector|querySelectorAll/i.test(error instanceof Error ? error.message : String(error))) {
          throw error
        }
        result = await page.locator(within).evaluate(capture, { ...settings, rootSelector: undefined }, { timeout: timeoutMs })
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
    let nextRef = 1
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
    const entries: SnapshotRenderedEntry[] = result.entries.map((entry) => {
      const name = entry.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      return {
        prefix: `${"  ".repeat(Math.max(0, resolvedDepth(entry) - depthOffset))}- ${entry.role} "${name}"`,
        ...(entry.details ? { details: entry.details } : {}),
        ...(entry.selector ? { selector: entry.selector, role: entry.role } : {}),
        ...(entry.identityName ? { identityName: entry.identityName } : {}),
      }
    })
    if (result.truncated) entries.push({ prefix: `- ... truncated after ${maxItems} items` })

    const registerRef = (entry: SnapshotRenderedEntry, id: string): void => {
      if (!entry.selector || !entry.role) return
      registry.selectors.set(id, {
        selector: entry.selector,
        role: entry.role,
        ...(entry.identityName ? { name: entry.identityName } : {}),
      })
    }

    if (!options.diff) {
      const lines = entries.map((entry) => {
        const id = entry.selector ? `e${nextRef++}` : undefined
        if (id) registerRef(entry, id)
        return formatSnapshotLine(entry, id)
      })
      registry.previousSnapshot = { page, signature, entries, nextRef }
      return lines.join("\n")
    }

    nextRef = previousSnapshot?.nextRef ?? 1
    const operations = diffSnapshotEntries(previousSnapshot?.entries ?? [], entries)
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
      const id = operation.entry.selector ? `e${nextRef++}` : undefined
      if (id) registerRef(operation.entry, id)
      lines.push(formatSnapshotDiffLine("+", operation.entry, id))
    }
    lines.push(`${additions} ${additions === 1 ? "addition" : "additions"}, ${removals} ${removals === 1 ? "removal" : "removals"}, ${unchanged} unchanged`)
    registry.previousSnapshot = { page, signature, entries, nextRef }
    return lines.join("\n")
  }

  const ref: SnapshotRefHelper = (id) => {
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
    case "menuitem":
    case "radio":
    case "tab":
    case "textbox":
      return role
    default:
      return undefined
  }
}

async function fillInput(options: { readonly page: Page; readonly target: InputTarget; readonly value: string }): Promise<void> {
  if (typeof options.target === "string") {
    await fillInputs(options.page, [{ selector: options.target, value: options.value }])
    return
  }
  const locator = options.target
  await locator.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
      throw new Error("fillInput expects an input or textarea locator")
    }
    const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    element.focus()
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, nextValue)
    } else {
      element.value = nextValue
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    element.blur()
  }, options.value, { timeout: 30_000 })
}

export async function fillInputs(page: Page, fields: ReadonlyArray<InputField>): Promise<void> {
  const locatorHandles: ElementHandle[] = []
  try {
    const resolvedFields: Array<{ readonly target: string | ElementHandle; readonly label: string; readonly value: string }> = []
    for (const field of fields) {
      if (typeof field.selector === "string") {
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
          const matches = document.querySelectorAll(field.target)
          if (matches.length !== 1) {
            throw new Error(`fillInputs expects exactly one match for ${field.label}; got ${matches.length}`)
          }
          element = matches[0]
        } else {
          element = field.target
        }
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
          throw new Error(`fillInputs expects input or textarea ${field.label}`)
        }
        const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
        const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
        element.focus()
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
          prototypeValueSetter.call(element, field.value)
        } else {
          element.value = field.value
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: field.value }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
        element.blur()
        return field.label
      })
    }, resolvedFields)
  } finally {
    await Promise.all(locatorHandles.map((handle) => handle.dispose().catch(() => {})))
  }
}

async function screenshotWithLabels(options: ScreenshotWithLabelsOptions): Promise<ScreenshotWithLabelsResult> {
  if (options.path !== undefined && !path.isAbsolute(options.path)) {
    throw new Error("screenshotWithLabels requires an absolute path")
  }

  const labels = await showScreenshotLabels(options.page)
  try {
    const screenshot = await options.page.screenshot(options.path ? { path: options.path } : {})
    return {
      ...(options.path ? { path: options.path } : { image: screenshot }),
      size: screenshot.byteLength,
      labelCount: labels.length,
      labels,
    }
  } finally {
    await hideScreenshotLabels(options.page)
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
      .filter((element, index, elements) => {
        return elements.indexOf(element) === index
      })
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

    const escapeCss = (value: string): string => {
      return CSS.escape(value)
    }

    const quoteAttribute = (value: string): string => {
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    }

    const selectorForElement = (element: Element): string => {
      const id = element.getAttribute("id")
      if (id) {
        return `#${escapeCss(id)}`
      }
      const testId = element.getAttribute("data-testid")
      if (testId) {
        return `[data-testid="${quoteAttribute(testId)}"]`
      }
      const dataTest = element.getAttribute("data-test")
      if (dataTest) {
        return `[data-test="${quoteAttribute(dataTest)}"]`
      }
      const name = element.getAttribute("name")
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${quoteAttribute(name)}"]`
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
export const maxCapturedPageLogs = 50
export const maxCapturedScriptLogs = 100

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
    const fn = new AsyncFunction(
      "console",
      "browser",
      "context",
      "page",
      "state",
      "modules",
      "fillInput",
      "fillInputs",
      "screenshotWithLabels",
      "ariaSnapshot",
      "snapshot",
      "ref",
      "showGhostCursor",
      "hideGhostCursor",
      "ghostCursor",
      "handoff",
      "network",
      wrapCodeWithModuleAliases(code),
    )
    const result = await fn(
      sandboxConsole,
      globals.browser,
      globals.context,
      globals.page,
      globals.state,
      globals.modules,
      globals.fillInput,
      globals.fillInputs,
      globals.screenshotWithLabels,
      globals.ariaSnapshot,
      globals.snapshot,
      globals.ref,
      globals.showGhostCursor,
      globals.hideGhostCursor,
      globals.ghostCursor,
      globals.handoff,
      globals.network,
    )
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
  if (typeof value === "string") {
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
    if (!statement || statement.type === "ReturnStatement" || statement.type !== "ExpressionStatement") {
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

export function wrapCodeWithModuleAliases(code: string): string {
  return `const { ${nodeModuleAliases} } = modules;\n{\n${wrapCode(code)}\n}`
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") {
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
    if (item === null || typeof item !== "object") return item
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
    const converted = convertJsonSafe(value, { seen, depth: 0, topLevel: true })
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

function convertJsonSafe(value: unknown, options: { readonly seen: WeakSet<object>; readonly depth: number; readonly topLevel: boolean }): JsonSafeConversion {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { omit: false, value }
  }
  if (typeof value === "number") {
    return { omit: false, value: Number.isFinite(value) ? value : null }
  }
  if (typeof value === "bigint") {
    return { omit: false, value: value.toString() }
  }
  if (value === undefined) {
    return options.topLevel ? { omit: true, reason: "undefined" } : { omit: true, reason: "undefined property" }
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return { omit: true, reason: `${typeof value} value` }
  }
  if (typeof value !== "object") {
    return { omit: true, reason: `unsupported ${typeof value} value` }
  }
  if (value instanceof Map) {
    return convertMapJsonSafe(value, options)
  }
  if (value instanceof Set) {
    return convertSetJsonSafe(value, options)
  }
  if (!isPlainJsonContainer(value)) {
    return { omit: true, reason: options.topLevel ? "class instance" : "class instance property" }
  }
  if (options.seen.has(value)) {
    return options.topLevel ? { omit: true, reason: "circular reference" } : { omit: true, reason: "circular property" }
  }
  if (options.depth >= maxJsonSafeDepth) {
    return options.topLevel ? { omit: true, reason: "maximum object depth exceeded" } : { omit: true, reason: "nested value exceeded maximum depth" }
  }
  options.seen.add(value)
  try {
    if (Array.isArray(value)) {
      let length: number
      try {
        length = value.length
      } catch {
        return { omit: true, reason: options.topLevel ? "array length unavailable" : "array property unavailable" }
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
        const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1, topLevel: false })
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
      return { omit: true, reason: options.topLevel ? "object keys unavailable" : "object property keys unavailable" }
    }
    for (const key of keys) {
      let item: unknown
      try {
        item = value[key as keyof typeof value]
      } catch {
        continue
      }
      const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1, topLevel: false })
      if (!converted.omit) {
        output[key] = converted.value
      }
    }
    return { omit: false, value: output }
  } finally {
    options.seen.delete(value)
  }
}

function convertMapJsonSafe(value: Map<unknown, unknown>, options: { readonly seen: WeakSet<object>; readonly depth: number; readonly topLevel: boolean }): JsonSafeConversion {
  if (options.seen.has(value)) {
    return options.topLevel ? { omit: true, reason: "circular reference" } : { omit: true, reason: "circular property" }
  }
  if (options.depth >= maxJsonSafeDepth) {
    return options.topLevel ? { omit: true, reason: "maximum object depth exceeded" } : { omit: true, reason: "nested value exceeded maximum depth" }
  }
  options.seen.add(value)
  try {
    const output: Record<string, unknown> = {}
    let entries: IterableIterator<[unknown, unknown]>
    try {
      entries = value.entries()
    } catch {
      return { omit: true, reason: options.topLevel ? "map entries unavailable" : "map property entries unavailable" }
    }
    for (const [key, item] of entries) {
      if (typeof key !== "string") {
        return { omit: true, reason: options.topLevel ? "map contains non-string key" : "map property contains non-string key" }
      }
      const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1, topLevel: false })
      if (!converted.omit) {
        output[key] = converted.value
      }
    }
    return { omit: false, value: output }
  } catch {
    return { omit: true, reason: options.topLevel ? "map iteration failed" : "map property iteration failed" }
  } finally {
    options.seen.delete(value)
  }
}

function convertSetJsonSafe(value: Set<unknown>, options: { readonly seen: WeakSet<object>; readonly depth: number; readonly topLevel: boolean }): JsonSafeConversion {
  if (options.seen.has(value)) {
    return options.topLevel ? { omit: true, reason: "circular reference" } : { omit: true, reason: "circular property" }
  }
  if (options.depth >= maxJsonSafeDepth) {
    return options.topLevel ? { omit: true, reason: "maximum object depth exceeded" } : { omit: true, reason: "nested value exceeded maximum depth" }
  }
  options.seen.add(value)
  try {
    const output: unknown[] = []
    let values: IterableIterator<unknown>
    try {
      values = value.values()
    } catch {
      return { omit: true, reason: options.topLevel ? "set values unavailable" : "set property values unavailable" }
    }
    for (const item of values) {
      const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1, topLevel: false })
      output.push(converted.omit ? null : converted.value)
    }
    return { omit: false, value: output }
  } catch {
    return { omit: true, reason: options.topLevel ? "set iteration failed" : "set property iteration failed" }
  } finally {
    options.seen.delete(value)
  }
}

function isPlainJsonContainer(value: object): boolean {
  if (Array.isArray(value)) {
    return true
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    return false
  }
  return prototype === Object.prototype || prototype === null
}

function safeObjectKeys(value: object): string[] | undefined {
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
