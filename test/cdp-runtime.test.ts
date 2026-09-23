import { Effect, Fiber, Latch } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { CdpClientPool } from "../src/cdp-client-pool.ts"
import { CdpRouter } from "../src/cdp-router.ts"
import { CdpRuntime } from "../src/cdp-runtime.ts"
import type { CdpEvent, JsonObject } from "../src/protocol.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"
import { TargetRegistry } from "../src/target-registry.ts"

type Command = Parameters<ConstructorParameters<typeof CdpRuntime>[0]["send"]>[0]

function root(tabId = 1, sessionId = "root-session", targetId = "root-target"): ConnectedTarget {
  return {
    tabId, sessionId, owner: "user",
    targetInfo: { targetId, type: "page", title: "Runtime fixture", url: "https://example.test/", attached: true, canAccessOpener: false },
  }
}

function context(sessionId: string, isDefault = true): CdpEvent {
  return { sessionId, method: "Runtime.executionContextCreated", params: { context: { id: 1, auxData: { isDefault, frameId: "fixture-frame" } } } }
}

function fixture() {
  const registry = new TargetRegistry()
  const target = root()
  const child: ChildTarget = {
    tabId: target.tabId, sessionId: "child-session", parentSessionId: target.sessionId,
    targetInfo: { ...target.targetInfo, targetId: "child-target", type: "iframe" }, waitingForDebugger: false,
  }
  registry.addRootTarget(target)
  registry.addChildTarget(child)
  const clients = new CdpClientPool<object>(() => {})
  const client = {}
  clients.register(client, "owner")
  const router = new CdpRouter(clients, registry)
  const commands: Command[] = []
  const sent = Latch.makeUnsafe()
  const firstResult: JsonObject = { initial: true }
  const state: {
    generation: number
    intercept: (command: Command) => Effect.Effect<JsonObject, Error> | undefined
  } = { generation: 1, intercept: () => undefined }
  const runtime = new CdpRuntime({
    registry,
    generation: () => state.generation,
    send: (command) => Effect.suspend(() => {
      commands.push(command)
      sent.openUnsafe()
      return state.intercept(command) ?? Effect.succeed(firstResult)
    }),
  })
  const enable = (sessionId = target.sessionId, params: JsonObject = {}) => {
    const route = router.session(client, sessionId)
    if (!route) throw new Error("Fixture route not found")
    return runtime.enable(route, params, () => router.session(client, sessionId) !== undefined)
  }
  return { registry, target, child, clients, client, router, commands, sent, firstResult, state, runtime, enable }
}

describe("CdpRuntime", () => {
  const replayFixture = () => {
    const f = fixture()
    const route = { tabId: f.target.tabId, rootSessionId: f.target.sessionId }
    const events: CdpEvent[] = []
    const permitted = () => f.clients.has(f.client) && f.router.session(f.client, route.rootSessionId) !== undefined
    const response = f.runtime.frameTreeResponse(f.client, route, permitted)
    const frameSent = () => response("fixture-frame")
    const enable = () => f.runtime.enable(route, {}, permitted, { client: f.client, send: (event) => events.push(event) })
    return { ...f, route, events, frameSent, enable }
  }

  it("replays full contexts to a second canonical client without advancing the clock or resetting Runtime", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      const firstClient = {}
      const firstEvents: CdpEvent[] = []
      f.runtime.frameTreeResponse(firstClient, f.route, () => true)("fixture-frame")
      const event: CdpEvent = { sessionId: f.target.sessionId, method: "Runtime.executionContextCreated", params: {
        context: { id: 7, uniqueId: "fixture-unique", name: "", origin: "https://example.test", auxData: { isDefault: true, frameId: "fixture-frame" } },
      } }
      f.runtime.notify(event)
      f.runtime.deliver(firstClient, event, () => firstEvents.push(event))
      f.frameSent()
      expect(yield* f.enable()).toBe(f.firstResult)
      expect(f.events).toEqual([event])
      expect(firstEvents).toEqual([event])
      // Native duplicates after replay must not replace Playwright's existing world.
      f.runtime.deliver(f.client, event, () => f.events.push(event))
      expect(f.events).toEqual([event])
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["cached", "native"])("waits for the outbound frame-tree response before %s replay", async (kind) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      const event = context(f.target.sessionId)
      if (kind === "cached") f.runtime.notify(event)
      else f.state.intercept = () => { f.runtime.notify(event); return undefined }
      const fiber = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(1)
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(f.events).toEqual([])
      f.frameSent()
      expect(yield* Fiber.join(fiber)).toBe(f.firstResult)
      expect(f.events).toEqual([event])
      expect(f.commands).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["destroyed", "cleared", "disable", "disable-in-flight", "replacement", "generation", "ownership", "disconnect", "visibility"])("rejects cached contexts after %s", async (kind) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      f.runtime.notify(context(f.target.sessionId))
      f.frameSent()
      if (kind === "destroyed") f.runtime.notify({ sessionId: f.target.sessionId, method: "Runtime.executionContextDestroyed", params: { executionContextId: 1 } })
      if (kind === "cleared") f.runtime.notify({ sessionId: f.target.sessionId, method: "Runtime.executionContextsCleared" })
      if (kind === "disable" || kind === "disable-in-flight") {
        const done = f.runtime.beginDisable(f.target.tabId)
        if (kind === "disable") done()
        else f.runtime.notify(context(f.target.sessionId))
      }
      if (kind === "replacement") f.registry.addRootTarget(root(1, "successor", "successor-target"))
      if (kind === "generation") f.state.generation++
      if (kind === "ownership") f.registry.reserveTargetOwnership(f.target.targetInfo.targetId, "other")
      if (kind === "disconnect") f.runtime.disconnect(f.client)
      if (kind === "visibility") f.clients.unregister(f.client)
      const fiber = yield* f.enable().pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(6_000)
      yield* Fiber.join(fiber)
      expect(f.events).toEqual([])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("keeps aliases on fallback despite a populated canonical cache", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      f.frameSent()
      f.runtime.notify(context(f.target.sessionId))
      const alias = f.clients.createTargetAlias(f.client, f.target)
      const route = f.router.session(f.client, alias)
      if (!route) throw new Error("Missing alias")
      const fiber = yield* f.runtime.enable(route, {}, () => f.router.session(f.client, alias) !== undefined).pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(3_000)
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.disable", "Runtime.enable"])
      yield* TestClock.adjust(3_000)
      yield* Fiber.join(fiber)
      expect(f.events).toEqual([])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["generation", "ownership", "disconnect", "announcement"])("does not replay through an outstanding frame-tree response after %s changes", async (kind) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      f.runtime.notify(context(f.target.sessionId))
      const fiber = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(1)
      if (kind === "generation") f.state.generation++
      if (kind === "ownership") f.registry.reserveTargetOwnership(f.target.targetInfo.targetId, "other")
      if (kind === "disconnect") { f.runtime.disconnect(f.client); f.clients.unregister(f.client) }
      if (kind === "announcement") {
        f.runtime.deliver(f.client, { method: "Target.detachedFromTarget", params: { sessionId: f.target.sessionId } }, () => {})
        f.clients.unregister(f.client)
      }
      f.frameSent()
      yield* TestClock.adjust(6_000)
      yield* Fiber.join(fiber)
      expect(f.events).toEqual([])
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("does not replay before the original enable ACK, and preserves its error", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      const ack = yield* Latch.make()
      f.runtime.notify(context(f.target.sessionId))
      f.frameSent()
      const failure = new Error("enable denied")
      f.state.intercept = () => ack.await.pipe(Effect.andThen(Effect.fail(failure)))
      const fiber = yield* f.enable().pipe(Effect.flip, Effect.forkChild)
      yield* f.sent.await
      expect(f.events).toEqual([])
      yield* ack.open
      expect(yield* Fiber.join(fiber)).toBe(failure)
      expect(f.events).toEqual([])
      expect(f.commands).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("preserves raw canonical clients that never request a frame tree", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const events: CdpEvent[] = []
      f.state.intercept = () => { f.runtime.notify(context(f.target.sessionId)); return undefined }
      expect(yield* f.runtime.enable({ tabId: 1, rootSessionId: f.target.sessionId }, {}, () => true,
        { client: f.client, send: (event) => events.push(event) })).toBe(f.firstResult)
      expect(events).toEqual([])
      expect(f.commands).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("does not mistake a subframe default context for the frame-tree root", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      f.frameSent()
      const event: CdpEvent = { sessionId: f.target.sessionId, method: "Runtime.executionContextCreated", params: {
        context: { id: 2, auxData: { isDefault: true, frameId: "subframe" } },
      } }
      f.runtime.notify(event)
      const fiber = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(1)
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(f.events).toEqual([])
      f.runtime.notify(context(f.target.sessionId))
      yield* Fiber.join(fiber)
      expect(f.events).toEqual([event, context(f.target.sessionId)])
      expect(f.commands).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("forgets delivered contexts when the canonical session is detached and reattached on the same socket", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      f.runtime.notify(context(f.target.sessionId))
      f.frameSent()
      yield* f.enable()
      f.runtime.detach(f.client, f.target.sessionId)
      f.runtime.frameTreeResponse(f.client, f.route, () => true)("fixture-frame")
      yield* f.enable()
      expect(f.events).toEqual([context(f.target.sessionId), context(f.target.sessionId)])
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["root", "child"])("retires the complete explicitly detached %s requester subtree only for its client", async (kind) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const grandchild: ChildTarget = {
        ...f.child, sessionId: "grandchild-session", parentSessionId: f.child.sessionId,
        targetInfo: { ...f.child.targetInfo, targetId: "grandchild-target" },
      }
      f.registry.addChildTarget(grandchild)
      const targets = [f.target, f.child, grandchild]
      const client: { events: CdpEvent[] } = { events: [] }
      const other: { events: CdpEvent[] } = { events: [] }
      const pool = new CdpClientPool<typeof client>((viewer, event) => f.runtime.deliver(viewer, event, () => viewer.events.push(event)))
      const router = new CdpRouter(pool, f.registry)
      const routeFor = (target: ConnectedTarget | ChildTarget) => ({
        tabId: target.tabId, rootSessionId: f.target.sessionId,
        ...(target === f.target ? {} : { chromeSessionId: target.sessionId }),
      })
      const permitted = (viewer: typeof client, sessionId: string) => () => pool.hasSession(viewer, sessionId) && router.session(viewer, sessionId) !== undefined
      const response = (viewer: typeof client, target: ConnectedTarget | ChildTarget) =>
        f.runtime.frameTreeResponse(viewer, routeFor(target), permitted(viewer, target.sessionId))
      const enable = (viewer: typeof client, target: ConnectedTarget | ChildTarget) =>
        f.runtime.enable(routeFor(target), {}, permitted(viewer, target.sessionId), { client: viewer, send: (event) => viewer.events.push(event) })
      const oldResponses = new Map<string, (frameId: string) => void>()
      for (const viewer of [client, other]) {
        pool.register(viewer)
        for (const target of targets) {
          pool.announce(viewer, target)
          const sent = response(viewer, target)
          if (viewer === client) oldResponses.set(target.sessionId, sent)
          sent("fixture-frame")
          f.runtime.notify(context(target.sessionId))
          yield* enable(viewer, target)
        }
        viewer.events.length = 0
      }
      const detached = kind === "root" ? f.target : f.child
      const retired = kind === "root" ? targets : [f.child, grandchild]
      // Match the relay's explicit Target.detachFromTarget transition.
      for (const sessionId of pool.detach(client, detached.sessionId)) f.runtime.detach(client, sessionId)
      for (const target of retired) pool.announce(client, target)
      client.events.length = 0
      for (const target of retired) {
        const sent = response(client, target)
        oldResponses.get(target.sessionId)?.("fixture-frame")
        const fiber = yield* enable(client, target).pipe(Effect.forkChild)
        yield* TestClock.adjust(1)
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(client.events).toEqual([])
        sent("fixture-frame")
        expect(yield* Fiber.join(fiber)).toBe(f.firstResult)
        expect(client.events).toEqual([context(target.sessionId)])
        client.events.length = 0
      }
      // Existing viewers (and the non-detached parent) retain their dedupe history.
      for (const target of targets) {
        yield* enable(other, target)
        pool.sendToViewers(f.target.sessionId, context(target.sessionId), () => true)
      }
      expect(other.events).toEqual([])
      expect(client.events).toEqual([])
      expect(f.commands.every((command) => command.method === "Runtime.enable")).toBe(true)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("keeps a native context seen before the deadline across a slow ACK", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      const ack = yield* Latch.make()
      f.frameSent()
      f.state.intercept = () => {
        f.runtime.notify(context(f.target.sessionId))
        return ack.await.pipe(Effect.as(f.firstResult))
      }
      const fiber = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(4_000)
      yield* ack.open
      expect(yield* Fiber.join(fiber)).toBe(f.firstResult)
      expect(f.commands).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each([false, true])("replays child contexts only while the captured child remains current (replace=%s)", async (replace) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const route = { tabId: f.target.tabId, rootSessionId: f.target.sessionId, chromeSessionId: f.child.sessionId }
      const events: CdpEvent[] = []
      f.runtime.frameTreeResponse(f.client, route, () => f.router.session(f.client, f.child.sessionId) !== undefined)("fixture-frame")
      const event = context(f.child.sessionId)
      f.runtime.notify(event)
      if (replace) f.registry.addChildTarget({ ...f.child, targetInfo: { ...f.child.targetInfo, targetId: "replacement-child" } })
      const fiber = yield* f.runtime.enable(route, {}, () => f.router.session(f.client, f.child.sessionId) !== undefined,
        { client: f.client, send: (event) => events.push(event) }).pipe(Effect.exit, Effect.forkChild)
      if (replace) yield* TestClock.adjust(6_000)
      yield* Fiber.join(fiber)
      expect(events).toEqual(replace ? [] : [event])
      expect(f.commands[0]).toEqual({ tabId: 1, sessionId: f.child.sessionId, method: "Runtime.enable", params: {} })
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("clears cached contexts across alias-driven native disable and rejects events while disabling", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = replayFixture()
      f.runtime.notify(context(f.target.sessionId))
      f.frameSent()
      const alias = f.clients.createTargetAlias(f.client, f.target)
      const route = f.router.session(f.client, alias)
      if (!route) throw new Error("Missing alias")
      const done = f.runtime.beginDisable(route.tabId, route.chromeSessionId)
      f.runtime.notify(context(f.target.sessionId))
      done()
      const fiber = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(6_000)
      yield* Fiber.join(fiber)
      expect(f.events).toEqual([])
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.disable", "Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["root", "root-alias", "child", "child-alias"])("registers before sending and waits for the ACK on %s", async (kind) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const target = kind.startsWith("child") ? f.child : f.target
      const sessionId = kind.endsWith("alias") ? f.clients.createTargetAlias(f.client, target) : target.sessionId
      const ack = yield* Latch.make()
      const params = { testMarker: "enable" }
      f.state.intercept = () => {
        f.runtime.notify(context(target.sessionId))
        return ack.await.pipe(Effect.as(f.firstResult))
      }
      const enable = yield* f.enable(sessionId, params).pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(4_000)
      expect(enable.pollUnsafe()).toBeUndefined()
      expect(f.commands).toEqual([{
        tabId: 1, method: "Runtime.enable", params,
        ...(kind.startsWith("child") ? { sessionId: f.child.sessionId } : {}),
      }])
      yield* ack.open
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      expect(f.commands).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("ignores unrelated sessions, non-default contexts, and other context events", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const enable = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      f.runtime.notify(context(f.child.sessionId))
      f.runtime.notify(context(f.target.sessionId, false))
      f.runtime.notify({ sessionId: f.target.sessionId, method: "Runtime.executionContextsCleared" })
      f.runtime.notify({ sessionId: f.target.sessionId, method: "Runtime.executionContextCreated", params: { context: { id: 2 } } })
      yield* TestClock.adjust(2_999)
      expect(enable.pollUnsafe()).toBeUndefined()
      expect(f.commands).toHaveLength(1)
      f.runtime.notify(context(f.target.sessionId))
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("starts the first window before a slow ACK, even if a context arrives after its deadline", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const ack = yield* Latch.make()
      f.state.intercept = (command) => {
        if (f.commands.length === 1) return ack.await.pipe(Effect.as(f.firstResult))
        if (command.method === "Runtime.enable") f.runtime.notify(context(f.target.sessionId))
        return Effect.succeed({ recovery: true })
      }
      const enable = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(3_001)
      f.runtime.notify(context(f.target.sessionId))
      expect(f.commands).toHaveLength(1)
      yield* ack.open
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.disable", "Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("runs only one recovery cycle and returns the first result after two empty windows", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const params = { testMarker: "original" }
      f.state.intercept = () => Effect.succeed(f.commands.length === 1 ? f.firstResult : { recovery: true })
      const enable = yield* f.enable(f.target.sessionId, params).pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(2_999)
      expect(f.commands).toHaveLength(1)
      yield* TestClock.adjust(1)
      expect(f.commands).toEqual([
        { tabId: 1, method: "Runtime.enable", params },
        { tabId: 1, method: "Runtime.disable", params: {} },
        { tabId: 1, method: "Runtime.enable", params },
      ])
      yield* TestClock.adjust(2_999)
      expect(enable.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      yield* TestClock.adjust(10_000)
      expect(f.commands).toHaveLength(3)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("starts the recovery window before a slow disable ACK", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const disabling = yield* Latch.make()
      const ack = yield* Latch.make()
      f.state.intercept = (command) => command.method === "Runtime.disable"
        ? disabling.open.pipe(Effect.andThen(ack.await), Effect.as({}))
        : undefined
      const enable = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(3_000)
      yield* disabling.await
      yield* TestClock.adjust(3_001)
      expect(enable.pollUnsafe()).toBeUndefined()
      yield* ack.open
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.disable", "Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["Runtime.disable", "Runtime.enable", "both"])("keeps recovery failure soft for %s", async (failure) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      f.state.intercept = (command) => f.commands.length > 1 && (failure === "both" || command.method === failure)
        ? Effect.fail(new Error("Recovery command failed"))
        : undefined
      const enable = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(6_000)
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      expect(f.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.disable", "Runtime.enable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["same-session", "same-target", "detached", "staged"])("does not recover a retired root: %s", async (change) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const enable = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      if (change === "detached") f.registry.detachRootTargetState(1)
      else if (change === "staged") f.registry.stageRootTarget(root(1, "successor-session", "successor-target"))
      else f.registry.addRootTarget(root(1, change === "same-session" ? f.target.sessionId : "successor-session", change === "same-target" ? f.target.targetInfo.targetId : "successor-target"))
      yield* TestClock.adjust(3_000)
      expect(f.commands).toHaveLength(1)
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["same-session", "same-target", "new-parent"])("skips retry enable when a child changes during disable: %s", async (change) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const disabling = yield* Latch.make()
      const ack = yield* Latch.make()
      f.state.intercept = (command) => command.method === "Runtime.disable"
        ? disabling.open.pipe(Effect.andThen(ack.await), Effect.as({}))
        : undefined
      const enable = yield* f.enable(f.child.sessionId).pipe(Effect.forkChild)
      yield* f.sent.await
      yield* TestClock.adjust(3_000)
      yield* disabling.await
      f.registry.addChildTarget({
        ...f.child,
        sessionId: change === "same-target" ? "successor-child" : f.child.sessionId,
        parentSessionId: change === "new-parent" ? "successor-parent" : f.child.parentSessionId,
        targetInfo: { ...f.child.targetInfo, targetId: change === "same-session" ? "successor-child-target" : f.child.targetInfo.targetId },
      })
      expect(enable.pollUnsafe()).toBeUndefined()
      yield* ack.open
      yield* TestClock.adjust(3_000)
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      expect(f.commands).toEqual([
        { tabId: 1, sessionId: f.child.sessionId, method: "Runtime.enable", params: {} },
        { tabId: 1, sessionId: f.child.sessionId, method: "Runtime.disable", params: {} },
      ])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each([
    { change: "extension", phase: "waiting" },
    { change: "visibility", phase: "waiting" },
    { change: "disconnect", phase: "waiting" },
    { change: "extension", phase: "disabling" },
    { change: "visibility", phase: "disabling" },
    { change: "disconnect", phase: "disabling" },
  ])("skips unsent recovery after $change changes while $phase", async ({ change, phase }) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const disabling = yield* Latch.make()
      const ack = yield* Latch.make()
      f.state.intercept = (command) => command.method === "Runtime.disable"
        ? disabling.open.pipe(Effect.andThen(ack.await), Effect.as({}))
        : undefined
      const enable = yield* f.enable().pipe(Effect.forkChild)
      yield* f.sent.await
      if (phase === "disabling") {
        yield* TestClock.adjust(3_000)
        yield* disabling.await
      }
      if (change === "extension") f.state.generation += 1
      else if (change === "disconnect") f.clients.unregister(f.client)
      else f.registry.reserveTargetOwnership(f.target.targetInfo.targetId, "other-owner")
      yield* ack.open
      yield* TestClock.adjust(3_000)
      expect(yield* Fiber.join(enable)).toBe(f.firstResult)
      expect(f.commands.map((command) => command.method)).toEqual(phase === "waiting" ? ["Runtime.enable"] : ["Runtime.enable", "Runtime.disable"])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["detached", "hidden", "disconnected"])("rejects an initially %s route without sending", async (change) => {
    await Effect.runPromise(Effect.gen(function* () {
      const f = fixture()
      const enable = f.enable()
      if (change === "detached") f.registry.detachRootTargetState(1)
      else if (change === "disconnected") f.clients.unregister(f.client)
      else f.registry.reserveTargetOwnership(f.target.targetInfo.targetId, "other-owner")
      expect((yield* Effect.flip(enable)).message).toBe("CDP target changed before Runtime.enable")
      expect(f.commands).toEqual([])
    }))
  })

  it.each(["failure", "interruption"])("does not recover or reuse earlier context after initial %s", async (outcome) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      const error = new Error("Initial enable failed")
      f.state.intercept = () => outcome === "failure" ? Effect.fail(error) : Effect.never
      const enable = yield* f.enable().pipe(Effect.flip, Effect.forkChild)
      yield* f.sent.await
      if (outcome === "failure") expect(yield* Fiber.join(enable)).toBe(error)
      else yield* Fiber.interrupt(enable)
      f.runtime.notify(context(f.target.sessionId))
      yield* TestClock.adjust(10_000)
      expect(f.commands).toHaveLength(1)
      f.state.intercept = () => undefined
      const next = yield* f.enable().pipe(Effect.forkChild)
      yield* TestClock.adjust(2_999)
      expect(next.pollUnsafe()).toBeUndefined()
      f.runtime.notify(context(f.target.sessionId))
      expect(yield* Fiber.join(next)).toBe(f.firstResult)
      expect(f.commands).toHaveLength(2)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("disables roots before children with the correct Chrome addresses", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const f = fixture()
      f.registry.addRootTarget(root(2, "second-session", "second-target"))
      yield* f.runtime.disableIdle(() => true)
      expect(f.commands).toEqual([
        { tabId: 1, method: "Runtime.disable", params: {} },
        { tabId: 2, method: "Runtime.disable", params: {} },
        { tabId: 1, sessionId: f.child.sessionId, method: "Runtime.disable", params: {} },
      ])
    }))
  })

  it.each(["client", "extension", "later-root", "staged-root"])("lets the first idle command settle but skips stale work after a %s change", async (change) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fixture()
      f.registry.addRootTarget(root(2, "second-session", "second-target"))
      const generation = f.clients.unregister(f.client)
      if (generation === undefined) throw new Error("Expected idle generation")
      const ack = yield* Latch.make()
      f.state.intercept = () => f.commands.length === 1 ? ack.await.pipe(Effect.as({})) : undefined
      const idle = yield* f.runtime.disableIdle(() => f.clients.isCurrentIdleGeneration(generation)).pipe(Effect.forkChild)
      yield* f.sent.await
      if (change === "client") f.clients.register({})
      else if (change === "extension") f.state.generation += 1
      else if (change === "staged-root") f.registry.stageRootTarget(root(2, "successor-session", "successor-target"))
      else f.registry.addRootTarget(root(2, "second-session", "successor-target"))
      expect(idle.pollUnsafe()).toBeUndefined()
      expect(f.commands).toHaveLength(1)
      yield* ack.open
      yield* Fiber.join(idle)
      expect(f.commands).toEqual([
        { tabId: 1, method: "Runtime.disable", params: {} },
        ...(change === "later-root" || change === "staged-root" ? [{ tabId: 1, sessionId: f.child.sessionId, method: "Runtime.disable", params: {} }] : []),
      ])
    })))
  })
})
