import { Deferred, Effect, Option, Schema, Semaphore } from "effect"
import { defaultPageClosedWarning, ExecuteSandbox, hasExplicitTargetSelection, type ExecuteResult, type ExecuteTargetSelection } from "./execute.ts"
import type { NetworkCaptureOptions, NetworkCaptureResult, NetworkCaptureStatus, NetworkCaptureStopOptions } from "./network-capture.ts"
import { generateSessionId } from "./relay-helpers.ts"
import type { BrowserControlSession, ExecuteSandboxLike, SessionSummary } from "./relay-types.ts"
import {
  MemoryTargetOwnership,
  type TargetOwnership,
  type TargetOwnershipChange,
  type TargetOwnershipReservation,
} from "./target-registry.ts"

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
  /** How long lifecycle commands wait for a permit or sandbox operation. */
  readonly lifecycleTimeoutMs?: number
  /** Current user-owned attached page URLs, used for relay-side adoption hints. */
  readonly getUserAttachedPageUrls?: () => readonly string[]
  /** Reconcile relay visibility and presentation after authoritative ownership changes. */
  readonly onTargetOwnershipChange?: (change: TargetOwnershipChange) => void
}

export class SessionError extends Schema.TaggedErrorClass<SessionError>()(
  "BrowserControlSessions.SessionError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "already-exists",
      "inactive",
      "invalid-request",
      "not-found",
      "setup-failed",
      "target-owned",
      "timeout",
    ]),
    sessionId: Schema.optionalKey(Schema.String),
  },
) {}

const sessionError = (
  reason: SessionError["reason"],
  message: string,
  sessionId?: string,
): SessionError => new SessionError({ message, reason, ...(sessionId ? { sessionId } : {}) })

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
  private readonly adoptSemaphore = Semaphore.makeUnsafe(1)
  private readonly targetOwnership: TargetOwnership
  private closing = false
  private userAttachedPageUrlsProvider: (() => readonly string[]) | undefined

  constructor(
    private readonly endpointUrl: string,
    createSandbox?: (id: string) => ExecuteSandboxLike,
    hooks?: SessionHooks,
    targetOwnership?: TargetOwnership,
  ) {
    this.createSandbox = createSandbox ?? ((id) => new ExecuteSandbox({ endpointUrl: this.endpointUrl, sessionId: id }))
    this.hooks = hooks ?? {}
    this.targetOwnership = targetOwnership ?? new MemoryTargetOwnership()
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
    if (this.closing) {
      throw sessionError("inactive", "Browser Control sessions are closing")
    }
    const sessionId = id ?? generateSessionId(this.sessions)
    if (this.sessions.has(sessionId)) {
      throw sessionError("already-exists", `Session already exists: ${sessionId}`, sessionId)
    }
    const session = this.createBrowserControlSession(sessionId, options?.readOnly === true)
    this.sessions.set(sessionId, session)
    return session
  }

  getOrCreate(id: string): { readonly session: BrowserControlSession; readonly created: boolean } {
    if (this.closing) {
      throw sessionError("inactive", "Browser Control sessions are closing", id)
    }
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

  markTargetCrashed(targetId: string): string[] {
    const affectedSessionIds: string[] = []
    for (const session of this.sessions.values()) {
      if (session.sandbox.markTargetCrashed(targetId)) {
        affectedSessionIds.push(session.id)
      }
    }
    return affectedSessionIds
  }

  markTargetDetached(targetId: string): string[] {
    const affectedSessionIds: string[] = []
    for (const session of this.sessions.values()) {
      if (session.sandbox.markTargetDetached(targetId)) {
        affectedSessionIds.push(session.id)
      }
    }
    return affectedSessionIds
  }

  delete(id: string): Effect.Effect<boolean, Error> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.closing) {
        return yield* Effect.fail(sessionError("inactive", "Browser Control sessions are closing", id))
      }
      const session = manager.sessions.get(id)
      if (!session) {
        return false
      }
      return yield* manager.withLifecyclePermit(session, "delete", Effect.gen(function* () {
        if (manager.sessions.get(id) !== session) {
          return false
        }
        yield* manager.closeBrowserControlSession(session)
        manager.releaseSessionTargetOwnership(session)
        manager.sessions.delete(id)
        return true
      }))
    })
  }

  reset(id: string): Effect.Effect<SessionSummary | undefined, Error> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.closing) {
        return yield* Effect.fail(sessionError("inactive", "Browser Control sessions are closing", id))
      }
      const existing = manager.sessions.get(id)
      if (!existing) {
        return undefined
      }
      return yield* manager.withLifecyclePermit(existing, "reset", Effect.gen(function* () {
        if (manager.sessions.get(id) !== existing) {
          return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
        }
        yield* manager.closeBrowserControlSession(existing)
        manager.releaseSessionTargetOwnership(existing)
        const session = manager.createBrowserControlSession(id, existing.readOnly)
        manager.sessions.set(id, session)
        return manager.sessionSummary(session)
      }))
    })
  }

  adoptedTargetId(id: string): string | undefined {
    return this.sessions.get(id)?.adoptedTargetId
  }

  releaseAdoptedTarget(targetId: string): string | undefined {
    for (const session of this.sessions.values()) {
      if (session.adoptedTargetId === targetId) {
        this.notifyTargetOwnershipChange(this.targetOwnership.releaseTargetOwnership(targetId, session.id))
        delete session.adoptedTargetId
        return session.id
      }
    }
    return undefined
  }

  networkStart(id: string, options: NetworkCaptureOptions = {}): Effect.Effect<NetworkCaptureStatus, Error> {
    const manager = this
    const session = this.sessions.get(id)
    if (!session) return Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
    return this.withLifecyclePermit(session, "network start", Effect.gen(function* () {
      if (manager.sessions.get(id) !== session) {
        return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
      }
      return yield* session.sandbox.networkStart(options)
    }))
  }

  networkStatus(id: string): Effect.Effect<NetworkCaptureStatus, Error> {
    const session = this.sessions.get(id)
    return session
      ? Effect.succeed(session.sandbox.networkStatus())
      : Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
  }

  networkStop(id: string, options: NetworkCaptureStopOptions = {}): Effect.Effect<NetworkCaptureResult, Error> {
    const manager = this
    const session = this.sessions.get(id)
    if (!session) return Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
    return this.withLifecyclePermit(session, "network stop", Effect.gen(function* () {
      if (manager.sessions.get(id) !== session) {
        return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
      }
      return yield* session.sandbox.networkStop(options)
    }))
  }

  networkCancel(id: string): Effect.Effect<{ readonly cancelled: boolean }, Error> {
    const manager = this
    const session = this.sessions.get(id)
    if (!session) return Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
    return this.withLifecyclePermit(session, "network cancel", Effect.gen(function* () {
      if (manager.sessions.get(id) !== session) {
        return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
      }
      return yield* session.sandbox.networkCancel()
    }))
  }

  authRefresh(id: string, options: { readonly name: string; readonly urlFilter?: string; readonly timeoutMs?: number }): Effect.Effect<NetworkCaptureResult, Error> {
    const manager = this
    const session = this.sessions.get(id)
    if (!session) return Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
    return this.withLifecyclePermit(session, "auth refresh", Effect.gen(function* () {
      if (manager.sessions.get(id) !== session) {
        return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
      }
      return yield* session.sandbox.authRefresh(options)
    }))
  }

  execute(options: {
    readonly sessionId?: string
    readonly code: string
    readonly createIfMissing: boolean
    readonly targetSelection?: ExecuteTargetSelection
  }): Effect.Effect<{ readonly result: ExecuteResult; readonly session: SessionSummary & { readonly created?: boolean } }, Error> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.closing) {
        return yield* Effect.fail(sessionError("inactive", "Browser Control sessions are closing"))
      }
      if (options.sessionId === undefined && !options.createIfMissing) {
        return yield* Effect.fail(sessionError("invalid-request", "sessionId is required when createIfMissing is false"))
      }
      const resolved = options.sessionId === undefined
        ? { session: manager.createNew(undefined), created: true }
        : options.createIfMissing
        ? manager.getOrCreate(options.sessionId)
        : { session: manager.sessions.get(options.sessionId), created: false }
      const session = resolved.session
      if (!session) {
        return yield* Effect.fail(sessionError("not-found", `Session not found: ${options.sessionId}`, options.sessionId))
      }
      const execution = session.executeSemaphore.withPermit(
        Effect.gen(function* () {
          if (manager.sessions.get(session.id) !== session) {
            return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${session.id}`, session.id))
          }
          session.updatedAt = new Date().toISOString()
          manager.setExecuting(session.id, true)
          const startedAt = Date.now()
          const result = yield* session.sandbox
            .execute(options.code, { ...(options.targetSelection ? { targetSelection: options.targetSelection } : {}) })
            .pipe(Effect.ensuring(Effect.sync(() => manager.setExecuting(session.id, false))))
          if (resolved.created && result.setupFailed) {
            return yield* Effect.fail(sessionError("setup-failed", result.text, session.id))
          }
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
          manager.recordExecute({
            sessionId: session.id,
            code: session.sandbox.redactNetworkCaptureText(options.code),
            durationMs: Date.now() - startedAt,
            result: resultWithHint,
          })
          const summary = manager.sessionSummary(session)
          return { result: resultWithHint, session: { ...summary, ...(resolved.created ? { created: true } : {}) } }
        }),
      )
      return yield* execution.pipe(
        Effect.catch((error) => resolved.created
          ? manager.delete(session.id).pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
          : Effect.fail(error)),
      )
    })
  }

  adopt(options: {
    readonly sessionId?: string
    readonly createIfMissing: boolean
    readonly targetId: string
    readonly targetUrl: string
  }): Effect.Effect<{ readonly adoptedUrl: string; readonly session: SessionSummary & { readonly created?: boolean }; readonly releasedTargetIds: readonly string[] }, Error> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.closing) {
        return yield* Effect.fail(sessionError("inactive", "Browser Control sessions are closing"))
      }
      if (options.sessionId === undefined && !options.createIfMissing) {
        return yield* Effect.fail(sessionError("invalid-request", "sessionId is required when createIfMissing is false"))
      }
      const resolved = options.sessionId === undefined
        ? { session: manager.createNew(undefined), created: true }
        : options.createIfMissing
        ? manager.getOrCreate(options.sessionId)
        : { session: manager.sessions.get(options.sessionId), created: false }
      const session = resolved.session
      if (!session) {
        return yield* Effect.fail(sessionError("not-found", `Session not found: ${options.sessionId}`, options.sessionId))
      }
      type AdoptionResult = {
        readonly adoptedUrl: string
        readonly session: SessionSummary & { readonly created?: boolean }
        readonly releasedTargetIds: readonly string[]
      }
      const result = yield* Deferred.make<AdoptionResult, Error>()
      let state: "pending" | "cancelled" | "committed" = "pending"
      let reservation: TargetOwnershipReservation | undefined
      const timeoutMs = manager.hooks.lifecycleTimeoutMs ?? 10_000
      const timeoutError = sessionError("timeout", `Session adopt for ${session.id} timed out after ${timeoutMs}ms`, session.id)
      const adoptionCancelled = () => state === "cancelled"
      const cancel = Effect.sync(() => {
        if (state !== "pending") {
          return
        }
        state = "cancelled"
        if (reservation) {
          manager.notifyTargetOwnershipChange(manager.targetOwnership.rollbackTargetOwnership(reservation))
        }
      })
      const operation = Effect.gen(function* () {
          if (manager.sessions.get(session.id) !== session) {
            return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${session.id}`, session.id))
          }
          if (adoptionCancelled()) {
            if (resolved.created) {
              yield* manager.cleanupSettledAdoption(session, true)
            }
            return yield* Effect.fail(timeoutError)
          }
          const previousAdoptedTargetId = session.adoptedTargetId
          reservation = yield* Effect.try({
            try: () => manager.targetOwnership.reserveTargetOwnership(options.targetId, session.id),
            catch: (cause) => cause instanceof Error ? cause : new Error("Reserve target ownership", { cause }),
          })
          manager.notifyTargetOwnershipChange({ targetIds: [options.targetId], tabIds: reservation.tabId < 0 ? [] : [reservation.tabId] })
          const adoptedUrl = yield* session.sandbox.adoptPage({ targetId: options.targetId, url: options.targetUrl })
          if (adoptionCancelled()) {
            manager.notifyTargetOwnershipChange(manager.targetOwnership.rollbackTargetOwnership(reservation))
            yield* manager.cleanupSettledAdoption(session, resolved.created)
            return yield* Effect.fail(timeoutError)
          }
          const activeReservation = reservation
          return yield* Effect.try({
            try: () => {
              state = "committed"
              manager.notifyTargetOwnershipChange(manager.targetOwnership.commitTargetOwnership({
                reservation: activeReservation,
                ...(previousAdoptedTargetId ? { previousAdoptedTargetId } : {}),
              }))
              session.adoptedTargetId = options.targetId
              session.updatedAt = new Date().toISOString()
              const summary = manager.sessionSummary(session)
              const releasedTargetIds = previousAdoptedTargetId && previousAdoptedTargetId !== options.targetId
                ? [previousAdoptedTargetId]
                : []
              const value = { adoptedUrl, releasedTargetIds, session: { ...summary, ...(resolved.created ? { created: true } : {}) } }
              Deferred.doneUnsafe(result, Effect.succeed(value))
              return value
            },
            catch: (cause) => cause instanceof Error ? cause : new Error("Commit target ownership", { cause }),
          }).pipe(
            Effect.catch((error) => manager.cleanupSettledAdoption(session, resolved.created).pipe(
              Effect.andThen(Effect.fail(error)),
            )),
          )
        })
      const transaction = session.executeSemaphore.withPermit(operation.pipe(Effect.matchEffect({
        onFailure: (error) => Effect.gen(function* () {
          if (reservation) {
            manager.notifyTargetOwnershipChange(manager.targetOwnership.rollbackTargetOwnership(reservation))
          }
          if (resolved.created && manager.sessions.get(session.id) === session) {
            yield* manager.closeBrowserControlSessionSettled(session)
            manager.sessions.delete(session.id)
          }
          yield* Deferred.fail(result, error)
        }),
        onSuccess: () => Effect.void,
      })))
      const worker = manager.adoptSemaphore.withPermit(transaction)
      yield* worker.pipe(Effect.forkDetach({ startImmediately: true }))
      return yield* Deferred.await(result).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => cancel.pipe(Effect.andThen(Effect.fail(timeoutError))),
        }),
        Effect.onInterrupt(() => cancel),
      )
    })
  }

  closeAll(): Effect.Effect<void> {
    const manager = this
    return Effect.gen(function* () {
      manager.closing = true
      yield* manager.adoptSemaphore.withPermit(Effect.gen(function* () {
        const closedSessionIds = yield* Effect.forEach(Array.from(manager.sessions.values()), (session) => {
          return manager.withLifecyclePermit(
            session,
            "close",
            manager.closeBrowserControlSession(session),
          ).pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: () => session.id,
            }),
          )
        })
        for (const id of closedSessionIds) {
          if (!id) continue
          const session = manager.sessions.get(id)
          if (!session) continue
          manager.releaseSessionTargetOwnership(session)
          manager.sessions.delete(id)
        }
      }))
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
    return this.withLifecycleTimeout(session.sandbox.close(), `Close session ${session.id}`).pipe(Effect.ignore)
  }

  private closeBrowserControlSessionSettled(session: BrowserControlSession): Effect.Effect<void> {
    return session.sandbox.closeSettled().pipe(Effect.ignore)
  }

  private releaseSessionTargetOwnership(session: BrowserControlSession): void {
    if (session.adoptedTargetId) {
      this.notifyTargetOwnershipChange(this.targetOwnership.releaseTargetOwnership(session.adoptedTargetId, session.id))
      delete session.adoptedTargetId
    }
  }

  private notifyTargetOwnershipChange(change: TargetOwnershipChange): void {
    if (change.targetIds.length === 0 && change.tabIds.length === 0) {
      return
    }
    try {
      this.hooks.onTargetOwnershipChange?.(change)
    } catch (error) {
      console.error("Target ownership hook failed", error)
    }
  }

  private cleanupSettledAdoption(session: BrowserControlSession, created: boolean): Effect.Effect<void> {
    const manager = this
    return Effect.gen(function* () {
      yield* manager.closeBrowserControlSessionSettled(session)
      if (manager.sessions.get(session.id) !== session) {
        return
      }
      if (created) {
        manager.sessions.delete(session.id)
        return
      }
      const replacement = manager.createBrowserControlSession(session.id, session.readOnly)
      manager.sessions.set(session.id, {
        ...replacement,
        createdAt: session.createdAt,
        ...(session.adoptedTargetId ? { adoptedTargetId: session.adoptedTargetId } : {}),
      })
    })
  }

  private withLifecyclePermit<A, E, R>(
    session: BrowserControlSession,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    const acquire = session.executeSemaphore.take(1).pipe(
      Effect.timeoutOption(this.hooks.lifecycleTimeoutMs ?? 10_000),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(sessionError("timeout", `Session ${operation} timed out waiting for active execute in ${session.id}`, session.id)),
        onSome: () => Effect.void,
      })),
    )
    return Effect.acquireUseRelease(
      acquire,
      () => effect,
      () => session.executeSemaphore.release(1).pipe(Effect.asVoid),
    )
  }

  private withLifecycleTimeout<A, E, R>(effect: Effect.Effect<A, E, R>, label: string): Effect.Effect<A, E | Error, R> {
    const timeoutMs = this.hooks.lifecycleTimeoutMs ?? 10_000
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(sessionError("timeout", `${label} timed out after ${timeoutMs}ms`)),
      }),
    )
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
