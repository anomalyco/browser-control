/**
 * Human-in-the-loop handoff registry.
 *
 * A running execute script can call `await handoff("Complete the 2FA prompt")`.
 * The sandbox registers a pending handoff for its Browser Control session and
 * blocks until the user clicks the Browser Control toolbar button on an
 * attached tab (the relay routes that click here instead of toggling
 * attachment), or until the timeout elapses.
 */

export type HandoffOutcome = "resolved" | "timeout"

type PendingHandoff = {
  readonly sessionId: string
  readonly message: string
  readonly resolve: (outcome: HandoffOutcome) => void
}

export class HandoffRegistry {
  private readonly pending = new Map<string, PendingHandoff>()

  /**
   * Register a pending handoff for a session. Only one handoff can be pending
   * per session (execute calls are serialized per session). Returns a promise
   * resolving to the outcome plus a cancel function that unregisters the
   * waiter without resolving the user's click.
   */
  wait(options: { readonly sessionId: string; readonly message: string; readonly timeoutMs: number }): Promise<HandoffOutcome> {
    const existing = this.pending.get(options.sessionId)
    if (existing) {
      existing.resolve("timeout")
      this.pending.delete(options.sessionId)
    }
    return new Promise<HandoffOutcome>((resolvePromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(options.sessionId)
        resolvePromise("timeout")
      }, options.timeoutMs)
      this.pending.set(options.sessionId, {
        sessionId: options.sessionId,
        message: options.message,
        resolve: (outcome) => {
          clearTimeout(timeout)
          this.pending.delete(options.sessionId)
          resolvePromise(outcome)
        },
      })
    })
  }

  /** Resolve the pending handoff for a specific session. */
  resolveForSession(sessionId: string): boolean {
    const pending = this.pending.get(sessionId)
    if (!pending) {
      return false
    }
    pending.resolve("resolved")
    return true
  }

  /**
   * Resolve the only pending handoff, if exactly one exists. Used when the
   * user clicks the toolbar on an attached tab that is not mapped to a
   * Browser Control session (for example a user-attached tab driven via
   * --target-url).
   */
  resolveIfSingle(): boolean {
    if (this.pending.size !== 1) {
      return false
    }
    const pending = this.pending.values().next().value
    if (!pending) {
      return false
    }
    pending.resolve("resolved")
    return true
  }

  pendingMessage(sessionId: string): string | undefined {
    return this.pending.get(sessionId)?.message
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Cancel every pending handoff, resolving waiters as timeouts. */
  cancelAll(): void {
    for (const pending of Array.from(this.pending.values())) {
      pending.resolve("timeout")
    }
    this.pending.clear()
  }
}
