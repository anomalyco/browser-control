import { Deferred, Effect, Fiber } from "effect"
import type { CdpRoutedSession } from "./cdp-router.ts"
import type { CdpEvent, JsonObject } from "./protocol.ts"
import { getObject } from "./relay-helpers.ts"
import { boundedToken, runtimeFailureKind } from "./runtime-diagnostics.ts"
import type { TargetRegistry } from "./target-registry.ts"

type Waiter = { readonly sessionId: string; readonly ready: Deferred.Deferred<boolean> }

export class CdpRuntime {
  private readonly waiters = new Set<Waiter>()

  constructor(private readonly options: {
    readonly registry: TargetRegistry
    readonly generation: () => number
    readonly send: (command: { readonly tabId: number; readonly sessionId?: string; readonly method: string; readonly params: JsonObject }) => Effect.Effect<JsonObject, Error>
    readonly trace?: (message: string) => void
  }) {}

  notify(event: CdpEvent): void {
    if (event.method !== "Runtime.executionContextCreated") return
    const auxData = getObject(getObject(event.params?.context)?.auxData)
    if (auxData?.isDefault !== true) return
    for (const waiter of this.waiters) {
      if (event.sessionId === waiter.sessionId) Deferred.doneUnsafe(waiter.ready, Effect.succeed(true))
    }
  }

  readonly enable = Effect.fn("CdpRuntime.enable")(function* (
    this: CdpRuntime,
    route: CdpRoutedSession,
    params: JsonObject,
    canContinue: () => boolean,
  ) {
    const current = this.capture(route)
    const permitted = () => current() && canContinue()
    const first = yield* this.observe(route, Effect.suspend(() => permitted()
      ? this.options.send({
        tabId: route.tabId, method: "Runtime.enable", params,
        ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }),
      })
      : Effect.fail(new Error("CDP target changed before Runtime.enable"))))
    this.trace(route, `runtime-enable defaultContextSeen=${first.seen}`)
    if (!first.seen && permitted()) {
      // The shared debugger may acknowledge enable without replaying its context.
      // Never run the recovery cycle against a successor generation or new owner.
      const retry = yield* this.observe(route, this.reset(route, "Runtime.disable", {}, permitted).pipe(
        Effect.andThen(() => this.reset(route, "Runtime.enable", params, permitted)),
      ))
      this.trace(route, `runtime-reset phase=missing-default-context defaultContextSeen=${retry.seen}`)
    }
    return first.result
  })

  readonly disableIdle = Effect.fn("CdpRuntime.disableIdle")(function* (this: CdpRuntime, stillIdle: () => boolean) {
    const { registry } = this.options
    const routes: CdpRoutedSession[] = registry.listRootTargets().map((target) => ({ tabId: target.tabId, rootSessionId: target.sessionId }))
    for (const target of registry.childTargets.values()) {
      const root = registry.tabTargets.get(target.tabId)
      if (root) routes.push({ tabId: target.tabId, rootSessionId: root.sessionId, chromeSessionId: target.sessionId })
    }
    const targets = routes.map((route) => ({ route, current: this.capture(route) }))
    for (const { route, current } of targets) {
      if (!stillIdle()) break
      yield* this.reset(route, "Runtime.disable", {}, () => stillIdle() && current())
    }
  })

  private observe<A>(route: CdpRoutedSession, command: Effect.Effect<A, Error>): Effect.Effect<{ readonly result: A; readonly seen: boolean }, Error> {
    const runtime = this
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const waiter: Waiter = { sessionId: route.chromeSessionId ?? route.rootSessionId, ready: Deferred.makeUnsafe() }
        runtime.waiters.add(waiter)
        return waiter
      }),
      (waiter) => Effect.gen(function* () {
        // Start the window before sending: context events may precede the reply.
        const seen = yield* Effect.forkScoped(Deferred.await(waiter.ready).pipe(Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.succeed(false),
        })), { startImmediately: true })
        const result = yield* command
        return { result, seen: yield* Fiber.join(seen) }
      }).pipe(Effect.scoped),
      (waiter) => Effect.sync(() => { runtime.waiters.delete(waiter) }),
    )
  }

  private reset(route: CdpRoutedSession, method: "Runtime.enable" | "Runtime.disable", params: JsonObject, current: () => boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!current()) return Effect.void
      this.trace(route, `runtime-reset command=${method}`)
      return this.options.send({ tabId: route.tabId, method, params, ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }) }).pipe(
        Effect.match({
          onFailure: (error) => this.trace(route, `runtime-reset command=${method} outcome=failed failure=${runtimeFailureKind(error)}`),
          onSuccess: () => this.trace(route, `runtime-reset command=${method} outcome=ok`),
        }),
      )
    })
  }

  private capture(route: CdpRoutedSession): () => boolean {
    const { registry } = this.options
    const generation = this.options.generation()
    const root = registry.targets.get(route.rootSessionId)
    const child = route.chromeSessionId === undefined ? undefined : registry.childTargets.get(route.chromeSessionId)
    return () => {
      const currentRoot = registry.routingRootTarget(route.tabId)
      if (!root || generation !== this.options.generation() || currentRoot?.sessionId !== root.sessionId || currentRoot.targetInfo.targetId !== root.targetInfo.targetId) return false
      if (route.chromeSessionId === undefined) return true
      const currentChild = registry.childTargets.get(route.chromeSessionId)
      return child !== undefined && currentChild?.tabId === route.tabId && currentChild.targetInfo.targetId === child.targetInfo.targetId && currentChild.parentSessionId === child.parentSessionId
    }
  }

  private trace(route: CdpRoutedSession, message: string): void {
    this.options.trace?.(`${message} tab=${route.tabId} rootSession=${boundedToken(route.rootSessionId)} chromeSession=${boundedToken(route.chromeSessionId)}`)
  }
}
