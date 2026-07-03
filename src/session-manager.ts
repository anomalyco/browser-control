import { Effect, Option, Semaphore } from "effect"
import { defaultPageClosedWarning, ExecuteSandbox, hasExplicitTargetSelection, type ExecuteResult, type ExecuteTargetSelection } from "./execute.ts"
import { generateSessionId } from "./relay-helpers.ts"
import type { BrowserControlSession, ExecuteSandboxLike, SessionSummary } from "./relay-types.ts"

export type SessionExecuteRecord = {
  readonly sessionId: string
  readonly code: string
  readonly durationMs: number
  readonly result: ExecuteResult
}

export type SessionHooks = {
  /** Called when a session starts (true) or finishes (false) an execute. */
  readonly onExecuteStateChange?: (sessionId: string, executing: boolean) => void
  /** Called after each execute completes, for journaling. Must not throw. */
  readonly onExecuteRecord?: (record: SessionExecuteRecord) => void
  /** How long delete waits for an in-flight execute before force-closing. */
  readonly deletePermitTimeoutMs?: number
  /** Current user-owned attached page URLs, used for relay-side adoption hints. */
  readonly getUserAttachedPageUrls?: () => readonly string[]
}

export const adoptionTipForUrl = (url: string): string => {
  const selector = targetUrlHintSelector(url)
  return `Tip: an attached tab is open (${url}). Use browser-control session adopt --target-url '${selector}' to drive it instead of this new tab.`
}

export const shouldAppendAdoptionTip = (options: {
  readonly explicitTargetSelection: boolean
  readonly sessionCreated: boolean
  readonly warnings: readonly string[]
  readonly userAttachedPageUrls: readonly string[]
}): boolean => {
  if (options.explicitTargetSelection || options.userAttachedPageUrls.length === 0) {
    return false
  }
  return options.sessionCreated || options.warnings.includes(defaultPageClosedWarning)
}

export class BrowserControlSessions {
  readonly sessions = new Map<string, BrowserControlSession>()
  private readonly createSandbox: (id: string) => ExecuteSandboxLike
  private readonly hooks: SessionHooks
  private readonly executing = new Set<string>()
  private userAttachedPageUrlsProvider: (() => readonly string[]) | undefined

  constructor(
    private readonly endpointUrl: string,
    createSandbox?: (id: string) => ExecuteSandboxLike,
    hooks?: SessionHooks,
  ) {
    this.createSandbox = createSandbox ?? ((id) => new ExecuteSandbox({ endpointUrl: this.endpointUrl, sessionId: id }))
    this.hooks = hooks ?? {}
    this.userAttachedPageUrlsProvider = this.hooks.getUserAttachedPageUrls
  }

  setUserAttachedPageUrlsProvider(provider: () => readonly string[]): void {
    this.userAttachedPageUrlsProvider = provider
  }

  listSummaries(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => {
      return this.sessionSummary(session)
    })
  }

  createNew(id: string | undefined, options?: { readonly readOnly?: boolean }): BrowserControlSession {
    const sessionId = id ?? generateSessionId(this.sessions)
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`)
    }
    const session = this.createBrowserControlSession(sessionId, options?.readOnly === true)
    this.sessions.set(sessionId, session)
    return session
  }

  getOrCreate(id: string): { readonly session: BrowserControlSession; readonly created: boolean } {
    const existing = this.sessions.get(id)
    if (existing) {
      return { session: existing, created: false }
    }
    const session = this.createBrowserControlSession(id, false)
    this.sessions.set(id, session)
    return { session, created: true }
  }

  isReadOnly(id: string): boolean {
    return this.sessions.get(id)?.readOnly === true
  }

  isExecuting(id: string): boolean {
    return this.executing.has(id)
  }

  delete(id: string): Effect.Effect<boolean> {
    const manager = this
    return Effect.gen(function* () {
      const session = manager.sessions.get(id)
      if (!session) {
        return false
      }
      // Remove from the map first so concurrent executes with createIfMissing
      // build a fresh session instead of racing the close.
      manager.sessions.delete(id)
      // Serialize with any in-flight execute so a running script is never
      // yanked mid-flight. If the execute is wedged (for example a hung CDP
      // wait), stop waiting after a bound and force-close the sandbox anyway:
      // closing the sandbox browser rejects the hung Playwright calls, so the
      // wedged execute fails out instead of pinning the session forever.
      const closed = yield* session.executeSemaphore
        .withPermit(manager.closeBrowserControlSession(session))
        .pipe(Effect.timeoutOption(manager.hooks.deletePermitTimeoutMs ?? 15_000))
      if (Option.isNone(closed)) {
        yield* manager.closeBrowserControlSession(session)
      }
      return true
    })
  }

  reset(id: string): Effect.Effect<SessionSummary | undefined> {
    const manager = this
    return Effect.gen(function* () {
      const existing = manager.sessions.get(id)
      if (!existing) {
        return undefined
      }
      yield* existing.executeSemaphore.withPermit(manager.closeBrowserControlSession(existing))
      const session = manager.createBrowserControlSession(id, existing.readOnly)
      manager.sessions.set(id, session)
      return manager.sessionSummary(session)
    })
  }

  adoptedTargetId(id: string): string | undefined {
    return this.sessions.get(id)?.adoptedTargetId
  }

  execute(options: {
    readonly sessionId: string
    readonly code: string
    readonly createIfMissing: boolean
    readonly targetSelection?: ExecuteTargetSelection
  }): Effect.Effect<{ readonly result: ExecuteResult; readonly session: SessionSummary & { readonly created?: boolean } }, Error> {
    const manager = this
    return Effect.gen(function* () {
      const resolved = options.createIfMissing
        ? manager.getOrCreate(options.sessionId)
        : { session: manager.sessions.get(options.sessionId), created: false }
      const session = resolved.session
      if (!session) {
        return yield* Effect.fail(new Error(`Session not found: ${options.sessionId}`))
      }
      return yield* session.executeSemaphore.withPermit(
        Effect.gen(function* () {
          session.updatedAt = new Date().toISOString()
          manager.setExecuting(session.id, true)
          const startedAt = Date.now()
          const result = yield* session.sandbox
            .execute(options.code, { ...(options.targetSelection ? { targetSelection: options.targetSelection } : {}) })
            .pipe(Effect.ensuring(Effect.sync(() => manager.setExecuting(session.id, false))))
          const userAttachedPageUrls = manager.userAttachedPageUrlsProvider?.() ?? []
          const resultWithHint = shouldAppendAdoptionTip({
            explicitTargetSelection: hasExplicitTargetSelection(options.targetSelection),
            sessionCreated: resolved.created,
            warnings: result.warnings,
            userAttachedPageUrls,
          })
            ? { ...result, warnings: [...result.warnings, adoptionTipForUrl(userAttachedPageUrls[0] ?? "about:blank")] }
            : result
          session.updatedAt = new Date().toISOString()
          manager.recordExecute({ sessionId: session.id, code: options.code, durationMs: Date.now() - startedAt, result: resultWithHint })
          const summary = manager.sessionSummary(session)
          return { result: resultWithHint, session: { ...summary, ...(resolved.created ? { created: true } : {}) } }
        }),
      )
    })
  }

  adopt(options: {
    readonly sessionId: string
    readonly createIfMissing: boolean
    readonly targetId: string
    readonly targetUrl: string
  }): Effect.Effect<{ readonly adoptedUrl: string; readonly session: SessionSummary & { readonly created?: boolean }; readonly releasedTargetIds: readonly string[] }, Error> {
    const manager = this
    return Effect.gen(function* () {
      const resolved = options.createIfMissing
        ? manager.getOrCreate(options.sessionId)
        : { session: manager.sessions.get(options.sessionId), created: false }
      const session = resolved.session
      if (!session) {
        return yield* Effect.fail(new Error(`Session not found: ${options.sessionId}`))
      }
      return yield* session.executeSemaphore.withPermit(
        Effect.gen(function* () {
          const previousAdoptedTargetId = session.adoptedTargetId
          const adoptedUrl = yield* session.sandbox.adoptPage({ targetId: options.targetId, url: options.targetUrl })
          session.adoptedTargetId = options.targetId
          session.updatedAt = new Date().toISOString()
          const summary = manager.sessionSummary(session)
          const releasedTargetIds = previousAdoptedTargetId && previousAdoptedTargetId !== options.targetId
            ? [previousAdoptedTargetId]
            : []
          return { adoptedUrl, releasedTargetIds, session: { ...summary, ...(resolved.created ? { created: true } : {}) } }
        }),
      )
    })
  }

  closeAll(): Effect.Effect<void> {
    const manager = this
    return Effect.gen(function* () {
      yield* Effect.forEach(Array.from(manager.sessions.values()), (session) => {
        return manager.closeBrowserControlSession(session).pipe(Effect.ignore)
      })
      manager.sessions.clear()
    })
  }

  summary(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id)
    if (!session) {
      return undefined
    }
    return this.sessionSummary(session)
  }

  private setExecuting(id: string, executing: boolean): void {
    if (executing) {
      this.executing.add(id)
    } else {
      this.executing.delete(id)
    }
    try {
      this.hooks.onExecuteStateChange?.(id, executing)
    } catch (error) {
      console.error("Session execute-state hook failed", error)
    }
  }

  private recordExecute(record: SessionExecuteRecord): void {
    try {
      this.hooks.onExecuteRecord?.(record)
    } catch (error) {
      console.error("Session execute-record hook failed", error)
    }
  }

  private createBrowserControlSession(id: string, readOnly: boolean): BrowserControlSession {
    const now = new Date().toISOString()
    return {
      id,
      createdAt: now,
      updatedAt: now,
      readOnly,
      sandbox: this.createSandbox(id),
      executeSemaphore: Semaphore.makeUnsafe(1),
    }
  }

  private sessionSummary(session: BrowserControlSession): SessionSummary {
    const status = session.sandbox.getStatus()
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      connected: status.connected,
      pageUrl: status.pageUrl,
      stateKeys: status.stateKeys,
      ...(session.readOnly ? { readOnly: true } : {}),
    }
  }

  private closeBrowserControlSession(session: BrowserControlSession): Effect.Effect<void> {
    return session.sandbox.close().pipe(Effect.ignore)
  }
}

function targetUrlHintSelector(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.host || rawUrl
  } catch {
    return rawUrl
  }
}
