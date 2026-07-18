/**
 * Human-in-the-loop handoff registry.
 *
 * A running execute script can call `await handoff("Complete the 2FA prompt")`.
 * The sandbox registers a pending handoff for its Browser Control session and
 * exact tab, then blocks until the in-page completion control sends the
 * matching handoff id or the timeout elapses.
 */

export type HandoffCancellationReason = "target-detached" | "target-crashed"

export type HandoffOutcome =
  | "resolved"
  | "timeout"
  | { readonly type: "cancelled"; readonly reason: HandoffCancellationReason }

type PendingHandoff = {
  readonly id: string
  readonly sessionId: string
  readonly tabId: number
  readonly targetId: string
  readonly targetSessionId: string
  readonly message: string
  readonly resolve: (outcome: HandoffOutcome) => void
}

export type HandoffWait = {
  readonly id: string
  readonly outcome: Promise<HandoffOutcome>
}

export type PendingHandoffView = {
  readonly id: string
  readonly sessionId: string
  readonly tabId: number
  readonly targetId: string
  readonly targetSessionId: string
  readonly message: string
}

export type ToolbarClickAction = "ignore" | "toggle"

export function toolbarClickAction(options: {
  readonly handoffPending: boolean
  readonly sessionExecuting: boolean
}): ToolbarClickAction {
  return options.handoffPending || options.sessionExecuting ? "ignore" : "toggle"
}

export class HandoffRegistry {
  private readonly pending = new Map<string, PendingHandoff>()

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  /**
   * Register a pending handoff for a session. Only one handoff can be pending
   * per session (execute calls are serialized per session). Returns its unique
   * id and an outcome promise.
   */
  wait(options: {
    readonly sessionId: string
    readonly tabId: number
    readonly targetId: string
    readonly targetSessionId: string
    readonly message: string
    readonly timeoutMs: number
  }): HandoffWait {
    const existing = this.pending.get(options.sessionId)
    if (existing) {
      existing.resolve("timeout")
    }
    const id = this.createId()
    const outcome = new Promise<HandoffOutcome>((resolvePromise) => {
      let pending: PendingHandoff
      const timeout = setTimeout(() => {
        if (this.pending.get(options.sessionId) === pending) {
          this.pending.delete(options.sessionId)
        }
        resolvePromise("timeout")
      }, options.timeoutMs)
      pending = {
        id,
        sessionId: options.sessionId,
        tabId: options.tabId,
        targetId: options.targetId,
        targetSessionId: options.targetSessionId,
        message: options.message,
        resolve: (outcome) => {
          clearTimeout(timeout)
          if (this.pending.get(options.sessionId) === pending) {
            this.pending.delete(options.sessionId)
          }
          resolvePromise(outcome)
        },
      }
      this.pending.set(options.sessionId, pending)
    })
    return { id, outcome }
  }

  /** Resolve only the waiter named by its token and exact registry target. */
  complete(options: {
    readonly id: string
    readonly tabId: number
    readonly targetId: string
    readonly targetSessionId: string
  }): boolean {
    const pending = Array.from(this.pending.values()).find((candidate) => candidate.id === options.id)
    if (
      !pending ||
      pending.tabId !== options.tabId ||
      pending.targetId !== options.targetId ||
      pending.targetSessionId !== options.targetSessionId
    ) {
      return false
    }
    pending.resolve("resolved")
    return true
  }

  pendingForSession(sessionId: string): PendingHandoffView | undefined {
    return this.view(this.pending.get(sessionId))
  }

  pendingForTab(tabId: number): PendingHandoffView | undefined {
    return this.view(Array.from(this.pending.values()).find((pending) => pending.tabId === tabId))
  }

  get pendingCount(): number {
    return this.pending.size
  }

  cancelForTarget(options: {
    readonly targetId: string
    readonly targetSessionId: string
    readonly reason: HandoffCancellationReason
  }): readonly PendingHandoffView[] {
    const matching = Array.from(this.pending.values()).filter((pending) => {
      return pending.targetId === options.targetId && pending.targetSessionId === options.targetSessionId
    })
    const cancelled = matching.map((pending) => this.view(pending)).filter((pending) => pending !== undefined)
    for (const pending of matching) {
      pending.resolve({ type: "cancelled", reason: options.reason })
    }
    return cancelled
  }

  /** Cancel every pending handoff, resolving waiters as timeouts. */
  cancelAll(): void {
    for (const pending of Array.from(this.pending.values())) {
      pending.resolve("timeout")
    }
    this.pending.clear()
  }

  private view(pending: PendingHandoff | undefined): PendingHandoffView | undefined {
    if (!pending) {
      return undefined
    }
    return {
      id: pending.id,
      sessionId: pending.sessionId,
      tabId: pending.tabId,
      targetId: pending.targetId,
      targetSessionId: pending.targetSessionId,
      message: pending.message,
    }
  }
}

export function resolveExactHandoffTarget<T extends {
  readonly tabId: number
  readonly sessionId: string
  readonly targetInfo: { readonly targetId: string }
}>(options: {
  readonly targetId: string
  readonly targets: readonly T[]
  readonly isVisible: (target: T) => boolean
}): T {
  const target = options.targets.find((candidate) => candidate.targetInfo.targetId === options.targetId)
  if (!target || !options.isVisible(target)) {
    throw new Error("Could not bind handoff to the selected page; its target detached or is no longer visible")
  }
  return target
}
