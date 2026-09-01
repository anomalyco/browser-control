import { Deferred, Effect, Fiber, Latch, Schema, Semaphore } from "effect"
import { defaultPageClosedWarning, ExecuteSandbox, hasExplicitTargetSelection, type ExecuteResult, type ExecuteTargetSelection } from "./execute.ts"
import type { NetworkCaptureOptions, NetworkCaptureResult, NetworkCaptureStatus, NetworkCaptureStopOptions } from "./network-capture.ts"
import { generateSessionId } from "./relay-helpers.ts"
import type { BrowserControlSession, ExecuteSandboxLike, SessionSummary, SessionTarget } from "./relay-types.ts"
import type { AuthenticatedJsonOutcome, AuthenticatedJsonRequest } from "./relay-schema.ts"
import type { PersistedSession } from "./session-catalog.ts"
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
  /** Called after each execute completes, for journaling. Failure is logged and ignored. */
  readonly onExecuteRecord?: (record: SessionExecuteRecord) => unknown | Promise<unknown>
  /** How long lifecycle commands wait for a permit or sandbox operation. */
  readonly lifecycleTimeoutMs?: number
  /** Maximum time best-effort journal I/O may retain an execute permit. */
  readonly journalTimeoutMs?: number
  /** Current user-owned attached page URLs, used for relay-side adoption hints. */
  readonly getUserAttachedPageUrls?: () => readonly string[]
  /** Reconcile relay visibility and presentation after authoritative ownership changes. */
  readonly onTargetOwnershipChange?: (change: TargetOwnershipChange) => void
  /** Close a live relay-owned target by its durable target id. */
  readonly onReleaseRelayTarget?: (targetId: string) => Effect.Effect<void, Error>
  /** Persist session identity and target continuity after durable lifecycle changes. */
  readonly onSessionsChanged?: (sessions: readonly PersistedSession[]) => unknown | Promise<unknown>
}

export class SessionError extends Schema.TaggedError<SessionError>()(
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
  private readonly createSandbox: (id: string, onDefaultTargetChange: (target: SessionTarget | undefined) => void) => ExecuteSandboxLike
  private readonly hooks: SessionHooks
  private readonly executing = new Set<string>()
  private readonly adoptSemaphore = Semaphore.makeUnsafe(1)
  private readonly targetOwnership: TargetOwnership
  private persistenceTail = Promise.resolve()
  private drainedPersistenceTail: Promise<void> | undefined
  private admission: "open" | "draining" | "closed" = "open"
  private pendingWork = 0
  private readonly pendingSessionWork = new Map<string, number>()
  private readonly idle = Latch.makeUnsafe(true)
  private userAttachedPageUrlsProvider: (() => readonly string[]) | undefined

  constructor(
    private readonly endpointUrl: string,
    createSandbox?: (id: string, onDefaultTargetChange: (target: SessionTarget | undefined) => void) => ExecuteSandboxLike,
    hooks?: SessionHooks,
    targetOwnership?: TargetOwnership,
  ) {
    this.createSandbox = createSandbox ?? ((id, onDefaultTargetChange) => new ExecuteSandbox({ endpointUrl: this.endpointUrl, sessionId: id, onDefaultTargetChange }))
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

  restore(entries: readonly PersistedSession[]): void {
    this.assertAdmission()
    if (this.sessions.size > 0) throw new Error("Cannot restore sessions after session management has started")
    const ids = new Set<string>()
    const targetOwners = new Set<string>()
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`Duplicate persisted session: ${entry.id}`)
      ids.add(entry.id)
      if (entry.target && targetOwners.has(entry.target.id)) {
        throw new Error(`Duplicate persisted target owner: ${entry.target.id}`)
      }
      if (entry.target) targetOwners.add(entry.target.id)
    }
    for (const entry of entries) {
      const session = this.createBrowserControlSession(entry.id, entry.readOnly, {
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })
      if (entry.target) session.target = entry.target
      session.sandbox.restore(entry.target)
      this.sessions.set(entry.id, session)
    }
  }

  persistedTargetOwner(targetId: string): { readonly sessionId: string; readonly owner: "relay" | "user" } | undefined {
    for (const session of this.sessions.values()) {
      const target = session.target
      if (target?.id === targetId) return { sessionId: session.id, owner: target.owner }
    }
    return undefined
  }

  private updateTarget(session: BrowserControlSession, target: SessionTarget | undefined): void {
    if (this.sessions.get(session.id) !== session) return
    if (session.target?.id === target?.id && session.target?.owner === target?.owner) return
    if (target) session.target = target
    else delete session.target
    session.updatedAt = new Date().toISOString()
    this.schedulePersistence()
  }

  createNew(id: string | undefined, options?: { readonly readOnly?: boolean }): BrowserControlSession {
    this.assertAdmission()
    return this.createAcceptedSession(id, options)
  }

  private createAcceptedSession(id: string | undefined, options?: { readonly readOnly?: boolean }): BrowserControlSession {
    const sessionId = id ?? generateSessionId(this.sessions)
    if (this.sessions.has(sessionId)) {
      throw sessionError("already-exists", `Session already exists: ${sessionId}`, sessionId)
    }
    const session = this.createBrowserControlSession(sessionId, options?.readOnly === true)
    this.sessions.set(sessionId, session)
    this.schedulePersistence()
    return session
  }

  create(id: string | undefined, options?: { readonly readOnly?: boolean }): Effect.Effect<BrowserControlSession, Error> {
    return this.withAdmission(id, this.createPersistedSession(id, options).pipe(Effect.uninterruptible))
  }

  ensure(id: string, options?: { readonly readOnly?: boolean }): Effect.Effect<SessionSummary, Error> {
    const manager = this
    return this.withAdmission(id, Effect.gen(function* () {
      const existing = manager.sessions.get(id)
      if (existing) {
        if (options?.readOnly === true && !existing.readOnly) {
          return yield* Effect.fail(sessionError(
            "invalid-request",
            `Session ${id} already exists with write access and cannot be ensured as read-only`,
            id,
          ))
        }
        return manager.sessionSummary(existing)
      }
      const session = yield* manager.createPersistedSession(id, options)
      return manager.sessionSummary(session)
    }).pipe(Effect.uninterruptible))
  }

  private readonly createPersistedSession = Effect.fnUntraced(function* (this: BrowserControlSessions, id: string | undefined, options?: { readonly readOnly?: boolean }) {
    const manager = this
    const session = manager.createAcceptedSession(id, options)
    yield* manager.flushPersistence().pipe(Effect.catch((error) => Effect.gen(function* () {
      if (manager.sessions.get(session.id) === session) manager.sessions.delete(session.id)
      yield* manager.closeBrowserControlSession(session)
      manager.schedulePersistence()
      yield* manager.flushPersistence().pipe(Effect.ignore)
      return yield* Effect.fail(error)
    })))
    return session
  })

  getOrCreate(id: string): { readonly session: BrowserControlSession; readonly created: boolean } {
    this.assertAdmission()
    return this.getOrCreateAcceptedSession(id)
  }

  private getOrCreateAcceptedSession(id: string): { readonly session: BrowserControlSession; readonly created: boolean } {
    const existing = this.sessions.get(id)
    if (existing) {
      return { session: existing, created: false }
    }
    return { session: this.createAcceptedSession(id), created: true }
  }

  isReadOnly(id: string): boolean {
    return this.sessions.get(id)?.readOnly === true
  }

  isExecuting(id: string): boolean {
    return this.executing.has(id)
  }

  hasPendingWork(id: string): boolean {
    return this.pendingSessionWork.has(id)
  }

  hasActiveNetworkCapture(): boolean {
    return Array.from(this.sessions.values()).some((session) => session.sandbox.networkStatus().active)
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
      if (session.target?.id === targetId && session.target.owner === "user") {
        this.notifyTargetOwnershipChange(this.targetOwnership.releaseTargetOwnership(targetId, session.id))
      }
      if (session.target?.id === targetId) {
        this.updateTarget(session, undefined)
      }
    }
    return affectedSessionIds
  }

  markTargetReplaced(previousTargetId: string, targetId: string): string[] {
    const affected: string[] = []
    for (const session of this.sessions.values()) {
      if (session.target?.id === previousTargetId) this.updateTarget(session, { ...session.target, id: targetId })
      if (session.sandbox.markTargetReplaced(previousTargetId, targetId)) {
        affected.push(session.id)
      }
    }
    return affected
  }

  delete(id: string): Effect.Effect<boolean, Error> {
    const manager = this
    return this.withAdmission(id, Effect.gen(function* () {
      const session = manager.sessions.get(id)
      if (!session) {
        return false
      }
      return yield* manager.withLifecyclePermit(session, "delete", Effect.gen(function* () {
        if (manager.sessions.get(id) !== session) {
          return false
        }
        if (session.target?.owner === "relay") yield* manager.closeRelayTarget(session.target.id)
        manager.sessions.delete(id)
        manager.schedulePersistence()
        yield* manager.flushPersistence().pipe(Effect.catch((error) => Effect.gen(function* () {
          manager.sessions.set(id, session)
          manager.schedulePersistence()
          yield* manager.flushPersistence().pipe(Effect.ignore)
          return yield* Effect.fail(error)
        })))
        yield* manager.releaseSessionTargetOwnership(session)
        yield* manager.closeBrowserControlSession(session)
        return true
      }))
    }))
  }

  reset(id: string): Effect.Effect<SessionSummary | undefined, Error> {
    const manager = this
    return this.withAdmission(id, Effect.gen(function* () {
      const existing = manager.sessions.get(id)
      if (!existing) {
        return undefined
      }
      return yield* manager.withLifecyclePermit(existing, "reset", Effect.gen(function* () {
        if (manager.sessions.get(id) !== existing) {
          return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
        }
        if (existing.target?.owner === "relay") yield* manager.closeRelayTarget(existing.target.id)
        const session = manager.createBrowserControlSession(id, existing.readOnly)
        manager.sessions.set(id, session)
        manager.schedulePersistence()
        yield* manager.flushPersistence().pipe(Effect.catch((error) => Effect.gen(function* () {
          manager.sessions.set(id, existing)
          manager.schedulePersistence()
          yield* manager.flushPersistence().pipe(Effect.ignore)
          return yield* Effect.fail(error)
        })))
        yield* manager.releaseSessionTargetOwnership(existing)
        yield* manager.closeBrowserControlSession(existing)
        return manager.sessionSummary(session)
      }))
    }))
  }

  adoptedTargetId(id: string): string | undefined {
    const target = this.sessions.get(id)?.target
    return target?.owner === "user" ? target.id : undefined
  }

  networkStart(id: string, options: NetworkCaptureOptions = {}): Effect.Effect<NetworkCaptureStatus, Error> {
    return this.withSessionOperation(id, "network start", (session) => session.sandbox.networkStart(options))
  }

  networkStatus(id: string): Effect.Effect<NetworkCaptureStatus, Error> {
    const session = this.sessions.get(id)
    return session
      ? Effect.succeed(session.sandbox.networkStatus())
      : Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
  }

  networkStop(id: string, options: NetworkCaptureStopOptions = {}): Effect.Effect<NetworkCaptureResult, Error> {
    return this.withSessionOperation(id, "network stop", (session) => session.sandbox.networkStop(options))
  }

  networkCancel(id: string): Effect.Effect<{ readonly cancelled: boolean }, Error> {
    return this.withSessionOperation(id, "network cancel", (session) => session.sandbox.networkCancel())
  }

  authRefresh(id: string, options: { readonly name: string; readonly urlFilter?: string; readonly timeoutMs?: number }): Effect.Effect<NetworkCaptureResult, Error> {
    return this.withSessionOperation(id, "auth refresh", (session) => session.sandbox.authRefresh(options))
  }

  private withSessionOperation<A>(id: string, operation: string, use: (session: BrowserControlSession) => Effect.Effect<A, Error>): Effect.Effect<A, Error> {
    const manager = this
    return this.withAdmission(id, Effect.suspend(() => {
      const session = manager.sessions.get(id)
      if (!session) return Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
      return manager.withLifecyclePermit(session, operation, Effect.gen(function* () {
        if (manager.sessions.get(id) !== session) {
          return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${id}`, id))
        }
        return yield* use(session)
      }))
    }))
  }

  authenticatedJson(
    request: AuthenticatedJsonRequest,
  ): Effect.Effect<AuthenticatedJsonOutcome, Error> {
    const manager = this
    return this.withAdmission(request.sessionId, Effect.suspend(() => {
      const session = manager.sessions.get(request.sessionId)
      if (!session) {
        return Effect.fail(sessionError("not-found", `Session not found: ${request.sessionId}`, request.sessionId))
      }
      if (session.readOnly && request.method !== "GET") {
        return Effect.fail(sessionError(
          "invalid-request",
          `Read-only session ${request.sessionId} cannot make ${request.method} authenticated requests`,
          request.sessionId,
        ))
      }
      const { sessionId: _sessionId, ...pageRequest } = request
      return manager.withLifecyclePermit(session, "authenticated request", Effect.gen(function* () {
        if (manager.sessions.get(session.id) !== session) {
          return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${session.id}`, session.id))
        }
        manager.setExecuting(session.id, true)
        const result = yield* session.sandbox.authenticatedJson(pageRequest).pipe(
          Effect.ensuring(Effect.sync(() => manager.setExecuting(session.id, false))),
        )
        session.updatedAt = new Date().toISOString()
        manager.schedulePersistence()
        yield* manager.flushPersistence()
        return result
      }))
    }))
  }

  execute(options: {
    readonly sessionId?: string
    readonly code: string
    readonly createIfMissing: boolean
    readonly targetSelection?: ExecuteTargetSelection
  }): Effect.Effect<{ readonly result: ExecuteResult; readonly session: SessionSummary & { readonly created?: boolean } }, Error> {
    const manager = this
    return this.withAdmission(options.sessionId, Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (options.sessionId === undefined && !options.createIfMissing) {
        return yield* Effect.fail(sessionError("invalid-request", "sessionId is required when createIfMissing is false"))
      }
      const resolved = options.sessionId === undefined
        ? { session: manager.createAcceptedSession(undefined), created: true }
        : options.createIfMissing
        ? manager.getOrCreateAcceptedSession(options.sessionId)
        : { session: manager.sessions.get(options.sessionId), created: false }
      const session = resolved.session
      if (!session) {
        return yield* Effect.fail(sessionError("not-found", `Session not found: ${options.sessionId}`, options.sessionId))
      }
      type ExecutionResponse = { readonly result: ExecuteResult; readonly session: SessionSummary & { readonly created?: boolean } }
      const response = yield* Deferred.make<ExecutionResponse, Error>()
      let started = false
      let cancelled = false
      const operation = Effect.gen(function* () {
          if (cancelled) {
            return yield* Effect.fail(sessionError("inactive", `Session execute was cancelled before starting: ${session.id}`, session.id))
          }
          if (manager.sessions.get(session.id) !== session) {
            return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${session.id}`, session.id))
          }
          started = true
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
          yield* manager.recordExecute({
            sessionId: session.id,
            code: session.sandbox.redactNetworkCaptureText(options.code),
            durationMs: Date.now() - startedAt,
            result: resultWithHint,
          })
          manager.schedulePersistence()
          yield* manager.flushPersistence()
          const summary = manager.sessionSummary(session)
          return { result: resultWithHint, session: { ...summary, ...(resolved.created ? { created: true } : {}) } }
        })
      const worker = session.executeSemaphore.withPermit(operation.pipe(Effect.matchEffect({
        onFailure: (error) => (resolved.created
          ? manager.cleanupCreatedSession(session)
          : Effect.void).pipe(Effect.andThen(Deferred.fail(response, error))),
        onSuccess: (value) => Deferred.succeed(response, value),
      })))
      const workerFiber = yield* manager.forkTracked(worker, session.id)
      return yield* restore(Deferred.await(response)).pipe(
        Effect.onInterrupt(() => Effect.suspend(() => {
          if (started) return Effect.void
          cancelled = true
          return Fiber.interrupt(workerFiber).pipe(
            Effect.asVoid,
            Effect.andThen(resolved.created
              ? session.executeSemaphore.withPermit(manager.cleanupCreatedSession(session))
              : Effect.void),
          )
        })),
      )
    })))
  }

  adopt(options: {
    readonly sessionId?: string
    readonly createIfMissing: boolean
    readonly targetId: string
    readonly targetUrl: string
  }): Effect.Effect<{ readonly adoptedUrl: string; readonly session: SessionSummary & { readonly created?: boolean }; readonly releasedTargetIds: readonly string[] }, Error> {
    const manager = this
    return this.withAdmission(options.sessionId, Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (options.sessionId === undefined && !options.createIfMissing) {
        return yield* Effect.fail(sessionError("invalid-request", "sessionId is required when createIfMissing is false"))
      }
      const resolved = options.sessionId === undefined
        ? { session: manager.createAcceptedSession(undefined), created: true }
        : options.createIfMissing
        ? manager.getOrCreateAcceptedSession(options.sessionId)
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
      let state: "pending" | "reserved" | "committed" = "pending"
      let cancelled = false
      let reservation: TargetOwnershipReservation | undefined
      let previousTarget: SessionTarget | undefined
      let previousRelayClosed = false
      const timeoutMs = manager.hooks.lifecycleTimeoutMs ?? 10_000
      const timeoutError = sessionError("timeout", `Session adopt for ${session.id} timed out after ${timeoutMs}ms`, session.id)
      const adoptionCancelled = () => cancelled
      const cancel = Effect.sync(() => {
        if (cancelled) {
          return
        }
        cancelled = true
        if (reservation && state === "reserved") {
          manager.notifyTargetOwnershipChange(manager.targetOwnership.rollbackTargetOwnership(reservation))
        }
      })
      const operation = Effect.gen(function* () {
          if (manager.sessions.get(session.id) !== session) {
            return yield* Effect.fail(sessionError("inactive", `Session is no longer active: ${session.id}`, session.id))
          }
          if (adoptionCancelled()) {
            return yield* Effect.fail(timeoutError)
          }
          reservation = yield* Effect.try({
            try: () => manager.targetOwnership.reserveTargetOwnership(options.targetId, session.id),
            catch: (cause) => cause instanceof Error ? cause : new Error("Reserve target ownership", { cause }),
          })
          state = "reserved"
          manager.notifyTargetOwnershipChange({ targetIds: [options.targetId], tabIds: reservation.tabId < 0 ? [] : [reservation.tabId] })
          previousTarget = session.target
          const adoptedUrl = yield* session.sandbox.adoptPage({ targetId: options.targetId, url: options.targetUrl })
          if (adoptionCancelled()) {
            return yield* Effect.fail(timeoutError)
          }
          const activeReservation = reservation
          previousTarget = session.target ?? previousTarget
          const previousTargetId = previousTarget?.id
          if (previousTarget?.owner === "relay" && previousTarget.id !== options.targetId) {
            yield* manager.closeRelayTarget(previousTarget.id)
            previousRelayClosed = true
          }
          session.target = { id: options.targetId, owner: "user" }
          session.updatedAt = new Date().toISOString()
          manager.schedulePersistence()
          yield* manager.flushPersistence()
          if (adoptionCancelled()) {
            return yield* Effect.fail(timeoutError)
          }
          yield* Effect.try({
            try: () => {
              manager.notifyTargetOwnershipChange(manager.targetOwnership.commitTargetOwnership({
                reservation: activeReservation,
                ...(previousTargetId ? { previousAdoptedTargetId: previousTargetId } : {}),
              }))
              state = "committed"
            },
            catch: (cause) => cause instanceof Error ? cause : new Error("Commit target ownership", { cause }),
          })
          const summary = manager.sessionSummary(session)
          const releasedTargetIds = previousTargetId && previousTargetId !== options.targetId ? [previousTargetId] : []
          const value = { adoptedUrl, releasedTargetIds, session: { ...summary, ...(resolved.created ? { created: true } : {}) } }
          yield* Deferred.succeed(result, value)
          return value
        })
      const transaction = session.executeSemaphore.withPermit(operation.pipe(Effect.matchEffect({
        onFailure: (error) => Effect.gen(function* () {
          if (reservation && state !== "committed") {
            manager.notifyTargetOwnershipChange(manager.targetOwnership.rollbackTargetOwnership(reservation))
          }
          if (manager.sessions.get(session.id) === session && (resolved.created || state !== "pending")) {
            const cleanup = yield* Effect.result(manager.cleanupSettledAdoption(session, resolved.created, previousTarget, previousRelayClosed))
            if (cleanup._tag === "Failure") {
              yield* Deferred.fail(result, cleanup.failure)
              return
            }
          }
          yield* Deferred.fail(result, error)
        }),
        onSuccess: () => Effect.void,
      })))
      const worker = manager.adoptSemaphore.withPermit(transaction)
      yield* manager.forkTracked(worker, session.id)
      return yield* restore(Deferred.await(result).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => cancel.pipe(Effect.andThen(Effect.fail(timeoutError))),
        }),
        Effect.onInterrupt(() => cancel),
      ))
    })))
  }

  /** Stop admission without cancelling accepted work or disconnecting sessions. */
  beginDrain(): Effect.Effect<void, Error> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.admission === "open") manager.admission = "draining"
      while (true) {
        yield* manager.idle.await
        const pending = manager.persistenceTail
        yield* manager.flushPersistence()
        // Target callbacks can append persistence while the previous tail settles.
        if (manager.pendingWork === 0 && pending === manager.persistenceTail) {
          manager.drainedPersistenceTail = pending
          return
        }
      }
    })
  }

  /** Recheck synchronously at commit: late catalog writes invalidate a completed drain. */
  isDrained(): boolean {
    return this.admission !== "open"
      && this.pendingWork === 0
      && this.drainedPersistenceTail === this.persistenceTail
  }

  /** Call only after cancelling or completing the reversible drain waiter. */
  resume(): void {
    if (this.admission === "draining") this.admission = "open"
  }

  closeAll(): Effect.Effect<void> {
    const manager = this
    return Effect.gen(function* () {
      manager.admission = "closed"
      yield* manager.beginDrain().pipe(Effect.ignore)
      yield* manager.adoptSemaphore.withPermit(Effect.gen(function* () {
        const closedSessionIds = yield* Effect.forEach(Array.from(manager.sessions.values()), (session) => {
          return session.executeSemaphore.withPermit(
            manager.disconnectBrowserControlSession(session),
          ).pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: () => session.id,
            }),
          )
        }, { concurrency: "unbounded" })
        yield* manager.flushPersistence().pipe(Effect.ignore)
        for (const id of closedSessionIds) {
          if (!id) continue
          manager.sessions.delete(id)
        }
      }))
    }).pipe(Effect.uninterruptible)
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

  private recordExecute(record: SessionExecuteRecord): Effect.Effect<void> {
    const hook = this.hooks.onExecuteRecord
    if (!hook) return Effect.void
    return Effect.tryPromise({
      try: async () => {
        const release = this.retainWork(record.sessionId)
        try {
          return await hook(record)
        } finally {
          release()
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.timeoutOrElse({
        duration: this.hooks.journalTimeoutMs ?? 2_000,
        orElse: () => Effect.fail(new Error(`Session journal write timed out after ${this.hooks.journalTimeoutMs ?? 2_000}ms`)),
      }),
      Effect.catch((error) => Effect.sync(() => {
        console.error("Session execute-record hook failed", error)
      })),
      Effect.asVoid,
    )
  }

  private createBrowserControlSession(id: string, readOnly: boolean, timestamps?: {
    readonly createdAt: string
    readonly updatedAt?: string
  }): BrowserControlSession {
    const now = new Date().toISOString()
    let session: BrowserControlSession | undefined
    session = {
      id,
      createdAt: timestamps?.createdAt ?? now,
      updatedAt: timestamps?.updatedAt ?? now,
      readOnly,
      sandbox: this.createSandbox(id, (target) => {
        if (session) this.updateTarget(session, target)
      }),
      executeSemaphore: Semaphore.makeUnsafe(1),
    }
    return session
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
    return this.forkTracked(this.closeBrowserControlSessionSettled(session), session.id).pipe(
      Effect.flatMap((worker) => this.withLifecycleTimeout(Fiber.join(worker), `Close session ${session.id}`)),
      Effect.ignore,
    )
  }

  private disconnectBrowserControlSession(session: BrowserControlSession): Effect.Effect<void> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.retainWork(session.id)),
      () => session.sandbox.disconnectSettled().pipe(Effect.ignore),
      (release) => Effect.sync(release),
    )
  }

  private closeBrowserControlSessionSettled(session: BrowserControlSession): Effect.Effect<void> {
    return session.sandbox.closeSettled().pipe(Effect.ignore)
  }

  private releaseSessionTargetOwnership(session: BrowserControlSession): Effect.Effect<void> {
    const target = session.target
    if (!target) return Effect.void
    this.notifyTargetOwnershipChange(this.targetOwnership.releaseTargetOwnership(target.id, session.id))
    delete session.target
    return Effect.void
  }

  private closeRelayTarget(targetId: string): Effect.Effect<void, Error> {
    const close = this.hooks.onReleaseRelayTarget?.(targetId)
    return close ?? Effect.void
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

  private persistedSession(session: BrowserControlSession): PersistedSession {
    const target = session.target
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      readOnly: session.readOnly,
      ...(target ? { target } : {}),
    }
  }

  private persistedSessions(): PersistedSession[] {
    return Array.from(this.sessions.values(), (session) => this.persistedSession(session))
  }

  private schedulePersistence(sessions = this.persistedSessions()): void {
    const hook = this.hooks.onSessionsChanged
    if (!hook) return
    const release = this.retainWork()
    const previous = this.persistenceTail
    this.persistenceTail = previous.catch(() => {}).then(async () => {
      try {
        await hook(sessions)
      } finally {
        release()
      }
    })
    void this.persistenceTail.catch((error) => {
      console.error("Failed to persist Browser Control sessions", error)
    })
  }

  private flushPersistence(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.persistenceTail,
      catch: (cause) => cause instanceof Error ? cause : new Error("Persist Browser Control sessions", { cause }),
    })
  }

  persist(): Effect.Effect<void, Error> {
    return this.flushPersistence()
  }

  private cleanupSettledAdoption(
    session: BrowserControlSession,
    created: boolean,
    previousTarget?: SessionTarget,
    previousRelayClosed = false,
  ): Effect.Effect<void, Error> {
    const manager = this
    return Effect.gen(function* () {
      const activeTarget = session.target
      yield* manager.releaseSessionTargetOwnership(session)
      if (previousTarget && previousTarget.id !== activeTarget?.id) {
        manager.notifyTargetOwnershipChange(manager.targetOwnership.releaseTargetOwnership(previousTarget.id, session.id))
        if (previousTarget.owner === "relay" && !previousRelayClosed) yield* manager.closeRelayTarget(previousTarget.id)
      }
      yield* manager.closeBrowserControlSessionSettled(session)
      if (manager.sessions.get(session.id) !== session) {
        return
      }
      if (created) {
        manager.sessions.delete(session.id)
        manager.schedulePersistence()
        yield* manager.flushPersistence()
        return
      }
      const replacement = manager.createBrowserControlSession(session.id, session.readOnly, {
        createdAt: session.createdAt,
      })
      manager.sessions.set(session.id, replacement)
      manager.schedulePersistence()
      yield* manager.flushPersistence()
    })
  }

  private cleanupCreatedSession(session: BrowserControlSession): Effect.Effect<void> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.sessions.get(session.id) !== session) return
      manager.sessions.delete(session.id)
      yield* manager.releaseSessionTargetOwnership(session)
      yield* manager.closeBrowserControlSession(session)
      manager.schedulePersistence()
      yield* manager.flushPersistence().pipe(Effect.ignore)
    })
  }

  private assertAdmission(): void {
    if (this.admission !== "open") {
      throw sessionError("inactive", this.admission === "closed"
        ? "Browser Control sessions are closing"
        : "Browser Control sessions are draining")
    }
  }

  private retainWork(sessionId?: string): () => void {
    this.pendingWork += 1
    if (sessionId !== undefined) this.pendingSessionWork.set(sessionId, (this.pendingSessionWork.get(sessionId) ?? 0) + 1)
    this.idle.closeUnsafe()
    return () => {
      this.pendingWork -= 1
      if (sessionId !== undefined) {
        const remaining = (this.pendingSessionWork.get(sessionId) ?? 1) - 1
        if (remaining === 0) this.pendingSessionWork.delete(sessionId)
        else this.pendingSessionWork.set(sessionId, remaining)
      }
      if (this.pendingWork === 0) this.idle.openUnsafe()
    }
  }

  private withAdmission<A, E, R>(sessionId: string | undefined, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> {
    return Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          this.assertAdmission()
          return this.retainWork(sessionId)
        },
        catch: (cause) => cause instanceof Error ? cause : new Error("Admit session operation", { cause }),
      }),
      () => effect,
      (release) => Effect.sync(release),
    )
  }

  private forkTracked<A, E, R>(effect: Effect.Effect<A, E, R>, sessionId: string): Effect.Effect<Fiber.Fiber<A, E>, never, R> {
    return Effect.uninterruptibleMask(() => Effect.suspend(() => {
      // Transfer the lease before forking; caller interruption cannot strand it.
      const release = this.retainWork(sessionId)
      return effect.pipe(
        Effect.ensuring(Effect.sync(release)),
        Effect.forkDetach({ startImmediately: true }),
      )
    }))
  }

  private withLifecyclePermit<A, E, R>(
    session: BrowserControlSession,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      let state: "waiting" | "started" | "timed-out" = "waiting"
      const timeout = sessionError("timeout", `Session ${operation} timed out waiting for active execute in ${session.id}`, session.id)
      // withPermit installs release atomically; racing a bare take can lose a granted permit.
      return Effect.raceFirst(
        session.executeSemaphore.withPermit(Effect.suspend((): Effect.Effect<A, E | Error, R> => {
          if (state === "timed-out") return Effect.fail(timeout)
          state = "started"
          return effect
        }).pipe(Effect.uninterruptible)),
        Effect.sleep(this.hooks.lifecycleTimeoutMs ?? 10_000).pipe(Effect.flatMap(() => {
          if (state === "started") return Effect.never
          state = "timed-out"
          return Effect.fail(timeout)
        })),
      )
    })
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
