import { describe, expect, it, vi } from "vitest"
import { Deferred, Effect, Fiber } from "effect"
import { adoptionTipForUrl, BrowserControlSessions, shouldAppendAdoptionTip } from "../src/session-manager.ts"
import type { ExecuteSandboxLike } from "../src/relay-types.ts"
import { TargetRegistry } from "../src/target-registry.ts"

type FakeSandbox = ExecuteSandboxLike & {
  readonly closes: () => number
  readonly adoptedSelections: () => unknown[]
  readonly crashedTargets: () => string[]
  readonly detachedTargets: () => string[]
}

const makeFakeSandbox = (options?: {
  readonly onExecute?: Effect.Effect<void>
  readonly setupFailure?: Error
  readonly adoptFailure?: Error
  readonly onAdopt?: ExecuteSandboxLike["adoptPage"]
  readonly onClose?: Effect.Effect<void>
  readonly defaultTargetId?: string
}): FakeSandbox => {
  let closes = 0
  const adoptedSelections: unknown[] = []
  const crashedTargets: string[] = []
  const detachedTargets: string[] = []
  const close = () => Effect.sync(() => {
    closes += 1
  }).pipe(Effect.andThen(options?.onClose ?? Effect.void))
  return {
    execute: () =>
      (options?.onExecute ?? Effect.void).pipe(
        Effect.as(options?.setupFailure
          ? {
              text: options.setupFailure.message,
              isError: true as const,
              logs: [],
              logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 },
              warnings: [],
              setupFailed: true as const,
            }
          : {
              text: "ok",
              isError: false as const,
              logs: [],
              logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 },
              warnings: [],
            }),
      ),
    close,
    closeSettled: close,
    adoptPage: (selection) => options?.onAdopt
      ? options.onAdopt(selection)
      : options?.adoptFailure
      ? Effect.fail(options.adoptFailure)
      : Effect.sync(() => {
          adoptedSelections.push(selection)
          return "https://example.com/adopted"
        }),
    markTargetCrashed: (targetId) => {
      crashedTargets.push(targetId)
      return options?.defaultTargetId === undefined || options.defaultTargetId === targetId
    },
    markTargetDetached: (targetId) => {
      detachedTargets.push(targetId)
      return options?.defaultTargetId === undefined || options.defaultTargetId === targetId
    },
    getStatus: () => ({ connected: false, pageUrl: null, stateKeys: [] }),
    closes: () => closes,
    adoptedSelections: () => adoptedSelections,
    crashedTargets: () => crashedTargets,
    detachedTargets: () => detachedTargets,
  }
}

describe("BrowserControlSessions", () => {
  it("creates a readable session id inside the first execute request", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())

    const result = await Effect.runPromise(sessions.execute({ code: "noop", createIfMissing: true }))

    expect(result.session.id).toMatch(/^[a-z]+-[a-z]+-\d{3}$/)
    expect(result.session.created).toBe(true)
    expect(sessions.listSummaries().map((session) => session.id)).toEqual([result.session.id])
  })

  it("requires createIfMissing when execute omits the session id", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())

    const error = await Effect.runPromise(sessions.execute({ code: "noop", createIfMissing: false }).pipe(Effect.flip))

    expect(error.message).toBe("sessionId is required when createIfMissing is false")
    expect(sessions.listSummaries()).toEqual([])
  })

  it("removes an implicitly created session when page acquisition fails", async () => {
    const sandbox = makeFakeSandbox({ setupFailure: new Error("extension disconnected") })
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)

    const error = await Effect.runPromise(sessions.execute({ code: "noop", createIfMissing: true }).pipe(Effect.flip))

    expect(error.message).toBe("extension disconnected")
    expect(sessions.listSummaries()).toEqual([])
    expect(sandbox.closes()).toBe(1)
  })

  it("keeps an implicitly created session after a user-code failure", async () => {
    const sandbox = makeFakeSandbox()
    sandbox.execute = () => Effect.succeed({
      text: "SyntaxError: Unexpected token",
      isError: true,
      logs: [],
      logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 },
      warnings: [],
    })
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)

    const result = await Effect.runPromise(sessions.execute({ code: "const = ]", createIfMissing: true }))

    expect(result.result.isError).toBe(true)
    expect(result.session.created).toBe(true)
    expect(sessions.listSummaries().map((session) => session.id)).toEqual([result.session.id])
    expect(sandbox.closes()).toBe(0)
  })

  it("creates, lists, and deletes sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = makeFakeSandbox()
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
        sessions.createNew("alpha")
        expect(sessions.listSummaries().map((session) => session.id)).toEqual(["alpha"])
        expect(yield* sessions.delete("alpha")).toBe(true)
        expect(sandbox.closes()).toBe(1)
        expect(yield* sessions.delete("alpha")).toBe(false)
      }),
    )
  })

  it("rejects duplicate explicit session ids", () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    sessions.createNew("alpha")
    expect(() => sessions.createNew("alpha")).toThrow("Session already exists")
  })

  it("marks only the session page backed by a detached root target", () => {
    const first = makeFakeSandbox({ defaultTargetId: "target-1" })
    const second = makeFakeSandbox({ defaultTargetId: "target-2" })
    const sandboxes = [first, second]
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandboxes.shift()!)
    sessions.createNew("alpha")
    sessions.createNew("beta")

    expect(sessions.markTargetDetached("target-1")).toEqual(["alpha"])
    expect(first.detachedTargets()).toEqual(["target-1"])
    expect(second.detachedTargets()).toEqual(["target-1"])
  })

  it("delete waits for a running execute before closing the sandbox", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sandbox = makeFakeSandbox({
          onExecute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        })
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
        sessions.createNew("alpha")

        const executeFiber = yield* Effect.forkChild(
          sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }),
        )
        yield* Deferred.await(started)

        const deleteFiber = yield* Effect.forkChild(sessions.delete("alpha"))
        // Give the delete fiber plenty of chances to (incorrectly) run ahead.
        for (let i = 0; i < 20; i++) {
          yield* Effect.yieldNow
        }
        expect(sandbox.closes()).toBe(0)

        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(executeFiber)
        expect(result.result.text).toBe("ok")
        expect(yield* Fiber.join(deleteFiber)).toBe(true)
        expect(sandbox.closes()).toBe(1)
      }),
    )
  })

  it("closeAll waits for a running execute before closing the sandbox", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sandbox = makeFakeSandbox({
          onExecute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        })
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
        sessions.createNew("alpha")

        const executeFiber = yield* Effect.forkChild(
          sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }),
        )
        yield* Deferred.await(started)
        const closeFiber = yield* Effect.forkChild(sessions.closeAll())
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        expect(sandbox.closes()).toBe(0)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(executeFiber)
        yield* Fiber.join(closeFiber)
        expect(sandbox.closes()).toBe(1)
        expect(sessions.listSummaries()).toEqual([])
      }),
    )
  })

  it("closeAll preserves a session when its execute permit times out", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const never = yield* Deferred.make<void>()
        const sandbox = makeFakeSandbox({
          onExecute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(never)),
          ),
        })
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
          lifecycleTimeoutMs: 20,
        })
        sessions.createNew("alpha")
        yield* Effect.forkChild(
          sessions.execute({ sessionId: "alpha", code: "wedged", createIfMissing: false }),
        )
        yield* Deferred.await(started)

        yield* sessions.closeAll()

        expect(sandbox.closes()).toBe(0)
        expect(sessions.listSummaries().map((session) => session.id)).toEqual(["alpha"])
      }),
    )
  })

  it("closeAll drains a timed-out adoption worker before closing sessions", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sandboxes: FakeSandbox[] = []
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => {
        const sandbox = makeFakeSandbox(sandboxes.length === 0
          ? {
              onAdopt: () => Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("https://example.com/adopted"),
              ),
            }
          : undefined)
        sandboxes.push(sandbox)
        return sandbox
      }, { lifecycleTimeoutMs: 20 })
      sessions.createNew("alpha")

      const adoption = yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-1",
        targetUrl: "https://example.com/adopted",
      }).pipe(Effect.flip))
      yield* Deferred.await(started)
      expect((yield* Fiber.join(adoption)).message).toContain("timed out")

      const closeFiber = yield* Effect.forkChild(sessions.closeAll())
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(sandboxes[0]?.closes()).toBe(0)
      expect(sessions.listSummaries().map((session) => session.id)).toEqual(["alpha"])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closeFiber)
      expect(sandboxes[0]?.closes()).toBe(1)
      expect(sandboxes[1]?.closes()).toBe(1)
      expect(sessions.listSummaries()).toEqual([])
    }))
  })

  it("closeAll keeps the adoption gate through worker failure cleanup", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>()
      const releaseClose = yield* Deferred.make<void>()
      const sandbox = makeFakeSandbox({
        adoptFailure: new Error("target detached"),
        onClose: Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseClose))),
      })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)

      const adoption = yield* Effect.forkChild(sessions.adopt({
        createIfMissing: true,
        targetId: "target-1",
        targetUrl: "https://example.com/adopted",
      }).pipe(Effect.result))
      yield* Deferred.await(closeStarted)

      const closeFiber = yield* Effect.forkChild(sessions.closeAll())
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(sandbox.closes()).toBe(1)

      yield* Deferred.succeed(releaseClose, undefined)
      expect((yield* Fiber.join(adoption))._tag).toBe("Failure")
      yield* Fiber.join(closeFiber)
      expect(sandbox.closes()).toBe(1)
      expect(sessions.listSummaries()).toEqual([])
    }))
  })

  it("failed adoption cleanup retains the session permit until settled close finishes", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>()
      const releaseClose = yield* Deferred.make<void>()
      let executed = false
      const sandbox = makeFakeSandbox({
        adoptFailure: new Error("target detached"),
        onClose: Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseClose))),
        onExecute: Effect.sync(() => {
          executed = true
        }),
      })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, { lifecycleTimeoutMs: 5_000 })

      const adoption = yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: true,
        targetId: "target-1",
        targetUrl: "https://example.com/adopted",
      }).pipe(Effect.result))
      yield* Deferred.await(closeStarted)
      const execute = yield* Effect.forkChild(sessions.execute({
        sessionId: "alpha",
        code: "noop",
        createIfMissing: false,
      }).pipe(Effect.result))
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(executed).toBe(false)

      yield* Deferred.succeed(releaseClose, undefined)
      expect((yield* Fiber.join(adoption))._tag).toBe("Failure")
      expect((yield* Fiber.join(execute))._tag).toBe("Failure")
      expect(executed).toBe(false)
      expect(sessions.listSummaries()).toEqual([])
    }))
  })

  it("closeAll drains an adoption worker accepted immediately before shutdown", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id) => makeFakeSandbox({
        onAdopt: () => (id === "alpha" ? Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as("https://example.com/alpha"),
        ) : Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSecond)),
          Effect.as("https://example.com/beta"),
        )),
      }), { lifecycleTimeoutMs: 5_000 })
      sessions.createNew("alpha")
      sessions.createNew("beta")

      const first = yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-alpha",
        targetUrl: "https://example.com/alpha",
      }), { startImmediately: true })
      yield* Deferred.await(firstStarted)
      const second = yield* Effect.forkChild(sessions.adopt({
        sessionId: "beta",
        createIfMissing: false,
        targetId: "target-beta",
        targetUrl: "https://example.com/beta",
      }), { startImmediately: true })
      const closeFiber = yield* Effect.forkChild(sessions.closeAll(), { startImmediately: true })

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Deferred.await(secondStarted)
      expect(sessions.listSummaries().map((session) => session.id).sort()).toEqual(["alpha", "beta"])
      yield* Deferred.succeed(releaseSecond, undefined)

      yield* Fiber.join(first)
      yield* Fiber.join(second)
      yield* Fiber.join(closeFiber)
      expect(sessions.listSummaries()).toEqual([])
    }))
  })

  it("a timed-out queued adoption waits for its session permit before cleaning a created session", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const executeStarted = yield* Deferred.make<void>()
      const releaseExecute = yield* Deferred.make<void>()
      let betaAdopted = false
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id) => makeFakeSandbox(id === "alpha"
        ? {
            onAdopt: () => Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.as("https://example.com/alpha"),
            ),
          }
        : {
            onExecute: Deferred.succeed(executeStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseExecute))),
            onAdopt: () => Effect.sync(() => {
              betaAdopted = true
              return "https://example.com/beta"
            }),
          }), { lifecycleTimeoutMs: 20 })
      sessions.createNew("alpha")

      const first = yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-alpha",
        targetUrl: "https://example.com/alpha",
      }).pipe(Effect.result), { startImmediately: true })
      yield* Deferred.await(firstStarted)
      const second = yield* Effect.forkChild(sessions.adopt({
        sessionId: "beta",
        createIfMissing: true,
        targetId: "target-beta",
        targetUrl: "https://example.com/beta",
      }).pipe(Effect.result), { startImmediately: true })
      const execute = yield* Effect.forkChild(sessions.execute({
        sessionId: "beta",
        code: "wait",
        createIfMissing: false,
      }), { startImmediately: true })
      yield* Deferred.await(executeStarted)
      expect((yield* Fiber.join(second))._tag).toBe("Failure")

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(sessions.summary("beta")).toBeDefined()
      expect(betaAdopted).toBe(false)

      yield* Deferred.succeed(releaseExecute, undefined)
      yield* Fiber.join(execute)
      for (let i = 0; i < 100 && sessions.summary("beta"); i++) yield* Effect.sleep("1 millis")
      expect(sessions.summary("beta")).toBeUndefined()
      expect(betaAdopted).toBe(false)
    }))
  })

  it("delete times out without closing when an execute still owns the permit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const never = yield* Deferred.make<void>()
        const sandbox = makeFakeSandbox({
          onExecute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(never)),
          ),
        })
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
          lifecycleTimeoutMs: 20,
        })
        sessions.createNew("alpha")

        yield* Effect.forkChild(sessions.execute({ sessionId: "alpha", code: "wedged", createIfMissing: false }))
        yield* Deferred.await(started)

        const error = yield* sessions.delete("alpha").pipe(Effect.flip)
        expect(error.message).toContain("timed out waiting for active execute")
        expect(sandbox.closes()).toBe(0)
        expect(sessions.listSummaries().map((session) => session.id)).toEqual(["alpha"])
      }),
    )
  })

  it("delete completes when sandbox close never settles", async () => {
    const sandbox = makeFakeSandbox()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => ({
      ...sandbox,
      close: () => Effect.never,
    }), {
      lifecycleTimeoutMs: 20,
    })
    sessions.createNew("alpha")

    expect(await Effect.runPromise(sessions.delete("alpha"))).toBe(true)
    expect(sessions.listSummaries()).toEqual([])
  })

  it("reset waits for a running execute and replaces the sandbox", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sandboxes: FakeSandbox[] = []
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => {
          const sandbox = sandboxes.length === 0
            ? makeFakeSandbox({
              onExecute: Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
            })
            : makeFakeSandbox()
          sandboxes.push(sandbox)
          return sandbox
        })
        sessions.createNew("alpha")

        const executeFiber = yield* Effect.forkChild(
          sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }),
        )
        yield* Deferred.await(started)

        const resetFiber = yield* Effect.forkChild(sessions.reset("alpha"))
        for (let i = 0; i < 20; i++) {
          yield* Effect.yieldNow
        }
        expect(sandboxes[0]?.closes()).toBe(0)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(executeFiber)
        const summary = yield* Fiber.join(resetFiber)
        expect(summary?.id).toBe("alpha")
        expect(sandboxes[0]?.closes()).toBe(1)
        expect(sandboxes).toHaveLength(2)
      }),
    )
  })

  it("execute fails for unknown sessions when createIfMissing is false", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    const result = await Effect.runPromise(
      sessions.execute({ sessionId: "ghost", code: "noop", createIfMissing: false }).pipe(Effect.flip),
    )
    expect(result.message).toContain("Session not found")
  })

  it("reports whether execute created a missing session", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    const first = await Effect.runPromise(
      sessions.execute({ sessionId: "ghost", code: "noop", createIfMissing: true }),
    )
    expect(first.session.id).toBe("ghost")
    expect(first.session.created).toBe(true)

    const second = await Effect.runPromise(
      sessions.execute({ sessionId: "ghost", code: "noop", createIfMissing: true }),
    )
    expect(second.session.id).toBe("ghost")
    expect(second.session.created).toBeUndefined()
  })

  it("marks the exact crashed target on active sandboxes", () => {
    const sandboxes = new Map<string, FakeSandbox>()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id) => {
      const sandbox = makeFakeSandbox({ defaultTargetId: id === "alpha" ? "target-9" : "target-10" })
      sandboxes.set(id, sandbox)
      return sandbox
    })
    sessions.createNew("alpha")
    sessions.createNew("beta")

    expect(sessions.markTargetCrashed("target-9")).toEqual(["alpha"])
    expect(sandboxes.get("alpha")?.crashedTargets()).toEqual(["target-9"])
    expect(sandboxes.get("beta")?.crashedTargets()).toEqual(["target-9"])
  })

  it("tracks read-only sessions and preserves the flag across reset", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    sessions.createNew("locked", { readOnly: true })
    sessions.createNew("open")
    expect(sessions.isReadOnly("locked")).toBe(true)
    expect(sessions.isReadOnly("open")).toBe(false)
    expect(sessions.isReadOnly("ghost")).toBe(false)
    expect(sessions.summary("locked")?.readOnly).toBe(true)
    expect(sessions.summary("open")?.readOnly).toBeUndefined()
    const summary = await Effect.runPromise(sessions.reset("locked"))
    expect(summary?.readOnly).toBe(true)
    expect(sessions.isReadOnly("locked")).toBe(true)
  })

  it("reports executing state and invokes hooks around execute", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stateChanges: Array<[string, boolean]> = []
        const records: Array<{ sessionId: string; code: string }> = []
        const sessions = new BrowserControlSessions(
          "http://127.0.0.1:0",
          () => makeFakeSandbox({
            onExecute: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          }),
          {
            onExecuteStateChange: (sessionId, executing) => {
              stateChanges.push([sessionId, executing])
            },
            onExecuteRecord: (record) => {
              records.push({ sessionId: record.sessionId, code: record.code })
            },
          },
        )
        sessions.createNew("alpha")
        expect(sessions.isExecuting("alpha")).toBe(false)

        const executeFiber = yield* Effect.forkChild(
          sessions.execute({ sessionId: "alpha", code: "await page.title()", createIfMissing: false }),
        )
        yield* Deferred.await(started)
        expect(sessions.isExecuting("alpha")).toBe(true)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(executeFiber)
        expect(sessions.isExecuting("alpha")).toBe(false)
        expect(stateChanges).toEqual([["alpha", true], ["alpha", false]])
        expect(records).toEqual([{ sessionId: "alpha", code: "await page.title()" }])
      }),
    )
  })

  it("hook failures do not fail execute", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const sessions = new BrowserControlSessions(
      "http://127.0.0.1:0",
      () => makeFakeSandbox(),
      {
        onExecuteStateChange: () => {
          throw new Error("badge hook exploded")
        },
        onExecuteRecord: () => {
          throw new Error("journal hook exploded")
        },
      },
    )
    sessions.createNew("alpha")
    try {
      const { result } = await Effect.runPromise(
        sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }),
      )
      expect(result.text).toBe("ok")
      expect(consoleError).toHaveBeenCalledTimes(3)
    } finally {
      consoleError.mockRestore()
    }
  })

  it("adopts a selected page while serializing on the session execute permit", async () => {
    const sandbox = makeFakeSandbox()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
    sessions.createNew("alpha")

    const result = await Effect.runPromise(
      sessions.adopt({ sessionId: "alpha", createIfMissing: false, targetId: "target-2", targetUrl: "https://example.com/adopted" }),
    )

    expect(result.session.id).toBe("alpha")
    expect(result.adoptedUrl).toBe("https://example.com/adopted")
    expect(sandbox.adoptedSelections()).toEqual([{ targetId: "target-2", url: "https://example.com/adopted" }])
  })

  it("uses the target registry as adoption ownership authority", async () => {
    const registry = new TargetRegistry()
    registry.addRootTarget({
      tabId: 2,
      sessionId: "bc-tab-2",
      owner: "user",
      targetInfo: {
        targetId: "target-2",
        type: "page",
        title: "Adopt me",
        url: "https://example.com/adopted",
        attached: true,
        canAccessOpener: false,
      },
    })
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), undefined, registry)
    sessions.createNew("alpha")

    await Effect.runPromise(sessions.adopt({ sessionId: "alpha", createIfMissing: false, targetId: "target-2", targetUrl: "https://example.com/adopted" }))
    expect(registry.targetsByTargetId.get("target-2")?.browserControlSessionId).toBe("alpha")

    await Effect.runPromise(sessions.reset("alpha"))
    expect(registry.targetsByTargetId.get("target-2")?.browserControlSessionId).toBeUndefined()
  })

  it("reports whether adopt created a missing session", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    const result = await Effect.runPromise(
      sessions.adopt({ sessionId: "ghost", createIfMissing: true, targetId: "target-1", targetUrl: "https://example.com/adopted" }),
    )
    expect(result.session.id).toBe("ghost")
    expect(result.session.created).toBe(true)
  })

  it("creates and cleans up an implicit adopt session transactionally", async () => {
    const success = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    const result = await Effect.runPromise(
      success.adopt({ createIfMissing: true, targetId: "target-1", targetUrl: "https://example.com/adopted" }),
    )
    expect(result.session.id).toMatch(/^[a-z]+-[a-z]+-\d{3}$/)
    expect(result.session.created).toBe(true)

    const sandbox = makeFakeSandbox({ adoptFailure: new Error("target detached") })
    const failure = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
    const error = await Effect.runPromise(
      failure.adopt({ createIfMissing: true, targetId: "target-1", targetUrl: "https://example.com/adopted" }).pipe(Effect.flip),
    )
    expect(error.message).toBe("target detached")
    expect(failure.listSummaries()).toEqual([])
    expect(sandbox.closes()).toBe(1)
  })

  it("requires createIfMissing when adopt omits the session id", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())

    const error = await Effect.runPromise(
      sessions.adopt({ createIfMissing: false, targetId: "target-1", targetUrl: "https://example.com/adopted" }).pipe(Effect.flip),
    )

    expect(error.message).toBe("sessionId is required when createIfMissing is false")
    expect(sessions.listSummaries()).toEqual([])
  })

  it("serializes competing adopts and gives one session exclusive target ownership", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id) => makeFakeSandbox(id === "alpha"
        ? {
            onAdopt: () => Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("https://example.com/adopted"),
            ),
          }
        : undefined))
      sessions.createNew("alpha")
      sessions.createNew("beta")

      const alpha = yield* Effect.forkChild(
        sessions.adopt({ sessionId: "alpha", createIfMissing: false, targetId: "target-1", targetUrl: "https://example.com/adopted" }),
      )
      yield* Deferred.await(started)
      const beta = yield* Effect.forkChild(
        sessions.adopt({ sessionId: "beta", createIfMissing: false, targetId: "target-1", targetUrl: "https://example.com/adopted" }),
      )

      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(alpha)).session.id).toBe("alpha")
      const betaResult = yield* Effect.result(Fiber.join(beta))
      expect(betaResult._tag).toBe("Failure")
      if (betaResult._tag === "Failure") {
        expect(betaResult.failure.message).toBe("Target is already adopted by session alpha. Use that session, or reset/delete it to release the tab before adopting it elsewhere.")
      }

      const implicitResult = yield* Effect.result(
        sessions.adopt({ createIfMissing: true, targetId: "target-1", targetUrl: "https://example.com/adopted" }),
      )
      expect(implicitResult._tag).toBe("Failure")
      expect(sessions.listSummaries().map((session) => session.id).sort()).toEqual(["alpha", "beta"])

      expect(sessions.releaseAdoptedTarget("target-1")).toBe("alpha")
      expect((yield* sessions.adopt({ sessionId: "beta", createIfMissing: false, targetId: "target-1", targetUrl: "https://example.com/adopted" })).session.id).toBe("beta")
    }))
  })

  it("rolls back ownership on timeout while retaining the permit until adoption settles", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const registry = new TargetRegistry()
      registry.addRootTarget({
        tabId: 1,
        sessionId: "bc-tab-1",
        owner: "user",
        targetInfo: {
          targetId: "target-1",
          type: "page",
          title: "Adopt me",
          url: "https://example.com/adopted",
          attached: true,
          canAccessOpener: false,
        },
      })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox({
        onAdopt: () => Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("https://example.com/adopted"),
        ),
      }), { lifecycleTimeoutMs: 20 }, registry)
      sessions.createNew("alpha")

      const adopt = yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-1",
        targetUrl: "https://example.com/adopted",
      }).pipe(Effect.flip))
      yield* Deferred.await(started)
      const error = yield* Fiber.join(adopt)
      expect(error.message).toBe("Session adopt for alpha timed out after 20ms")
      expect(registry.targetsByTargetId.get("target-1")?.browserControlSessionId).toBeUndefined()

      const deleteResult = yield* sessions.delete("alpha").pipe(Effect.result)
      expect(deleteResult._tag).toBe("Failure")

      yield* Deferred.succeed(release, undefined)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(sessions.adoptedTargetId("alpha")).toBeUndefined()
      expect(registry.targetsByTargetId.get("target-1")?.browserControlSessionId).toBeUndefined()
    }))
  })

  it("preserves an existing sandbox when adoption times out before starting", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sandboxes = new Map<string, FakeSandbox>()
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id) => {
        const sandbox = makeFakeSandbox(id === "alpha"
          ? {
              onAdopt: () => Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("https://example.com/alpha"),
              ),
            }
          : undefined)
        sandboxes.set(id, sandbox)
        return sandbox
      }, { lifecycleTimeoutMs: 20 })
      sessions.createNew("alpha")
      sessions.createNew("beta")

      yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-alpha",
        targetUrl: "https://example.com/alpha",
      }).pipe(Effect.ignore))
      yield* Deferred.await(started)

      const error = yield* sessions.adopt({
        sessionId: "beta",
        createIfMissing: false,
        targetId: "target-beta",
        targetUrl: "https://example.com/beta",
      }).pipe(Effect.flip)
      expect(error.message).toBe("Session adopt for beta timed out after 20ms")
      expect(sandboxes.get("beta")?.closes()).toBe(0)

      yield* Deferred.succeed(release, undefined)
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      expect(sandboxes.get("beta")?.closes()).toBe(0)
    }))
  })

  it("resets an existing sandbox when the reserved target generation changes after page adoption", async () => {
    const registry = new TargetRegistry()
    registry.addRootTarget({
      tabId: 1,
      sessionId: "bc-tab-old",
      owner: "user",
      targetInfo: {
        targetId: "target-1",
        type: "page",
        title: "Old generation",
        url: "https://example.com/adopted",
        attached: true,
        canAccessOpener: false,
      },
    })
    const sandboxes: FakeSandbox[] = []
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => {
      const sandbox = makeFakeSandbox(sandboxes.length === 0
        ? {
            onAdopt: () => Effect.sync(() => {
              registry.addRootTarget({
                tabId: 1,
                sessionId: "bc-tab-new",
                owner: "user",
                targetInfo: {
                  targetId: "target-1",
                  type: "page",
                  title: "New generation",
                  url: "https://example.com/adopted",
                  attached: true,
                  canAccessOpener: false,
                },
              })
              return "https://example.com/adopted"
            }),
          }
        : undefined)
      sandboxes.push(sandbox)
      return sandbox
    }, undefined, registry)
    sessions.createNew("alpha")

    const error = await Effect.runPromise(sessions.adopt({
      sessionId: "alpha",
      createIfMissing: false,
      targetId: "target-1",
      targetUrl: "https://example.com/adopted",
    }).pipe(Effect.flip))

    expect(error.message).toBe("Target detached or changed during adoption: target-1")
    expect(sandboxes[0]?.closes()).toBe(1)
    expect(sandboxes).toHaveLength(2)
    expect(sessions.adoptedTargetId("alpha")).toBeUndefined()
    expect(registry.targetsByTargetId.get("target-1")?.browserControlSessionId).toBeUndefined()
  })

  it("appends the adoption tip only for bare fresh-page executes with user-attached tabs", async () => {
    expect(shouldAppendAdoptionTip({
      explicitTargetSelection: false,
      sessionCreated: true,
      warnings: [],
      userAttachedPageUrls: ["https://example.com/path"],
    })).toBe(true)
    expect(shouldAppendAdoptionTip({
      explicitTargetSelection: true,
      sessionCreated: true,
      warnings: [],
      userAttachedPageUrls: ["https://example.com/path"],
    })).toBe(false)
    expect(shouldAppendAdoptionTip({
      explicitTargetSelection: false,
      sessionCreated: false,
      warnings: [],
      userAttachedPageUrls: ["https://example.com/path"],
    })).toBe(false)
    expect(adoptionTipForUrl("https://example.com/path")).toBe(
      "Tip: an attached tab is open (https://example.com/path). Use browser-control session adopt --target-url 'example.com' to drive it instead of this new tab.",
    )
  })

  it("adds the adoption tip to execute warnings when a missing session is recreated", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), {
      getUserAttachedPageUrls: () => ["https://example.com/path"],
    })

    const { result } = await Effect.runPromise(
      sessions.execute({ sessionId: "ghost", code: "noop", createIfMissing: true }),
    )

    expect(result.warnings).toContain(
      "Tip: an attached tab is open (https://example.com/path). Use browser-control session adopt --target-url 'example.com' to drive it instead of this new tab.",
    )
  })
})
