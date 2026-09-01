import { Effect, Exit, Fiber, Latch } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vitest"
import { RelayLifecycleEvent } from "../src/relay-lifecycle-log.ts"
import { RelayShutdownRequest } from "../src/relay-schema.ts"
import { RelayShutdown } from "../src/relay-shutdown.ts"

const request = RelayShutdownRequest.make({
  instanceId: "relay-test",
  requestId: "restart-test",
  reason: "explicit-restart",
  client: { kind: "cli", instanceId: "client-test", buildId: "build-test" },
})

function fixture(overrides: Partial<ConstructorParameters<typeof RelayShutdown>[0]> = {}) {
  const events: RelayLifecycleEvent[] = []
  const resume = vi.fn()
  const stop = vi.fn()
  const shutdown = new RelayShutdown({
    instanceId: request.instanceId,
    managed: true,
    drain: Effect.void,
    settle: Effect.void,
    quiescent: () => true,
    busy: () => undefined,
    audit: (event) => Effect.sync(() => { events.push(event) }),
    resume,
    stop,
    timeoutMs: 1_000,
    ...overrides,
  })
  return { shutdown, events, resume, stop }
}

describe("RelayShutdown", () => {
  it("retains in-flight transport work after its raw client disconnects", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      const requested = yield* Latch.make()
      let connected = true
      const { shutdown, stop } = fixture({
        busy: () => connected ? "raw-clients" : undefined,
        audit: (event) => event._tag === "Requested" ? requested.open : Effect.void,
      })
      const rpc = yield* Effect.forkChild(shutdown.trackTransport(entered.open.pipe(Effect.andThen(release.await))))
      yield* entered.await
      connected = false
      const restart = yield* Effect.forkChild(shutdown.request(request))
      yield* requested.await
      expect(stop).not.toHaveBeenCalled()
      expect(restart.pollUnsafe()).toBeUndefined()
      yield* release.open
      yield* Fiber.join(rpc)
      yield* Fiber.join(restart)
      expect(stop).toHaveBeenCalledOnce()
    }))
  })

  it("allows accepted sandbox continuation RPCs during drain and waits for them", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const draining = yield* Latch.make()
      const finishSession = yield* Latch.make()
      const rpcEntered = yield* Latch.make()
      const finishRpc = yield* Latch.make()
      const order: string[] = []
      const { shutdown } = fixture({
        drain: draining.open.pipe(Effect.andThen(finishSession.await)),
        stop: () => { order.push("stop") },
      })
      const restart = yield* Effect.forkChild(shutdown.request(request))
      yield* draining.await
      expect(shutdown.accepting).toBe(false)
      const rpc = yield* Effect.forkChild(shutdown.trackTransport(Effect.gen(function* () {
        yield* rpcEntered.open
        yield* finishRpc.await
        order.push("rpc")
      })))
      yield* rpcEntered.await
      yield* finishSession.open
      expect(order).toEqual([])
      yield* finishRpc.open
      yield* Fiber.join(rpc)
      yield* Fiber.join(restart)
      expect(order).toEqual(["rpc", "stop"])
    }))
  })

  it("refuses commit when new work invalidates quiescence during the durable audit", async () => {
    let quiet = true
    const { shutdown, stop, resume } = fixture({
      quiescent: () => quiet,
      audit: (event) => Effect.sync(() => {
        if (event._tag === "Stopping") quiet = false
      }),
    })
    await expect(Effect.runPromise(shutdown.request(request))).rejects.toThrow("changed while preparing restart")
    expect(stop).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
    expect(shutdown.accepting).toBe(true)
  })

  it("gates new work and drains accepted HTTP, sessions, roots, and durable audits before stopping", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const httpStarted = yield* Latch.make()
      const releaseHttp = yield* Latch.make()
      const drainStarted = yield* Latch.make()
      const releaseSessions = yield* Latch.make()
      const settleStarted = yield* Latch.make()
      const releaseRoots = yield* Latch.make()
      const requested = yield* Latch.make()
      const releaseRequested = yield* Latch.make()
      const stopping = yield* Latch.make()
      const releaseStopping = yield* Latch.make()
      const durable: string[] = []
      const { shutdown, stop, resume } = fixture({
        drain: drainStarted.open.pipe(Effect.andThen(releaseSessions.await)),
        settle: settleStarted.open.pipe(Effect.andThen(releaseRoots.await)),
        audit: (event) => Effect.gen(function* () {
          if (event._tag === "Requested") {
            yield* requested.open
            yield* releaseRequested.await
          } else if (event._tag === "Stopping") {
            yield* stopping.open
            yield* releaseStopping.await
          }
          durable.push(event._tag)
        }),
      })
      const accepted = yield* Effect.forkChild(shutdown.track(httpStarted.open.pipe(Effect.andThen(releaseHttp.await))))
      yield* httpStarted.await
      const restart = yield* Effect.forkChild(shutdown.request(request))
      yield* requested.await
      expect(shutdown.accepting).toBe(false)
      const mutation = vi.fn()
      expect(yield* Effect.flip(shutdown.track(Effect.sync(mutation)))).toMatchObject({ reason: "busy" })
      expect(mutation).not.toHaveBeenCalled()
      expect(yield* Effect.flip(shutdown.request({ ...request, requestId: "competing-restart" }))).toMatchObject({ reason: "busy" })
      expect(durable).toEqual([])
      expect(drainStarted.isOpen()).toBe(false)
      expect(stop).not.toHaveBeenCalled()
      yield* releaseRequested.open
      yield* drainStarted.await
      yield* releaseSessions.open
      yield* TestClock.adjust(0)
      expect(settleStarted.isOpen()).toBe(false)
      expect(restart.pollUnsafe()).toBeUndefined()
      expect(stop).not.toHaveBeenCalled()
      yield* releaseHttp.open
      yield* Fiber.join(accepted)
      yield* settleStarted.await
      expect(durable).toEqual(["Requested"])
      expect(stop).not.toHaveBeenCalled()
      yield* releaseRoots.open
      yield* stopping.await
      expect(durable).toEqual(["Requested"])
      expect(stop).not.toHaveBeenCalled()
      yield* releaseStopping.open
      yield* Fiber.join(restart)
      expect(durable).toEqual(["Requested", "Stopping"])
      expect(stop).toHaveBeenCalledOnce()
      expect(resume).not.toHaveBeenCalled()
      expect(shutdown.accepting).toBe(false)
      expect(yield* Effect.flip(shutdown.request(request))).toMatchObject({ reason: "busy" })
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["instance-changed", "not-managed"] as const)("rejects %s before audit or admission changes", async (reason) => {
    const { shutdown, events, resume, stop } = fixture({ managed: reason !== "not-managed" })
    const input = reason === "instance-changed" ? { ...request, instanceId: "old-relay" } : request
    await expect(Effect.runPromise(shutdown.request(input))).rejects.toMatchObject({ reason })
    expect(shutdown.accepting).toBe(true)
    expect(events).toEqual([])
    expect(resume).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it.each(["raw-clients", "recordings"] as const)("refuses %s both before draining and after root settlement", async (busy) => {
    for (const late of [false, true]) {
      let settled = false
      const { shutdown, events, resume, stop } = fixture({
        busy: () => !late || settled ? busy : undefined,
        settle: Effect.sync(() => { settled = true }),
      })
      await expect(Effect.runPromise(shutdown.request(request))).rejects.toMatchObject({ reason: "busy" })
      expect(settled).toBe(late)
      expect(events.map((event) => event._tag)).toEqual(["Requested", "Cancelled"])
      expect(shutdown.accepting).toBe(true)
      expect(resume).toHaveBeenCalledOnce()
      expect(stop).not.toHaveBeenCalled()
    }
  })

  it.each(["success", "failure", "interrupt"] as const)("releases tracked HTTP admission after %s", async (outcome) => {
    await Effect.runPromise(Effect.gen(function* () {
      const { shutdown, stop } = fixture()
      const started = yield* Latch.make()
      const work = outcome === "success" ? Effect.void : outcome === "failure" ? Effect.fail(new Error("request failed")) : Effect.never
      const accepted = yield* Effect.forkChild(shutdown.track(started.open.pipe(Effect.andThen(work))))
      yield* started.await
      if (outcome === "interrupt") yield* Fiber.interrupt(accepted)
      else yield* Fiber.await(accepted)
      yield* shutdown.request(request)
      expect(stop).toHaveBeenCalledOnce()
    }))
  })

  it.each([
    ["timeout", "drain"],
    ["timeout", "settle"],
    ["interrupt", "drain"],
    ["interrupt", "settle"],
  ] as const)("%s during %s resumes admission without interrupting accepted work or stopping later", async (cancel, phase) => {
    await Effect.runPromise(Effect.gen(function* () {
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      const httpStarted = yield* Latch.make()
      const releaseHttp = yield* Latch.make()
      const pending = entered.open.pipe(Effect.andThen(release.await))
      const { shutdown, events, resume, stop } = fixture({ [phase]: pending })
      const accepted = phase === "drain"
        ? yield* Effect.forkChild(shutdown.track(httpStarted.open.pipe(Effect.andThen(releaseHttp.await))))
        : undefined
      if (accepted) yield* httpStarted.await
      const restart = yield* Effect.forkChild(shutdown.request(request))
      yield* entered.await
      if (cancel === "timeout") {
        yield* TestClock.adjust("1 second")
        expect(yield* Effect.flip(Fiber.join(restart))).toMatchObject({ reason: "busy", message: expect.stringContaining("timed out") })
      } else {
        yield* Fiber.interrupt(restart)
        expect(Exit.hasInterrupts(yield* Fiber.await(restart))).toBe(true)
      }
      expect(events.map((event) => event._tag)).toEqual(["Requested", "Cancelled"])
      expect(resume).toHaveBeenCalledOnce()
      expect(shutdown.accepting).toBe(true)
      expect(stop).not.toHaveBeenCalled()
      expect(yield* shutdown.track(Effect.succeed("new request"))).toBe("new request")
      if (accepted) expect(accepted.pollUnsafe()).toBeUndefined()
      yield* release.open
      yield* releaseHttp.open
      if (accepted) yield* Fiber.join(accepted)
      yield* TestClock.adjust("1 minute")
      expect(stop).not.toHaveBeenCalled()
      yield* shutdown.request({ ...request, requestId: "retry-restart" })
      expect(stop).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["Requested", "Stopping"] as const)("propagates %s audit failure without stopping and permits retry", async (phase) => {
    const failure = new Error(`${phase} fsync failed`)
    let fail = true
    const { shutdown, resume, stop } = fixture({
      audit: (event) => event._tag === phase && fail ? Effect.fail(failure) : Effect.void,
    })
    await expect(Effect.runPromise(shutdown.request(request))).rejects.toBe(failure)
    expect(stop).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
    expect(shutdown.accepting).toBe(true)
    fail = false
    await Effect.runPromise(shutdown.request(request))
    expect(stop).toHaveBeenCalledOnce()
  })

  it("reports cancellation audit failure without leaking its cause or replacing the busy error", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { shutdown, resume, stop } = fixture({
        busy: () => "recordings",
        audit: (event) => event._tag === "Cancelled"
          ? Effect.fail(new Error("fsync failed: https://private.example/ Bearer fixture-secret page.title()"))
          : Effect.void,
      })
      await expect(Effect.runPromise(shutdown.request(request))).rejects.toMatchObject({ reason: "busy", message: expect.stringContaining("recordings") })
      expect(diagnostic.mock.calls).toEqual([[`Relay cancellation audit failed for request ${request.requestId}`]])
      expect(shutdown.accepting).toBe(true)
      expect(resume).toHaveBeenCalledOnce()
      expect(stop).not.toHaveBeenCalled()
    } finally {
      diagnostic.mockRestore()
    }
  })

  it.each(["Requested", "Stopping"] as const)("cancellation before the %s audit becomes durable never causes a late stop", async (phase) => {
    await Effect.runPromise(Effect.gen(function* () {
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      const { shutdown, resume, stop } = fixture({
        audit: (event) => event._tag === phase ? entered.open.pipe(Effect.andThen(release.await)) : Effect.void,
      })
      const restart = yield* Effect.forkChild(shutdown.request(request))
      yield* entered.await
      restart.interruptUnsafe()
      yield* release.open
      expect(Exit.hasInterrupts(yield* Fiber.await(restart))).toBe(true)
      expect(stop).not.toHaveBeenCalled()
      expect(resume).toHaveBeenCalledOnce()
      expect(shutdown.accepting).toBe(true)
    }))
  })

  it.each(["drain", "Stopping"] as const)("permanent close during %s cannot resume admission or trigger a late stop", async (phase) => {
    await Effect.runPromise(Effect.gen(function* () {
      const entered = yield* Latch.make()
      const release = yield* Latch.make()
      const pending = entered.open.pipe(Effect.andThen(release.await))
      const { shutdown, stop, resume } = fixture({
        drain: phase === "drain" ? pending : Effect.void,
        audit: (event) => phase === "Stopping" && event._tag === phase ? pending : Effect.void,
      })
      const restart = yield* Effect.forkChild(shutdown.request(request))
      yield* entered.await
      const close = yield* Effect.forkChild(shutdown.close(), { startImmediately: true })
      expect(shutdown.accepting).toBe(false)
      yield* release.open
      yield* Fiber.join(close)
      expect(yield* Effect.flip(Fiber.join(restart))).toMatchObject({ reason: "busy" })
      expect(stop).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
      expect(shutdown.accepting).toBe(false)
      expect(yield* Effect.flip(shutdown.track(Effect.void))).toMatchObject({ reason: "busy" })
    }))
  })
})
