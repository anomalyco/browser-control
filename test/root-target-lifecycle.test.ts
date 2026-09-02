import { Effect, Fiber, Latch } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { CdpClientPool } from "../src/cdp-client-pool.ts"
import type { ExtensionCommand, JsonObject, TargetInfo } from "../src/protocol.ts"
import { RootTargetLifecycle } from "../src/root-target-lifecycle.ts"
import type { ConnectedTarget } from "../src/relay-types.ts"
import { TargetRegistry } from "../src/target-registry.ts"

function targetInfo(targetId: string): TargetInfo {
  return { targetId, type: "page", title: targetId, url: "https://example.test/", attached: true, canAccessOpener: false }
}

function root(targetId: string, sessionId = targetId): ConnectedTarget {
  return { tabId: 1, sessionId, targetInfo: targetInfo(targetId), owner: "user" }
}

type Command = Omit<ExtensionCommand, "id">

const fixture = Effect.fnUntraced(function* () {
  const registry = new TargetRegistry()
  const events: string[] = []
  const errors: unknown[] = []
  const commands: string[] = []
  const client = {}
  const clients = new CdpClientPool<object>((_client, event) => {
    if (event.method === "Target.detachedFromTarget") events.push(`detach:${event.params?.sessionId}`)
    if (event.method === "Target.attachedToTarget") events.push(`attach:${event.params?.sessionId}`)
  })
  clients.register(client)
  const state: {
    generation: number
    targetId: string
    durableTargetId: string
    restoredOwner: { readonly sessionId: string; readonly owner: "relay" | "user" } | undefined
    intercept: (command: Command) => Effect.Effect<JsonObject, Error> | undefined
  } = {
    generation: 1,
    targetId: "root-new",
    durableTargetId: "root-old",
    restoredOwner: undefined,
    intercept: (_command: Command): Effect.Effect<JsonObject, Error> | undefined => undefined,
  }
  const lifecycle = yield* RootTargetLifecycle.make({
    registry,
    clients,
    sessions: {
      persistedTargetOwner: () => state.restoredOwner,
      markTargetReplaced: (previous, next) => {
        expect(previous).toBe(state.durableTargetId)
        state.durableTargetId = next
        events.push("durable")
        return []
      },
    },
    handoffs: {
      rebindTarget: (change) => {
        expect(change.previousTargetId).toBe("root-old")
        expect(change.targetSessionId).toBe(registry.tabTargets.get(1)?.sessionId)
        events.push("handoff")
        return true
      },
    },
    extension: {
      generation: () => state.generation,
      send: (command) => Effect.suspend(() => {
        commands.push(command.method === "debugger.sendCommand" ? String(command.params?.method) : command.method)
        return state.intercept(command) ?? Effect.succeed(command.params?.method === "Target.getTargetInfo" ? { targetInfo: targetInfo(state.targetId) } : {})
      }),
    },
    presentation: {
      replaced: () => { events.push("replaced") },
      committed: () => { events.push("committed") },
      announceRoot: (target) => clients.announce(client, target),
      announceChild: (_rootSessionId, target) => clients.announce(client, target),
    },
    reportError: (_message, error) => { errors.push(error) },
  })
  const queue = (verificationRetries = 0) => lifecycle.queue({ tabId: 1, attachIfMissing: true, verificationRetries, errorMessage: "Reconcile failed" })
  return { lifecycle, registry, events, errors, commands, client, clients, state, queue }
})

describe("root target lifecycle", () => {
  it.each([
    ["Page.enable", 1],
    ["Target.getTargetInfo", 1],
    ["Target.setAutoAttach", 1],
    ["Target.getTargetInfo", 2],
    ["action.setAttached", 1],
  ] as const)("a stale %s response (%s) cannot change or detach a successor", async (method, occurrence) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      let seen = 0
      f.state.intercept = (command) => {
        if ((command.params?.method ?? command.method) !== method || ++seen !== occurrence) return
        return entered.open.pipe(Effect.andThen(release.await), Effect.as({ targetInfo: targetInfo("root-new") }))
      }
      f.queue()
      yield* entered.await
      const commandCount = f.commands.length
      f.state.generation = 2
      f.registry.clear()
      const successor = root("successor")
      f.registry.addRootTarget(successor)
      yield* release.open
      expect(yield* f.lifecycle.settle(1)).toBe(false)
      expect(yield* f.lifecycle.settle(2)).toBe(true)
      expect(f.registry.tabTargets.get(1)).toBe(successor)
      expect(f.commands).toHaveLength(commandCount)
      expect(f.events.filter((event) => event.startsWith("detach:"))).toEqual([])
      expect(f.errors).toHaveLength(1)
    })))
  })

  it("serializes a fresh extension generation behind stale setup, without losing its queued attach", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      f.state.intercept = (command) => command.params?.method === "Page.enable" && f.state.generation === 1
        ? entered.open.pipe(Effect.andThen(release.await), Effect.as({}))
        : undefined
      f.queue()
      yield* entered.await
      f.state.generation = 2
      f.queue()
      expect(f.commands).toEqual(["Page.enable"])
      yield* release.open
      expect(yield* f.lifecycle.settle(2)).toBe(true)
      expect(f.registry.tabTargets.get(1)?.targetInfo.targetId).toBe("root-new")
      expect(f.events.filter((event) => event.startsWith("attach:"))).toHaveLength(1)
    })))
  })

  it("checks target identity as well as the root CDP session after an asynchronous probe", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      f.registry.addRootTarget(root("root-old", "same-session"))
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      f.state.intercept = (command) => command.params?.method === "Target.getTargetInfo"
        ? entered.open.pipe(Effect.andThen(release.await), Effect.as({ targetInfo: targetInfo("root-new") }))
        : undefined
      const reconcile = yield* f.lifecycle.reconcile(1).pipe(Effect.flip, Effect.forkChild)
      yield* entered.await
      const successor = root("successor", "same-session")
      f.registry.addRootTarget(successor)
      yield* release.open
      expect((yield* Fiber.join(reconcile)).message).toContain("generation changed")
      expect(f.registry.tabTargets.get(1)?.targetInfo.targetId).toBe("successor")
      expect(f.events).toEqual([])
      expect(f.commands).toEqual(["Target.getTargetInfo"])
    })))
  })

  it("invalidates an unstaged attach on detach instead of retrying it back into existence", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      f.state.intercept = (command) => command.params?.method === "Page.enable"
        ? entered.open.pipe(Effect.andThen(release.await), Effect.andThen(Effect.fail(new Error("Debugger detached"))))
        : undefined
      f.queue()
      yield* entered.await
      f.lifecycle.invalidate(1)
      f.registry.detachRootTargetState(1)
      yield* release.open
      yield* f.lifecycle.settle(1)
      expect(f.registry.routingRootTarget(1)).toBeUndefined()
      expect(f.commands).toEqual(["Page.enable"])
    })))
  })

  it("invalidates retry backoff without consuming a fresh re-announce for the same tab", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const failed = yield* Latch.make()
      let enables = 0
      f.state.intercept = (command) => command.params?.method === "Page.enable" && ++enables === 1
        ? failed.open.pipe(Effect.andThen(Effect.fail(new Error("Transient enable failure"))))
        : undefined
      f.queue()
      yield* failed.await
      yield* TestClock.adjust(1)
      f.lifecycle.invalidate(1)
      f.queue()
      yield* TestClock.adjust(300)
      expect(yield* f.lifecycle.settle(1)).toBe(true)
      expect(enables).toBe(2)
      expect(f.registry.tabTargets.get(1)?.targetInfo.targetId).toBe("root-new")
      expect(f.events.filter((event) => event.startsWith("attach:"))).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["committed", "provisional"] as const)("retries a staged tree and orders replacement while preserving %s ownership", async (ownership) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const old = { ...root("root-old"), ...(ownership === "committed" ? { browserControlSessionId: "owner" } : {}) }
      f.registry.addRootTarget(old)
      if (ownership === "provisional") f.registry.reserveTargetOwnership("root-old", "owner")
      f.clients.announce(f.client, old)
      const alias = f.clients.createTargetAlias(f.client, old)
      const oldChild = { tabId: 1, sessionId: "old-child", parentSessionId: old.sessionId, targetInfo: { ...targetInfo("child"), type: "iframe" as const }, waitingForDebugger: false }
      const oldGrandchild = { ...oldChild, sessionId: "old-grandchild", parentSessionId: oldChild.sessionId, targetInfo: { ...oldChild.targetInfo, targetId: "grandchild" } }
      for (const child of [oldChild, oldGrandchild]) {
        f.registry.addChildTarget(child)
        f.clients.announce(f.client, child)
      }
      f.events.length = 0
      const failed = yield* Latch.make()
      let autoAttaches = 0
      let stagedSessionId: string | undefined
      f.state.intercept = (command) => {
        if (command.params?.method !== "Target.setAutoAttach") return
        autoAttaches += 1
        const staged = f.registry.stagedRootTarget(1)
        if (!staged) throw new Error("Auto-attach ran before staging")
        expect(f.registry.routingRootTarget(1)).toBe(staged)
        expect(f.registry.tabTargets.get(1)?.sessionId).toBe(old.sessionId)
        if (autoAttaches === 1) {
          stagedSessionId = staged.sessionId
          f.registry.addChildTarget({ ...oldChild, sessionId: "new-child", parentSessionId: staged.sessionId })
          f.registry.addChildTarget({ ...oldGrandchild, sessionId: "new-grandchild", parentSessionId: "new-child" })
          f.registry.rememberFrameEvent({ tabId: 1, frameId: "child", navigated: { frame: { id: "child" } } })
          return failed.open.pipe(Effect.andThen(Effect.fail(new Error("Transient setup failure"))))
        }
        expect(staged.sessionId).toBe(stagedSessionId)
        return Effect.succeed({})
      }
      f.queue()
      yield* failed.await
      expect(f.events).toEqual([])
      yield* TestClock.adjust(100)
      expect(yield* f.lifecycle.settle(1)).toBe(true)
      const committed = f.registry.tabTargets.get(1)
      expect(committed?.sessionId).toBe(stagedSessionId)
      expect(committed?.browserControlSessionId).toBe(ownership === "committed" ? "owner" : undefined)
      expect(f.registry.childTargets.has("new-child")).toBe(true)
      expect(f.registry.childTargets.has("new-grandchild")).toBe(true)
      expect(f.registry.tabFrameEvents.get(1)?.has("child")).toBe(true)
      expect(f.clients.alias(f.client, alias)).toBeUndefined()
      expect(f.events).toEqual([
        "handoff", "durable", "detach:old-grandchild", "detach:old-child", "detach:root-old",
        "replaced", "committed", `attach:${stagedSessionId}`, "attach:new-child",
      ])
      expect(autoAttaches).toBe(2)
      expect(f.errors).toHaveLength(1)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("coalesces re-announcements and retains the longest bounded verification sequence", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      f.registry.addRootTarget(root("root-new"))
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      let probes = 0
      f.state.intercept = (command) => {
        if (command.params?.method !== "Target.getTargetInfo" || ++probes !== 1) return
        return entered.open.pipe(Effect.andThen(release.await), Effect.as({ targetInfo: targetInfo("root-new") }))
      }
      f.queue()
      yield* entered.await
      f.queue(3)
      f.queue(1)
      yield* release.open
      yield* TestClock.adjust(300)
      expect(yield* f.lifecycle.settle(1)).toBe(true)
      expect(probes).toBe(4)
      expect(f.events).toEqual([])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["setup", "probe"] as const)("retains exhausted %s failure for ready without publishing a half-prepared root", async (failure) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const failed = yield* Latch.make()
      f.state.intercept = (command) => {
        if (command.params?.method === "Target.setAutoAttach") return failed.open.pipe(Effect.andThen(Effect.fail(new Error("Setup unavailable"))))
        if (failure === "probe" && f.registry.stagedRootTarget(1) && command.params?.method === "Target.getTargetInfo") return Effect.fail(new Error("Probe unavailable"))
        return undefined
      }
      f.queue()
      yield* failed.await
      yield* TestClock.adjust(400)
      yield* f.lifecycle.settle()
      expect(yield* f.lifecycle.settle(1)).toBe(false)
      expect(f.errors).toHaveLength(3)
      expect(f.registry.tabTargets.has(1)).toBe(false)
      expect(f.events).toEqual([])
      f.state.intercept = () => undefined
      f.queue()
      expect(yield* f.lifecycle.settle(1)).toBe(true)
      expect(f.registry.tabTargets.has(1)).toBe(true)
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each([
    ["committed", "rpc"],
    ["committed", "malformed"],
    ["staged", "malformed"],
  ] as const)("retains exhausted %s root %s probe failure until a successful queue", async (state, failure) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const target = root("root-new")
      if (state === "committed") f.registry.addRootTarget(target)
      else f.registry.stageRootTarget(target)
      const failed = yield* Latch.make()
      const error = new Error("Debugger is not attached to the tab with id: 1")
      f.state.intercept = (command) => command.params?.method === "Target.getTargetInfo"
        ? failed.open.pipe(Effect.andThen(failure === "rpc"
          ? Effect.fail(error)
          : Effect.succeed({ targetInfo: { targetId: 123 } })))
        : undefined
      f.lifecycle.queue({ tabId: 1, attachIfMissing: false, verificationRetries: 3, errorMessage: "Reconcile failed" })
      yield* failed.await
      yield* TestClock.adjust(1_000)
      expect(yield* f.lifecycle.settle(1)).toBe(false)
      expect(f.commands).toEqual(Array(failure === "rpc" ? 6 : 3).fill("Target.getTargetInfo"))
      expect(f.errors).toHaveLength(3)
      for (const reported of f.errors) {
        if (failure === "rpc") expect(reported).toBe(error)
        else expect(reported).toMatchObject({ message: `Unable to verify ${state} root target` })
      }
      expect(f.events).toEqual([])
      expect(f.registry.routingRootTarget(1)?.targetInfo.targetId).toBe("root-new")

      f.state.intercept = () => undefined
      f.queue()
      expect(yield* f.lifecycle.settle(1)).toBe(true)
      expect(f.registry.tabTargets.get(1)?.targetInfo.targetId).toBe("root-new")
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it("retries a committed root probe after the inner retry is exhausted", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      const target = root("root-new")
      f.registry.addRootTarget(target)
      const failed = yield* Latch.make()
      const error = new Error("Transient target probe failure")
      let probes = 0
      f.state.intercept = (command) => command.params?.method === "Target.getTargetInfo" && ++probes <= 2
        ? failed.open.pipe(Effect.andThen(Effect.fail(error)))
        : undefined
      f.queue()
      yield* failed.await
      yield* TestClock.adjust(300)
      expect(yield* f.lifecycle.settle(1)).toBe(true)
      expect(probes).toBe(3)
      expect(f.errors).toEqual([error])
      expect(f.registry.tabTargets.get(1)).toBe(target)
      expect(f.events).toEqual([])
    })).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["attach", "queue"] as const)("drains accepted %s work before close, even after an interrupted settle", async (operation) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* fixture()
      expect(f.lifecycle.isIdle()).toBe(true)
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      f.state.restoredOwner = { sessionId: "restored", owner: "relay" }
      f.state.intercept = (command) => command.params?.method === "Target.setAutoAttach"
        ? entered.open.pipe(Effect.andThen(release.await), Effect.as({}))
        : undefined
      const attach = operation === "attach"
        ? yield* f.lifecycle.attach({ tabId: 1, owner: "user", alreadyAttached: true }).pipe(Effect.forkChild)
        : undefined
      if (operation === "queue") f.queue()
      yield* entered.await
      expect(f.lifecycle.isIdle()).toBe(false)
      const settle = yield* f.lifecycle.settle().pipe(Effect.forkChild({ startImmediately: true }))
      expect(settle.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(settle)
      const close = yield* f.lifecycle.close().pipe(Effect.forkChild({ startImmediately: true }))
      expect(close.pollUnsafe()).toBeUndefined()
      expect((yield* f.lifecycle.attach({ tabId: 2, owner: "user" }).pipe(Effect.flip)).message).toBe("Relay is closing")
      f.queue()
      yield* release.open
      yield* Fiber.join(close)
      expect(f.lifecycle.isIdle()).toBe(true)
      if (attach) yield* Fiber.join(attach)
      expect(f.registry.tabTargets.get(1)).toMatchObject({ owner: "relay", browserControlSessionId: "restored" })
      expect(f.commands.at(-1)).toBe("action.setAttached")
      expect(f.events.filter((event) => event.startsWith("attach:"))).toHaveLength(1)
    })))
  })
})
