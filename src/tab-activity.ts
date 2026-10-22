import { Effect, Semaphore } from "effect"
import type { ConnectedTarget } from "./relay-types.ts"

/** Only client commands count as activity; page events and presentation do not. */
export class TabActivity {
  private readonly lastUsed = new Map<number, number>()
  private readonly focusedBy = new Map<number, Set<string>>()
  private readonly focusLock = Semaphore.makeUnsafe(1)

  constructor(private readonly setFocus: (tabId: number, enabled: boolean) => Effect.Effect<unknown, Error>) {}

  touch(tabId: number, now = Date.now()): void {
    this.lastUsed.set(tabId, now)
  }

  forget(tabId: number): void {
    this.lastUsed.delete(tabId)
    this.focusedBy.delete(tabId)
  }

  isFocused(tabId: number): boolean {
    return this.focusedBy.has(tabId)
  }

  focus(tabId: number, sessionId: string): Effect.Effect<void> {
    return this.focusLock.withPermit(Effect.gen({ self: this }, function* () {
      const owners = this.focusedBy.get(tabId) ?? new Set<string>()
      if (owners.has(sessionId)) return
      if (owners.size === 0) yield* this.setFocus(tabId, true).pipe(Effect.ignore)
      owners.add(sessionId)
      this.focusedBy.set(tabId, owners)
    }))
  }

  finish(sessionId: string): Effect.Effect<void> {
    return this.focusLock.withPermit(Effect.gen({ self: this }, function* () {
      for (const [tabId, owners] of this.focusedBy) {
        if (!owners.delete(sessionId)) continue
        this.touch(tabId)
        if (owners.size > 0) continue
        this.focusedBy.delete(tabId)
        yield* this.setFocus(tabId, false).pipe(Effect.ignore)
      }
    }))
  }

  idleUserTargets(targets: readonly ConnectedTarget[], now: number, maxIdleMs: number): readonly ConnectedTarget[] {
    return targets.filter((target) => target.owner === "user" &&
      !this.focusedBy.has(target.tabId) &&
      now - (this.lastUsed.get(target.tabId) ?? now) >= maxIdleMs)
  }
}
