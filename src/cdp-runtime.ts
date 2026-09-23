import { Deferred, Effect, Fiber } from "effect"
import type { CdpRoutedSession } from "./cdp-router.ts"
import type { CdpEvent, JsonObject } from "./protocol.ts"
import { getObject } from "./relay-helpers.ts"
import { boundedToken, runtimeFailureKind } from "./runtime-diagnostics.ts"
import type { TargetRegistry } from "./target-registry.ts"

type Waiter = { readonly sessionId: string; readonly ready: Deferred.Deferred<boolean>; readonly nativeReady: (event: CdpEvent) => boolean }

type Contexts = Map<number, CdpEvent>
type ContextCache = { readonly current: () => boolean; readonly contexts: Contexts; overflow: boolean }
type Requester = {
  readonly current: () => boolean
  readonly delivered: Map<number, string | undefined>
  frameId?: string
}

type RuntimeReplay = {
  readonly client: object
  readonly send: (event: CdpEvent) => void
}

export class CdpRuntime {
  private readonly waiters = new Set<Waiter>()
  private readonly contexts = new Map<string, ContextCache>()
  private readonly requesters = new WeakMap<object, Map<string, Requester>>()
  private readonly pendingReplays = new Set<() => void>()
  private readonly disabling = new Map<string, number>()

  constructor(private readonly options: {
    readonly registry: TargetRegistry
    readonly generation: () => number
    readonly send: (command: { readonly tabId: number; readonly sessionId?: string; readonly method: string; readonly params: JsonObject }) => Effect.Effect<JsonObject, Error>
    readonly trace?: (message: string) => void
  }) {}

  notify(event: CdpEvent): void {
    if (event.sessionId && (event.method.startsWith("Runtime.executionContext") || event.method === "Page.frameDetached" || event.method === "Page.frameNavigated")) {
      const cache = this.cacheFor(event.sessionId)
      if (event.method === "Runtime.executionContextsCleared") {
        cache?.contexts.clear()
        if (cache) cache.overflow = false
      } else if (event.method === "Page.frameDetached" || event.method === "Page.frameNavigated") {
        const frameId = event.method === "Page.frameDetached" ? event.params?.frameId : getObject(event.params?.frame)?.id
        for (const [id, created] of cache?.contexts ?? []) {
          if (getObject(getObject(created.params?.context)?.auxData)?.frameId === frameId) cache?.contexts.delete(id)
        }
      } else if (event.method === "Runtime.executionContextDestroyed") {
        const id = event.params?.executionContextId
        if (typeof id === "number") cache?.contexts.delete(id)
      } else if (event.method === "Runtime.executionContextCreated" && cache && !cache.overflow) {
        const id = getObject(event.params?.context)?.id
        if (typeof id === "number") cache.contexts.set(id, event)
        if (cache.contexts.size > 512) {
          cache.contexts.clear()
          cache.overflow = true
        }
      }
    }
    if (event.method !== "Runtime.executionContextCreated") return
    const auxData = getObject(getObject(event.params?.context)?.auxData)
    if (auxData?.isDefault !== true) return
    // Replay missing sibling contexts before waking the native waiter: resolving
    // its Deferred can synchronously retire the pending replay callback.
    for (const replay of this.pendingReplays) replay()
    for (const waiter of this.waiters) {
      if (waiter.nativeReady(event) && event.sessionId === waiter.sessionId) Deferred.doneUnsafe(waiter.ready, Effect.succeed(true))
    }
  }

  /** Observe the exact events actually sent to this canonical client. Aliases never enter here. */
  deliver(client: object, event: CdpEvent, send: () => void): void {
    if (event.method === "Target.detachedFromTarget" && typeof event.params?.sessionId === "string") {
      this.detach(client, event.params.sessionId)
    }
    const requester = event.sessionId ? this.requesters.get(client)?.get(event.sessionId) : undefined
    const active = requester?.current() ? requester : undefined
    const context = getObject(event.params?.context)
    const id = context?.id
    if (event.method === "Runtime.executionContextsCleared") active?.delivered.clear()
    if (event.method === "Runtime.executionContextDestroyed" && typeof event.params?.executionContextId === "number") {
      active?.delivered.delete(event.params.executionContextId)
    }
    if (event.method === "Runtime.executionContextCreated" && active?.frameId !== undefined && typeof id === "number") {
      const unique = typeof context?.uniqueId === "string" ? context.uniqueId : undefined
      if (active.delivered.has(id) && active.delivered.get(id) === unique) return
      active.delivered.set(id, unique)
    }
    send()
  }

  /** Construct at request admission; invoke only after its successful response is sent. */
  frameTreeResponse(client: object, route: CdpRoutedSession, canContinue: () => boolean): (frameId: string) => void {
    const requester = this.requester(client, route, canContinue)
    return (frameId) => {
      if (!requester.current()) return
      requester.frameId = frameId
      for (const replay of this.pendingReplays) replay()
    }
  }

  disconnect(client: object): void {
    this.requesters.delete(client)
  }

  detach(client: object, sessionId: string): void {
    this.requesters.get(client)?.delete(sessionId)
  }

  clear(): void {
    this.contexts.clear()
  }

  invalidate(tabId: number, chromeSessionId?: string): void {
    for (const [sessionId] of this.contexts) {
      const target = this.options.registry.targets.get(sessionId) ?? this.options.registry.childTargets.get(sessionId)
      if (target?.tabId === tabId && (chromeSessionId === undefined || sessionId === chromeSessionId)) this.contexts.delete(sessionId)
    }
  }

  beginDisable(tabId: number, chromeSessionId?: string): () => void {
    const key = `${tabId}:${chromeSessionId ?? "root"}`
    this.disabling.set(key, (this.disabling.get(key) ?? 0) + 1)
    this.invalidate(tabId, chromeSessionId)
    return () => {
      this.invalidate(tabId, chromeSessionId)
      const count = (this.disabling.get(key) ?? 1) - 1
      if (count === 0) this.disabling.delete(key)
      else this.disabling.set(key, count)
    }
  }

  private cacheFor(sessionId: string): ContextCache | undefined {
    for (const [key, value] of this.contexts) if (!value.current()) this.contexts.delete(key)
    const root = this.options.registry.targets.get(sessionId)
    const child = this.options.registry.childTargets.get(sessionId)
    const parent = child ? this.options.registry.tabTargets.get(child.tabId) : undefined
    const route = root ? { tabId: root.tabId, rootSessionId: root.sessionId }
      : child && parent ? { tabId: child.tabId, rootSessionId: parent.sessionId, chromeSessionId: child.sessionId } : undefined
    if (!route) return undefined
    if (this.disabling.has(`${route.tabId}:root`) || this.disabling.has(`${route.tabId}:${route.chromeSessionId}`)) return undefined
    let cache = this.contexts.get(sessionId)
    if (!cache?.current()) {
      cache = { current: this.capture(route), contexts: new Map(), overflow: false }
      this.contexts.set(sessionId, cache)
    }
    return cache
  }

  private requester(client: object, route: CdpRoutedSession, canContinue: () => boolean): Requester {
    let sessions = this.requesters.get(client)
    if (!sessions) {
      sessions = new Map()
      this.requesters.set(client, sessions)
    }
    const sessionId = route.chromeSessionId ?? route.rootSessionId
    let requester = sessions.get(sessionId)
    if (!requester?.current()) {
      const captured = this.capture(route)
      requester = { current: () => captured() && canContinue() && this.requesters.get(client) === sessions && sessions?.get(sessionId) === requester, delivered: new Map() }
      sessions.set(sessionId, requester)
    }
    return requester
  }

  readonly enable = Effect.fn("CdpRuntime.enable")(function* (
    this: CdpRuntime,
    route: CdpRoutedSession,
    params: JsonObject,
    canContinue: () => boolean,
    replay?: RuntimeReplay,
  ) {
    const current = this.capture(route)
    const permitted = () => current() && canContinue()
    // Raw CDP clients need not request a frame tree. Preserve their ordinary
    // native-event path; cached replay requires a frame-tree request already admitted.
    const requester = replay ? this.requesters.get(replay.client)?.get(route.chromeSessionId ?? route.rootSessionId) : undefined
    const replayMissing = replay && requester ? () => {
      if (!permitted() || !requester.current() || requester.frameId === undefined) return false
      const sessionId = route.chromeSessionId ?? route.rootSessionId
      const cache = this.contexts.get(sessionId)
      if (!cache?.current() || cache.overflow) return false
      if (![...cache.contexts.values()].some((event) => {
        const aux = getObject(getObject(event.params?.context)?.auxData)
        return aux?.isDefault === true && aux.frameId === requester.frameId
      })) return false
      let seen = false
      for (const event of cache.contexts.values()) {
        if (!permitted() || !requester.current()) return false
        this.deliver(replay.client, event, () => replay.send(event))
        if (getObject(getObject(event.params?.context)?.auxData)?.isDefault === true) seen = true
      }
      if (seen) this.trace(route, "runtime-replay defaultContextSeen=true")
      return seen
    } : undefined
    const first = yield* this.observe(route, Effect.suspend(() => permitted()
      ? this.options.send({
        tabId: route.tabId, method: "Runtime.enable", params,
        ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }),
      })
      : Effect.fail(new Error("CDP target changed before Runtime.enable"))), replayMissing,
      (event) => requester === undefined || (permitted() && requester.current() && requester.frameId !== undefined && getObject(getObject(event.params?.context)?.auxData)?.frameId === requester.frameId))
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

  private observe<A>(route: CdpRoutedSession, command: Effect.Effect<A, Error>, replay?: () => boolean, nativeReady: (event: CdpEvent) => boolean = () => true): Effect.Effect<{ readonly result: A; readonly seen: boolean }, Error> {
    const runtime = this
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const waiter: Waiter = { sessionId: route.chromeSessionId ?? route.rootSessionId, ready: Deferred.makeUnsafe(), nativeReady }
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
        const complete = () => { if (replay?.()) Deferred.doneUnsafe(waiter.ready, Effect.succeed(true)) }
        runtime.pendingReplays.add(complete)
        return yield* Effect.gen(function* () {
          complete()
          return { result, seen: yield* Fiber.join(seen) }
        }).pipe(Effect.ensuring(Effect.sync(() => { runtime.pendingReplays.delete(complete) })))
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
    const owner = root?.browserControlSessionId
    const child = route.chromeSessionId === undefined ? undefined : registry.childTargets.get(route.chromeSessionId)
    return () => {
      const currentRoot = registry.routingRootTarget(route.tabId)
      if (!root || generation !== this.options.generation() || currentRoot?.sessionId !== root.sessionId || currentRoot.targetInfo.targetId !== root.targetInfo.targetId || currentRoot.browserControlSessionId !== owner) return false
      if (route.chromeSessionId === undefined) return true
      const currentChild = registry.childTargets.get(route.chromeSessionId)
      return child !== undefined && currentChild?.tabId === route.tabId && currentChild.targetInfo.targetId === child.targetInfo.targetId && currentChild.parentSessionId === child.parentSessionId
    }
  }

  private trace(route: CdpRoutedSession, message: string): void {
    this.options.trace?.(`${message} tab=${route.tabId} rootSession=${boundedToken(route.rootSessionId)} chromeSession=${boundedToken(route.chromeSessionId)}`)
  }
}
