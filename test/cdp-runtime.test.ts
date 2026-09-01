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
  return { sessionId, method: "Runtime.executionContextCreated", params: { context: { id: 1, auxData: { isDefault } } } }
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
