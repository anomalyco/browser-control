import { describe, expect, it, vi } from "vitest"
import { Deferred, Effect, Fiber, Latch } from "effect"
import { TestClock } from "effect/testing"
import { adoptionTipForUrl, BrowserControlSessions, shouldAppendAdoptionTip } from "../src/session-manager.ts"
import type { ExecuteSandboxLike, SessionTarget } from "../src/relay-types.ts"
import type { PersistedSession } from "../src/session-catalog.ts"
import { TargetRegistry } from "../src/target-registry.ts"

type FakeSandbox = ExecuteSandboxLike & {
  readonly closes: () => number
  readonly adoptedSelections: () => unknown[]
  readonly crashedTargets: () => string[]
  readonly detachedTargets: () => string[]
  readonly replacedTargets: () => Array<readonly [string, string]>
  readonly restoredTarget: () => PersistedSession["target"]
  readonly setDefaultTarget: (target: SessionTarget | undefined) => void
}

const makeFakeSandbox = (options?: {
  readonly onExecute?: Effect.Effect<void>
  readonly onAuthenticatedJson?: ExecuteSandboxLike["authenticatedJson"]
  readonly setupFailure?: Error
  readonly adoptFailure?: Error
  readonly onAdopt?: ExecuteSandboxLike["adoptPage"]
  readonly onClose?: Effect.Effect<void>
  readonly defaultTargetId?: string
  readonly onDefaultTargetChange?: (target: SessionTarget | undefined) => void
  readonly redactText?: (text: string) => string
}): FakeSandbox => {
  let closes = 0
  const adoptedSelections: unknown[] = []
  const crashedTargets: string[] = []
  const detachedTargets: string[] = []
  const replacedTargets: Array<readonly [string, string]> = []
  let persistenceTarget: PersistedSession["target"] = options?.defaultTargetId
    ? { id: options.defaultTargetId, owner: "relay" }
    : undefined
  const setDefaultTarget = (target: SessionTarget | undefined) => {
    persistenceTarget = target
    options?.onDefaultTargetChange?.(target)
  }
  const close = () => Effect.sync(() => {
    closes += 1
    setDefaultTarget(undefined)
  }).pipe(Effect.andThen(options?.onClose ?? Effect.void))
  const disconnect = () => Effect.sync(() => {
    closes += 1
  }).pipe(Effect.andThen(options?.onClose ?? Effect.void))
  return {
    execute: () =>
      (options?.onExecute ?? Effect.void).pipe(
        Effect.tap(() => Effect.sync(() => {
          if (!options?.setupFailure && persistenceTarget) options?.onDefaultTargetChange?.(persistenceTarget)
        })),
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
    authenticatedJson: (request) => options?.onAuthenticatedJson
      ? options.onAuthenticatedJson(request)
      : Effect.succeed({
          _tag: "Success",
          status: 200,
          value: { ok: true },
        }),
    disconnectSettled: disconnect,
    closeSettled: close,
    networkStart: () => Effect.succeed({ active: true, entryCount: 0, responseCount: 0, failureCount: 0, capturedBodyBytes: 0, truncatedBodyCount: 0, droppedEntryCount: 0 }),
    networkStatus: () => ({ active: false, entryCount: 0, responseCount: 0, failureCount: 0, capturedBodyBytes: 0, truncatedBodyCount: 0, droppedEntryCount: 0 }),
    networkStop: () => Effect.fail(new Error("network capture is not active")),
    networkCancel: () => Effect.succeed({ cancelled: false }),
    authRefresh: () => Effect.fail(new Error("auth refresh is not configured")),
    redactNetworkCaptureText: (text) => options?.redactText?.(text) ?? text,
    adoptPage: (selection) => (options?.onAdopt
      ? options.onAdopt(selection)
      : options?.adoptFailure
      ? Effect.fail(options.adoptFailure)
      : Effect.sync(() => {
          adoptedSelections.push(selection)
          return "https://example.com/adopted"
        })).pipe(Effect.tap(() => Effect.sync(() => {
          persistenceTarget = { id: selection.targetId, owner: "user" }
        }))),
    markTargetCrashed: (targetId) => {
      crashedTargets.push(targetId)
      return persistenceTarget?.id === targetId
    },
    markTargetDetached: (targetId) => {
      detachedTargets.push(targetId)
      const affected = persistenceTarget?.id === targetId
      if (affected) persistenceTarget = undefined
      return affected
    },
    markTargetReplaced: (previousTargetId, targetId) => {
      replacedTargets.push([previousTargetId, targetId])
      const affected = persistenceTarget?.id === previousTargetId
      if (affected && persistenceTarget) persistenceTarget = { ...persistenceTarget, id: targetId }
      return affected
    },
    restore: (target) => {
      persistenceTarget = target
    },
    getStatus: () => ({ connected: false, pageUrl: null, stateKeys: [] }),
    closes: () => closes,
    adoptedSelections: () => adoptedSelections,
    crashedTargets: () => crashedTargets,
    detachedTargets: () => detachedTargets,
    replacedTargets: () => replacedTargets,
    restoredTarget: () => persistenceTarget,
    setDefaultTarget,
  }
}

describe("BrowserControlSessions", () => {
  it("atomically ensures one named session", async () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    const summaries = await Effect.runPromise(Effect.all([
      sessions.ensure("x-live-chat-auth"),
      sessions.ensure("x-live-chat-auth"),
    ], { concurrency: "unbounded" }))
    expect(summaries.map((summary) => summary.id)).toEqual(["x-live-chat-auth", "x-live-chat-auth"])
    expect(sessions.listSummaries()).toHaveLength(1)
  })

  it("runs authenticated requests under the session permit without journaling", async () => {
    const records: string[] = []
    const sessions = new BrowserControlSessions(
      "http://127.0.0.1:0",
      () => makeFakeSandbox(),
      { onExecuteRecord: (record) => records.push(record.code) },
    )
    await Effect.runPromise(sessions.ensure("x-live-chat-auth"))
    const result = await Effect.runPromise(sessions.authenticatedJson({
      sessionId: "x-live-chat-auth",
      origin: "https://studio.x.com",
      method: "GET",
      path: "/api/live/get-broadcasts",
    }))
    expect(result).toEqual({ _tag: "Success", status: 200, value: { ok: true } })
    expect(records).toEqual([])
  })

  it("blocks mutations in read-only sessions before reaching the sandbox", async () => {
    let requests = 0
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox({
      onAuthenticatedJson: () => Effect.sync(() => {
        requests += 1
        return { _tag: "Success", status: 200, value: null } as const
      }),
    }))
    await Effect.runPromise(sessions.ensure("inspect", { readOnly: true }))
    const error = await Effect.runPromise(sessions.authenticatedJson({
      sessionId: "inspect",
      origin: "https://example.com",
      method: "POST",
      path: "/api",
    }).pipe(Effect.flip))
    expect(error).toMatchObject({ reason: "invalid-request" })
    expect(requests).toBe(0)
  })

  it("restores persisted identity and target ownership with reset JavaScript state", async () => {
    const persisted: PersistedSession[][] = []
    const sessions = new BrowserControlSessions(
      "http://127.0.0.1:0",
      (_id, onDefaultTargetChange) => makeFakeSandbox({ defaultTargetId: "target-1", onDefaultTargetChange }),
      { onSessionsChanged: (entries) => persisted.push([...entries]) },
    )
    sessions.createNew("alpha", { readOnly: true })
    await Effect.runPromise(sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }))
    const descriptor = persisted.at(-1)?.[0]
    expect(descriptor).toMatchObject({ id: "alpha", readOnly: true, target: { id: "target-1", owner: "relay" } })

    const restoredSandboxes: FakeSandbox[] = []
    const restored = new BrowserControlSessions("http://127.0.0.1:0", (_id, onDefaultTargetChange) => {
      const sandbox = makeFakeSandbox({ onDefaultTargetChange })
      restoredSandboxes.push(sandbox)
      return sandbox
    })
    restored.restore(descriptor ? [descriptor] : [])

    expect(restored.listSummaries()).toMatchObject([{ id: "alpha", readOnly: true, stateKeys: [] }])
    expect(restored.persistedTargetOwner("target-1")).toEqual({ sessionId: "alpha", owner: "relay" })
    expect(restoredSandboxes[0]?.restoredTarget()).toEqual({ id: "target-1", owner: "relay" })
  })

  it("persists acquired and cleared default targets through the sandbox callback", async () => {
    const persisted: PersistedSession[][] = []
    const sandboxes: FakeSandbox[] = []
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id, onDefaultTargetChange) => {
      const sandbox = makeFakeSandbox({ defaultTargetId: `target-${id}`, onDefaultTargetChange })
      sandboxes.push(sandbox)
      return sandbox
    }, { onSessionsChanged: (entries) => persisted.push([...entries]) })

    await Effect.runPromise(sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: true }))
    expect(persisted.at(-1)?.[0]?.target).toEqual({ id: "target-alpha", owner: "relay" })
    expect(sessions.persistedTargetOwner("target-alpha")).toEqual({ sessionId: "alpha", owner: "relay" })
    const writes = persisted.length

    sandboxes[0]?.setDefaultTarget({ id: "target-alpha", owner: "relay" })
    await Effect.runPromise(sessions.persist())
    expect(persisted).toHaveLength(writes)

    sandboxes[0]?.setDefaultTarget(undefined)
    await Effect.runPromise(sessions.persist())
    expect(persisted).toHaveLength(writes + 1)
    expect(persisted.at(-1)?.[0]).not.toHaveProperty("target")
    expect(sessions.persistedTargetOwner("target-alpha")).toBeUndefined()
  })

  it.each(["reset", "delete and recreate", "failed adoption"] as const)("ignores retired sandbox callbacks after %s", async (operation) => {
    const persisted: PersistedSession[][] = []
    const sandboxes: FakeSandbox[] = []
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", (_id, onDefaultTargetChange) => {
      const sandbox = makeFakeSandbox({ onDefaultTargetChange, adoptFailure: new Error("target detached") })
      sandboxes.push(sandbox)
      return sandbox
    }, { onSessionsChanged: (entries) => persisted.push([...entries]) })
    sessions.createNew("alpha")
    sandboxes[0]?.setDefaultTarget({ id: "target-old", owner: "relay" })

    if (operation === "reset") await Effect.runPromise(sessions.reset("alpha"))
    else if (operation === "delete and recreate") {
      await Effect.runPromise(sessions.delete("alpha"))
      sessions.createNew("alpha")
    } else {
      await expect(Effect.runPromise(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-adopted",
        targetUrl: "https://example.com/adopted",
      }))).rejects.toThrow("target detached")
    }
    expect(sandboxes).toHaveLength(2)
    sandboxes[1]?.setDefaultTarget({ id: "target-new", owner: "relay" })
    await Effect.runPromise(sessions.persist())
    const writes = persisted.length
    const summary = sessions.summary("alpha")

    sandboxes[0]?.setDefaultTarget(undefined)
    sandboxes[0]?.setDefaultTarget({ id: "target-stale", owner: "user" })
    await Effect.runPromise(sessions.persist())

    expect(persisted).toHaveLength(writes)
    expect(persisted.at(-1)?.[0]?.target).toEqual({ id: "target-new", owner: "relay" })
    expect(sessions.persistedTargetOwner("target-new")).toEqual({ sessionId: "alpha", owner: "relay" })
    expect(sessions.persistedTargetOwner("target-stale")).toBeUndefined()
    expect(sessions.summary("alpha")).toEqual(summary)
  })

  it("wires target changes into the default sandbox factory", async () => {
    const persisted: PersistedSession[][] = []
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", undefined, {
      onSessionsChanged: (entries) => persisted.push([...entries]),
    })
    sessions.restore([{
      id: "alpha",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "target-1", owner: "relay" },
    }])

    await Effect.runPromise(sessions.getOrCreate("alpha").session.sandbox.closeSettled())
    await Effect.runPromise(sessions.persist())

    expect(sessions.persistedTargetOwner("target-1")).toBeUndefined()
    expect(persisted.at(-1)?.[0]).not.toHaveProperty("target")
  })

  it("rejects duplicate target ownership in a persisted catalog", () => {
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
    const entry = {
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "target-1", owner: "relay" as const },
    }

    expect(() => sessions.restore([{ ...entry, id: "alpha" }, { ...entry, id: "beta" }]))
      .toThrow("Duplicate persisted target owner: target-1")
  })

  it("persists target identity while disconnecting sessions for relay shutdown", async () => {
    const persisted: PersistedSession[][] = []
    const sandboxes: FakeSandbox[] = []
    const sessions = new BrowserControlSessions(
      "http://127.0.0.1:0",
      (_id, onDefaultTargetChange) => {
        const sandbox = makeFakeSandbox({ defaultTargetId: "target-1", onDefaultTargetChange })
        sandboxes.push(sandbox)
        return sandbox
      },
      { onSessionsChanged: (entries) => persisted.push([...entries]) },
    )
    sessions.createNew("alpha")
    await Effect.runPromise(sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }))

    await Effect.runPromise(sessions.closeAll())
    const writes = persisted.length
    sandboxes[0]?.setDefaultTarget(undefined)
    await Effect.runPromise(sessions.persist())

    expect(persisted).toHaveLength(writes)
    expect(persisted.at(-1)).toMatchObject([{
      id: "alpha",
      target: { id: "target-1", owner: "relay" },
    }])
    expect(sessions.listSummaries()).toEqual([])
  })

  it("does not acknowledge reset until the targetless catalog state is committed", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      let markCommitStarted: (() => void) | undefined
      let releaseCommit: (() => void) | undefined
      const commitStarted = new Promise<void>((resolve) => {
        markCommitStarted = resolve
      })
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve
      })
      let blockWrites = false
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), {
        onSessionsChanged: () => {
          if (!blockWrites) return
          markCommitStarted?.()
          return commitGate
        },
      })
      sessions.createNew("alpha")
      yield* sessions.persist()
      blockWrites = true

      const reset = yield* Effect.forkChild(sessions.reset("alpha"))
      yield* Effect.promise(() => commitStarted)
      expect(reset.pollUnsafe()).toBeUndefined()

      releaseCommit?.()
      expect((yield* Fiber.join(reset))?.id).toBe("alpha")
    }))
  })

  it("does not let a target callback resurrect a session during a blocked delete commit", async () => {
    let markCommitStarted: (() => void) | undefined
    let releaseCommit: (() => void) | undefined
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    let blockWrites = false
    const committed: PersistedSession[][] = []
    const sandboxes = new Map<string, FakeSandbox>()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", (id, onDefaultTargetChange) => {
      const sandbox = makeFakeSandbox({ onDefaultTargetChange })
      sandboxes.set(id, sandbox)
      return sandbox
    }, {
      onSessionsChanged: async (entries) => {
        if (blockWrites) {
          markCommitStarted?.()
          await commitGate
        }
        committed.push([...entries])
      },
    })
    sessions.createNew("alpha")
    sessions.createNew("beta")
    await Effect.runPromise(sessions.persist())
    blockWrites = true

    const deletion = Effect.runPromise(sessions.delete("alpha"))
    await commitStarted
    sandboxes.get("alpha")?.setDefaultTarget({ id: "target-stale", owner: "relay" })
    sandboxes.get("beta")?.setDefaultTarget({ id: "target-beta", owner: "relay" })
    releaseCommit?.()
    await expect(deletion).resolves.toBe(true)
    await Effect.runPromise(sessions.persist())

    expect(committed.slice(-2).every((entries) => entries.every((entry) => entry.id !== "alpha"))).toBe(true)
  })

  it("fails durable lifecycle operations when the catalog cannot commit", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    let failWrites = false
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), {
      onSessionsChanged: () => failWrites ? Promise.reject(new Error("catalog unavailable")) : undefined,
    })
    sessions.createNew("alpha")
    await Effect.runPromise(sessions.persist())
    failWrites = true

    try {
      await expect(Effect.runPromise(sessions.reset("alpha"))).rejects.toThrow("catalog unavailable")
      expect(sessions.summary("alpha")).toBeDefined()
      await expect(Effect.runPromise(sessions.delete("alpha"))).rejects.toThrow("catalog unavailable")
      expect(sessions.summary("alpha")).toBeDefined()
      await expect(Effect.runPromise(sessions.create("beta"))).rejects.toThrow("catalog unavailable")
      expect(sessions.summary("beta")).toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }
  })

  it.each([false, true])("ensure rolls back its initial persistence failure (corrective write fails: %s)", async (failCorrection) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const correctionStarted = yield* Latch.make()
        const releaseCorrection = yield* Latch.make()
        const initialError = new Error("initial catalog unavailable")
        const snapshots: PersistedSession[][] = []
        const sandbox = makeFakeSandbox()
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
          onSessionsChanged: async (entries) => {
            snapshots.push([...entries])
            if (snapshots.length === 1) throw initialError
            correctionStarted.openUnsafe()
            await Effect.runPromise(releaseCorrection.await)
            if (failCorrection) throw new Error("corrective catalog unavailable")
          },
        })
        const request = yield* Effect.forkChild(sessions.ensure("alpha", { readOnly: true }).pipe(Effect.flip))
        yield* correctionStarted.await
        expect(snapshots).toEqual([[expect.objectContaining({ id: "alpha", readOnly: true })], []])
        expect(sessions.summary("alpha")).toBeUndefined()
        expect(sandbox.closes()).toBe(1)
        expect(request.pollUnsafe()).toBeUndefined()
        yield* releaseCorrection.open
        expect(yield* Fiber.join(request)).toBe(initialError)
        expect(sessions.hasPendingWork("alpha")).toBe(false)
      }))
    } finally {
      consoleError.mockRestore()
    }
  })

  it("releases a restored relay-owned target during reset", async () => {
    const released: string[] = []
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), {
      onReleaseRelayTarget: (targetId) => Effect.sync(() => {
        released.push(targetId)
      }),
    })
    sessions.restore([{
      id: "alpha",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: false,
      target: { id: "target-1", owner: "relay" },
    }])

    await Effect.runPromise(sessions.reset("alpha"))

    expect(released).toEqual(["target-1"])
    expect(sessions.persistedTargetOwner("target-1")).toBeUndefined()
  })

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

  it("rebinds only the session page backed by a replaced root target", () => {
    const first = makeFakeSandbox({ defaultTargetId: "target-1" })
    const second = makeFakeSandbox({ defaultTargetId: "target-2" })
    const sandboxes = [first, second]
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandboxes.shift()!)
    sessions.createNew("alpha")
    sessions.createNew("beta")

    expect(sessions.markTargetReplaced("target-1", "target-new")).toEqual(["alpha"])
    expect(first.replacedTargets()).toEqual([["target-1", "target-new"]])
    expect(second.replacedTargets()).toEqual([["target-1", "target-new"]])
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

  it("rejects every new mutation during drain while keeping reads and resume available", async () => {
    const sandbox = makeFakeSandbox()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
    const session = await Effect.runPromise(sessions.create("alpha"))
    // Constructing an Effect is not admission; running it is.
    const mutations: Array<Effect.Effect<unknown, Error>> = [
      sessions.create("beta"),
      sessions.ensure("alpha"),
      sessions.reset("alpha"),
      sessions.delete("alpha"),
      sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }),
      sessions.adopt({ sessionId: "alpha", createIfMissing: false, targetId: "target-1", targetUrl: "https://example.com" }),
      sessions.networkStart("alpha"),
      sessions.networkStop("alpha"),
      sessions.networkCancel("alpha"),
      sessions.authRefresh("alpha", { name: "example" }),
      sessions.authenticatedJson({ sessionId: "alpha", origin: "https://example.com", method: "GET", path: "/api" }),
    ]

    await Effect.runPromise(sessions.beginDrain())
    for (const mutation of mutations) {
      expect(await Effect.runPromise(Effect.flip(mutation))).toMatchObject({ reason: "inactive", message: "Browser Control sessions are draining" })
    }
    expect(() => sessions.createNew("beta")).toThrow("draining")
    expect(() => sessions.getOrCreate("alpha")).toThrow("draining")
    expect(() => sessions.restore([])).toThrow("draining")
    expect(sessions.summary("alpha")?.id).toBe("alpha")
    expect(sessions.listSummaries()).toHaveLength(1)
    expect(sessions.isReadOnly("alpha")).toBe(false)
    expect(sessions.isExecuting("alpha")).toBe(false)
    expect(sessions.hasPendingWork("alpha")).toBe(false)
    expect(sessions.hasActiveNetworkCapture()).toBe(false)
    expect(await Effect.runPromise(sessions.networkStatus("alpha"))).toMatchObject({ active: false })
    await Effect.runPromise(sessions.persist())
    expect(sessions.sessions.get("alpha")).toBe(session)
    expect(sandbox.closes()).toBe(0)

    sessions.resume()
    await Effect.runPromise(sessions.execute({ sessionId: "alpha", code: "resumed", createIfMissing: false }))
    await Effect.runPromise(sessions.closeAll())
    sessions.resume()
    expect(() => sessions.createNew("beta")).toThrow("closing")
  })

  it.each(["interrupt", "timeout"] as const)("a drain %s and resume never release a running permit or eventually disconnect", async (cancel) => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      let executions = 0
      const sandbox = makeFakeSandbox({
        onExecute: Effect.gen(function* () {
          executions += 1
          yield* started.open
          yield* release.await
        }),
      })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
      const session = sessions.createNew("alpha")
      const execute = yield* Effect.forkChild(sessions.execute({ sessionId: "alpha", code: "first", createIfMissing: false }))
      yield* started.await
      yield* Fiber.interrupt(execute)
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      expect(sessions.hasPendingWork("other")).toBe(false)
      const drain = yield* Effect.forkChild(sessions.beginDrain().pipe(Effect.timeoutOption("1 second")), { startImmediately: true })
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(yield* sessions.ensure("beta").pipe(Effect.flip)).toMatchObject({ reason: "inactive" })
      if (cancel === "interrupt") yield* Fiber.interrupt(drain)
      else {
        yield* TestClock.adjust("1 second")
        expect((yield* Fiber.join(drain))._tag).toBe("None")
      }
      sessions.resume()

      const next = yield* Effect.forkChild(sessions.execute({ sessionId: "alpha", code: "next", createIfMissing: false }), { startImmediately: true })
      expect(executions).toBe(1)
      expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("None")
      expect(sandbox.closes()).toBe(0)
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      yield* release.open
      yield* Fiber.join(next)
      yield* sessions.beginDrain()
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      expect(executions).toBe(2)
      expect(sessions.sessions.get("alpha")).toBe(session)
      expect(sandbox.closes()).toBe(0)
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it("drains timed-out adoption through worker settlement, cleanup, and the replacement catalog", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const adopted = yield* Latch.make()
      const releaseAdopt = yield* Latch.make()
      const closing = yield* Latch.make()
      const releaseClose = yield* Latch.make()
      const committing = yield* Latch.make()
      const releaseCommit = yield* Latch.make()
      const sandboxes: FakeSandbox[] = []
      let blockWrites = false
      const committed: PersistedSession[][] = []
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => {
        const sandbox = makeFakeSandbox(sandboxes.length === 0 ? {
          onAdopt: () => adopted.open.pipe(Effect.andThen(releaseAdopt.await), Effect.as("https://example.com")),
          onClose: closing.open.pipe(Effect.andThen(releaseClose.await)),
        } : undefined)
        sandboxes.push(sandbox)
        return sandbox
      }, {
        lifecycleTimeoutMs: 1_000,
        onSessionsChanged: async (entries) => {
          if (blockWrites) {
            committing.openUnsafe()
            await Effect.runPromise(releaseCommit.await)
          }
          committed.push([...entries])
        },
      })
      yield* sessions.create("alpha")
      blockWrites = true
      const adoption = yield* Effect.forkChild(sessions.adopt({
        sessionId: "alpha", createIfMissing: false, targetId: "target-1", targetUrl: "https://example.com",
      }).pipe(Effect.flip))
      yield* adopted.await
      yield* TestClock.adjust("1 second")
      expect((yield* Fiber.join(adoption)).message).toContain("timed out")
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(sandboxes[0]?.closes()).toBe(0)
      expect(committed).toHaveLength(1)

      yield* releaseAdopt.open
      yield* closing.await
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(committed).toHaveLength(1)
      yield* releaseClose.open
      yield* committing.await
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(committed).toHaveLength(1)
      expect(sandboxes).toHaveLength(2)
      expect(sandboxes[1]?.closes()).toBe(0)
      yield* releaseCommit.open
      yield* Fiber.join(drain)
      expect(committed).toHaveLength(2)
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      expect(sessions.summary("alpha")).toBeDefined()
      expect(sandboxes[1]?.closes()).toBe(0)
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it("drains the actual journal promise after its best-effort caller timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const started = yield* Latch.make()
        const release = yield* Latch.make()
        const sandbox = makeFakeSandbox()
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
          journalTimeoutMs: 1_000,
          onExecuteRecord: () => {
            started.openUnsafe()
            return Effect.runPromise(release.await)
          },
        })
        const session = sessions.createNew("alpha")
        const execute = yield* Effect.forkChild(sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }))
        yield* started.await
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(execute)
        expect(sessions.hasPendingWork("alpha")).toBe(true)
        expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("Some")
        const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
        expect(drain.pollUnsafe()).toBeUndefined()
        expect(sandbox.closes()).toBe(0)
        yield* release.open
        yield* Fiber.join(drain)
        expect(sessions.hasPendingWork("alpha")).toBe(false)
        expect(sandbox.closes()).toBe(0)
      }).pipe(Effect.provide(TestClock.layer())))
    } finally {
      consoleError.mockRestore()
    }
  })

  it("drains retired sandbox cleanup after its bounded caller wait", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const closing = yield* Latch.make()
      const releaseClose = yield* Latch.make()
      const sandbox = makeFakeSandbox({ onClose: closing.open.pipe(Effect.andThen(releaseClose.await)) })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, { lifecycleTimeoutMs: 1_000 })
      sessions.createNew("alpha")
      const deletion = yield* Effect.forkChild(sessions.delete("alpha"))
      yield* closing.await
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(deletion)).toBe(true)
      expect(sessions.listSummaries()).toEqual([])
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(drain.pollUnsafe()).toBeUndefined()
      yield* releaseClose.open
      yield* Fiber.join(drain)
      expect(sandbox.closes()).toBe(1)
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["create", "ensure"] as const)("drains accepted %s through an interrupted catalog commit", async (operation) => {
    await Effect.runPromise(Effect.gen(function* () {
      const committing = yield* Latch.make()
      const releaseCommit = yield* Latch.make()
      const sandbox = makeFakeSandbox()
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
        onSessionsChanged: () => {
          committing.openUnsafe()
          return Effect.runPromise(releaseCommit.await)
        },
      })
      const request = yield* Effect.forkChild(operation === "create"
        ? sessions.create("alpha").pipe(Effect.asVoid)
        : sessions.ensure("alpha").pipe(Effect.asVoid))
      yield* committing.await
      const interruption = yield* Effect.forkChild(Fiber.interrupt(request), { startImmediately: true })
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(interruption.pollUnsafe()).toBeUndefined()
      expect(sandbox.closes()).toBe(0)
      yield* releaseCommit.open
      yield* Fiber.join(interruption)
      yield* Fiber.join(drain)
      expect(sessions.summary("alpha")).toBeDefined()
      expect(sandbox.closes()).toBe(0)
    }))
  })

  it("a failed drain catalog commit can resume without closing sessions", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    let failWrites = true
    const sandbox = makeFakeSandbox()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
      onSessionsChanged: () => failWrites ? Promise.reject(new Error("catalog unavailable")) : undefined,
    })
    sessions.createNew("alpha")
    try {
      await expect(Effect.runPromise(sessions.beginDrain())).rejects.toThrow("catalog unavailable")
      expect(sandbox.closes()).toBe(0)
      expect(sessions.summary("alpha")).toBeDefined()
      sessions.resume()
      failWrites = false
      await Effect.runPromise(sessions.execute({ sessionId: "alpha", code: "retry", createIfMissing: false }))
      await Effect.runPromise(sessions.beginDrain())
      expect(sandbox.closes()).toBe(0)
    } finally {
      consoleError.mockRestore()
    }
  })

  it.each(["success", "failure"] as const)("invalidates a verified drain when a late catalog write ends in %s", async (outcome) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const committing = yield* Latch.make()
        const releaseCommit = yield* Latch.make()
        let blockWrites = false
        let failWrites = outcome === "failure"
        let sandbox: FakeSandbox | undefined
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", (_id, onDefaultTargetChange) => {
          sandbox = makeFakeSandbox({ onDefaultTargetChange })
          return sandbox
        }, {
          onSessionsChanged: async () => {
            if (!blockWrites) return
            committing.openUnsafe()
            await Effect.runPromise(releaseCommit.await)
            if (failWrites) throw new Error("late catalog unavailable")
          },
        })
        yield* sessions.create("alpha")
        expect(sessions.isDrained()).toBe(false)
        yield* sessions.beginDrain()
        expect(sessions.isDrained()).toBe(true)

        blockWrites = true
        sandbox?.setDefaultTarget({ id: "late-target", owner: "relay" })
        expect(sessions.isDrained()).toBe(false)
        yield* committing.await
        expect(sessions.isDrained()).toBe(false)
        yield* releaseCommit.open
        const committed = yield* sessions.persist().pipe(Effect.result)
        expect(committed._tag).toBe(outcome === "failure" ? "Failure" : "Success")
        expect(sessions.hasPendingWork("alpha")).toBe(false)
        // Even a settled write is not the tail verified by the earlier drain.
        expect(sessions.isDrained()).toBe(false)
        if (outcome === "failure") {
          expect(yield* sessions.beginDrain().pipe(Effect.flip)).toMatchObject({ message: "late catalog unavailable" })
          expect(sessions.isDrained()).toBe(false)
          failWrites = false
          sandbox?.setDefaultTarget({ id: "retry-target", owner: "relay" })
        }
        yield* sessions.beginDrain()
        expect(sessions.isDrained()).toBe(true)
        expect(sandbox?.closes()).toBe(0)
        sessions.resume()
        expect(sessions.isDrained()).toBe(false)
      }))
    } finally {
      consoleError.mockRestore()
    }
  })

  it.each(["network start", "network stop", "network cancel", "auth refresh", "authenticated request"] as const)("drains queued %s through actual settlement after caller interruption", async (operation) => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const blocked = started.open.pipe(Effect.andThen(release.await))
      const sandbox = makeFakeSandbox()
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => ({
        ...sandbox,
        networkStart: (options) => blocked.pipe(Effect.andThen(sandbox.networkStart(options))),
        networkStop: (options) => blocked.pipe(Effect.andThen(sandbox.networkStop(options))),
        networkCancel: () => blocked.pipe(Effect.andThen(sandbox.networkCancel())),
        authRefresh: (options) => blocked.pipe(Effect.andThen(sandbox.authRefresh(options))),
        authenticatedJson: (options) => blocked.pipe(Effect.andThen(sandbox.authenticatedJson(options))),
      }))
      const session = sessions.createNew("alpha")
      yield* session.executeSemaphore.take(1)
      const operations: Record<typeof operation, Effect.Effect<unknown, Error>> = {
        "network start": sessions.networkStart("alpha"),
        "network stop": sessions.networkStop("alpha"),
        "network cancel": sessions.networkCancel("alpha"),
        "auth refresh": sessions.authRefresh("alpha", { name: "example" }),
        "authenticated request": sessions.authenticatedJson({ sessionId: "alpha", origin: "https://example.com", method: "GET", path: "/api" }),
      }
      const request = yield* Effect.forkChild(operations[operation], { startImmediately: true })
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      expect(sessions.isExecuting("alpha")).toBe(false)
      expect(started.isOpen()).toBe(false)
      expect(drain.pollUnsafe()).toBeUndefined()

      yield* session.executeSemaphore.release(1)
      yield* started.await
      const interruption = yield* Effect.forkChild(Fiber.interrupt(request), { startImmediately: true })
      expect(interruption.pollUnsafe()).toBeUndefined()
      expect(drain.pollUnsafe()).toBeUndefined()
      expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("None")
      yield* release.open
      yield* Fiber.join(interruption)
      yield* Fiber.join(drain)
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      expect(sandbox.closes()).toBe(0)
    }))
  })

  it.each(["networkStart", "networkStop", "networkCancel", "authRefresh"] as const)("rejects queued %s when reset replaces its session", async (operation) => {
    await Effect.runPromise(Effect.gen(function* () {
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox())
      const session = sessions.createNew("alpha")
      const call = vi.spyOn(session.sandbox, operation)
      yield* session.executeSemaphore.take(1)
      const reset = yield* Effect.forkChild(sessions.reset("alpha"), { startImmediately: true })
      const operations: Record<typeof operation, Effect.Effect<unknown, Error>> = {
        networkStart: sessions.networkStart("alpha"),
        networkStop: sessions.networkStop("alpha"),
        networkCancel: sessions.networkCancel("alpha"),
        authRefresh: sessions.authRefresh("alpha", { name: "example" }),
      }
      const request = yield* Effect.forkChild(operations[operation].pipe(Effect.flip), { startImmediately: true })
      expect(request.pollUnsafe()).toBeUndefined()
      expect(call).not.toHaveBeenCalled()
      yield* session.executeSemaphore.release(1)
      yield* Fiber.join(reset)
      expect(yield* Fiber.join(request)).toMatchObject({ reason: "inactive", message: "Session is no longer active: alpha", sessionId: "alpha" })
      expect(sessions.sessions.get("alpha")).not.toBe(session)
      expect(call).not.toHaveBeenCalled()
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("Some")
    }))
  })

  it("reports active network capture independently of pending manager work", async () => {
    let active = true
    const sandbox = makeFakeSandbox()
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => ({
      ...sandbox,
      networkStatus: () => ({ ...sandbox.networkStatus(), active }),
    }))
    sessions.createNew("alpha")
    await Effect.runPromise(sessions.beginDrain())
    expect(sessions.hasPendingWork("alpha")).toBe(false)
    expect(sessions.hasActiveNetworkCapture()).toBe(true)
    active = false
    expect(sessions.hasActiveNetworkCapture()).toBe(false)
    expect(sandbox.closes()).toBe(0)
  })

  it("cancels a queued lifecycle operation without stranding its admission or a permit", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const sandbox = makeFakeSandbox()
      const start = vi.spyOn(sandbox, "networkStart")
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
      const session = sessions.createNew("alpha")
      yield* session.executeSemaphore.take(1)
      const request = yield* Effect.forkChild(sessions.networkStart("alpha"), { startImmediately: true })
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      yield* Fiber.interrupt(request)
      yield* Fiber.join(drain)
      expect(start).not.toHaveBeenCalled()
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      yield* session.executeSemaphore.release(1)
      sessions.resume()
      yield* sessions.networkStart("alpha")
      expect(start).toHaveBeenCalledTimes(1)
      expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("Some")
    }))
  })

  it("keeps implicit-session worker leases after the request is interrupted", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox({
        onExecute: started.open.pipe(Effect.andThen(release.await)),
      }))
      const request = yield* Effect.forkChild(sessions.execute({ code: "noop", createIfMissing: true }))
      yield* started.await
      const id = sessions.listSummaries()[0]?.id
      if (!id) throw new Error("Expected an implicit session")
      yield* Fiber.interrupt(request)
      expect(sessions.hasPendingWork(id)).toBe(true)
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(drain.pollUnsafe()).toBeUndefined()
      yield* release.open
      yield* Fiber.join(drain)
      expect(sessions.hasPendingWork(id)).toBe(false)
      expect(sessions.summary(id)).toBeDefined()
    }))
  })

  it("serializes permanent close calls and retains keyed work through disconnect", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const closing = yield* Latch.make()
      const release = yield* Latch.make()
      const sandbox = makeFakeSandbox({ onClose: closing.open.pipe(Effect.andThen(release.await)) })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox)
      sessions.createNew("alpha")
      const first = yield* Effect.forkChild(sessions.closeAll(), { startImmediately: true })
      const second = yield* Effect.forkChild(sessions.closeAll(), { startImmediately: true })
      yield* closing.await
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      expect(sandbox.closes()).toBe(1)
      expect(first.pollUnsafe()).toBeUndefined()
      expect(second.pollUnsafe()).toBeUndefined()
      sessions.resume()
      expect(() => sessions.createNew("beta")).toThrow("closing")
      yield* release.open
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      expect(sandbox.closes()).toBe(1)
    }))
  })

  it("closeAll drains a running execute without the lifecycle timeout", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sandbox = makeFakeSandbox({
          onExecute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        })
        const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
          lifecycleTimeoutMs: 0,
        })
        sessions.createNew("alpha")
        const executeFiber = yield* Effect.forkChild(
          sessions.execute({ sessionId: "alpha", code: "long-running", createIfMissing: false }),
        )
        yield* Deferred.await(started)
        const closeFiber = yield* Effect.forkChild(sessions.closeAll())
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow

        expect(closeFiber.pollUnsafe()).toBeUndefined()
        expect(sandbox.closes()).toBe(0)
        expect(sessions.listSummaries().map((session) => session.id)).toEqual(["alpha"])

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(executeFiber)
        yield* Fiber.join(closeFiber)
        expect(sandbox.closes()).toBe(1)
        expect(sessions.listSummaries()).toEqual([])
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

  it.each(["execute", "reset", "delete"] as const)("retains an interrupted execute's permit through journal and catalog writes before queued %s", async (operation) => {
    await Effect.runPromise(Effect.gen(function* () {
      const executeStarted = yield* Latch.make()
      const releaseExecute = yield* Latch.make()
      const journalStarted = yield* Latch.make()
      const releaseJournal = yield* Latch.make()
      const catalogStarted = yield* Latch.make()
      const releaseCatalog = yield* Latch.make()
      const events: string[] = []
      let executions = 0
      let blockCatalog = false
      const sandbox = makeFakeSandbox({
        onExecute: Effect.gen(function* () {
          executions += 1
          events.push("execute")
          if (executions === 1) {
            yield* executeStarted.open
            yield* releaseExecute.await
          }
        }),
        onClose: Effect.sync(() => { events.push("close") }),
      })
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
        onExecuteRecord: (record) => {
          if (record.code !== "first") return
          return Effect.runPromise(Effect.gen(function* () {
            events.push("journal started")
            yield* journalStarted.open
            yield* releaseJournal.await
            events.push("journal committed")
          }))
        },
        onSessionsChanged: () => {
          if (!blockCatalog) return
          blockCatalog = false
          return Effect.runPromise(Effect.gen(function* () {
            events.push("catalog started")
            yield* catalogStarted.open
            yield* releaseCatalog.await
            events.push("catalog committed")
          }))
        },
      })
      const session = sessions.createNew("alpha")
      yield* sessions.persist()
      blockCatalog = true
      const execute = yield* Effect.forkChild(sessions.execute({ sessionId: "alpha", code: "first", createIfMissing: false }))
      yield* executeStarted.await
      yield* Fiber.interrupt(execute)

      const next = operation === "execute"
        ? sessions.execute({ sessionId: "alpha", code: "next", createIfMissing: false }).pipe(Effect.asVoid)
        : operation === "reset"
        ? sessions.reset("alpha").pipe(Effect.asVoid)
        : sessions.delete("alpha").pipe(Effect.asVoid)
      const queued = yield* Effect.forkChild(next, { startImmediately: true })
      const drain = yield* Effect.forkChild(sessions.beginDrain(), { startImmediately: true })
      expect(sessions.hasPendingWork("alpha")).toBe(true)

      yield* releaseExecute.open
      yield* journalStarted.await
      expect(events).toEqual(["execute", "journal started"])
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      expect(sessions.isExecuting("alpha")).toBe(false)
      expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("None")
      expect(queued.pollUnsafe()).toBeUndefined()
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(executions).toBe(1)
      expect(sandbox.closes()).toBe(0)
      expect(sessions.sessions.get("alpha")).toBe(session)

      yield* releaseJournal.open
      yield* catalogStarted.await
      expect(events).toEqual(["execute", "journal started", "journal committed", "catalog started"])
      expect(sessions.hasPendingWork("alpha")).toBe(true)
      expect((yield* session.executeSemaphore.withPermitsIfAvailable(1)(Effect.void))._tag).toBe("None")
      expect(queued.pollUnsafe()).toBeUndefined()
      expect(drain.pollUnsafe()).toBeUndefined()
      expect(executions).toBe(1)
      expect(sandbox.closes()).toBe(0)
      expect(sessions.sessions.get("alpha")).toBe(session)

      yield* releaseCatalog.open
      yield* Fiber.join(queued)
      yield* Fiber.join(drain)
      expect(sessions.hasPendingWork("alpha")).toBe(false)
      expect(events).toEqual([
        "execute", "journal started", "journal committed", "catalog started", "catalog committed",
        operation === "execute" ? "execute" : "close",
      ])
    }))
  })

  it("never starts an interrupted execute queued for the session permit", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const sandbox = makeFakeSandbox()
      const execute = vi.spyOn(sandbox, "execute")
      const records: string[] = []
      const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => sandbox, {
        onExecuteRecord: (record) => { records.push(record.code) },
      })
      const session = sessions.createNew("alpha")
      yield* session.executeSemaphore.take(1)

      const queued = yield* Effect.forkChild(sessions.execute({
        sessionId: "alpha", code: "cancelled", createIfMissing: false,
      }), { startImmediately: true })
      expect(queued.pollUnsafe()).toBeUndefined()
      expect(execute).not.toHaveBeenCalled()
      yield* Fiber.interrupt(queued)
      expect(execute).not.toHaveBeenCalled()

      yield* session.executeSemaphore.release(1)
      yield* sessions.execute({ sessionId: "alpha", code: "next", createIfMissing: false })

      expect(execute.mock.calls.map(([code]) => code)).toEqual(["next"])
      expect(records).toEqual(["next"])
      expect(sandbox.closes()).toBe(0)
    }))
  })

  it("bounds best-effort journal I/O without retaining the execute permit", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), {
      journalTimeoutMs: 20,
      onExecuteRecord: () => new Promise(() => {}),
    })
    sessions.createNew("alpha")
    try {
      await expect(Effect.runPromise(sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false })))
        .resolves.toMatchObject({ result: { text: "ok" } })
      await expect(Effect.runPromise(sessions.delete("alpha"))).resolves.toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  it("removes an implicitly created session when its durable execute commit fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox(), {
      onSessionsChanged: () => Promise.reject(new Error("catalog unavailable")),
    })
    try {
      await expect(Effect.runPromise(sessions.execute({ sessionId: "ghost", code: "noop", createIfMissing: true })))
        .rejects.toThrow("catalog unavailable")
      expect(sessions.summary("ghost")).toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }
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

  it("redacts capture values before execute code reaches the session journal hook", async () => {
    const records: string[] = []
    const sessions = new BrowserControlSessions(
      "http://127.0.0.1:0",
      () => makeFakeSandbox({ redactText: (text) => text.replaceAll("live-token", "${BC_SECRET_1}") }),
      { onExecuteRecord: (record) => records.push(record.code) },
    )
    sessions.createNew("alpha")

    await Effect.runPromise(sessions.execute({
      sessionId: "alpha",
      code: "return 'live-token'",
      createIfMissing: false,
    }))
    expect(records).toEqual(["return '${BC_SECRET_1}'"])
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

      expect(sessions.markTargetDetached("target-1")).toEqual(["alpha"])
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

  it("releases a replacement generation of the previously adopted target", async () => {
    const registry = new TargetRegistry()
    const addTarget = (tabId: number, sessionId: string, targetId: string) => registry.addRootTarget({
      tabId,
      sessionId,
      owner: "user" as const,
      targetInfo: {
        targetId,
        type: "page" as const,
        title: targetId,
        url: `https://example.com/${targetId}`,
        attached: true,
        canAccessOpener: false,
      },
    })
    addTarget(1, "bc-tab-a", "target-a")
    addTarget(2, "bc-tab-b", "target-b")
    let sessions: BrowserControlSessions
    sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox({
      onAdopt: (target) => Effect.sync(() => {
        if (target.targetId === "target-b") {
          addTarget(1, "bc-tab-a2", "target-a2")
          sessions.markTargetReplaced("target-a", "target-a2")
        }
        return target.url
      }),
    }), undefined, registry)
    sessions.createNew("alpha")

    await Effect.runPromise(sessions.adopt({
      sessionId: "alpha",
      createIfMissing: false,
      targetId: "target-a",
      targetUrl: "https://example.com/target-a",
    }))
    await Effect.runPromise(sessions.adopt({
      sessionId: "alpha",
      createIfMissing: false,
      targetId: "target-b",
      targetUrl: "https://example.com/target-b",
    }))

    expect(sessions.adoptedTargetId("alpha")).toBe("target-b")
    expect(registry.targetsByTargetId.get("target-a2")?.browserControlSessionId).toBeUndefined()
    expect(registry.targetsByTargetId.get("target-b")?.browserControlSessionId).toBe("alpha")
  })

  it("explicitly releases the previous target when a later adoption fails", async () => {
    const registry = new TargetRegistry()
    const addTarget = (tabId: number, targetId: string) => registry.addRootTarget({
      tabId,
      sessionId: `bc-tab-${tabId}`,
      owner: "user" as const,
      targetInfo: {
        targetId,
        type: "page" as const,
        title: targetId,
        url: `https://example.com/${targetId}`,
        attached: true,
        canAccessOpener: false,
      },
    })
    addTarget(1, "target-a")
    addTarget(2, "target-b")
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", () => makeFakeSandbox({
      onAdopt: (target) => target.targetId === "target-b"
        ? Effect.fail(new Error("prompt target vanished"))
        : Effect.succeed(target.url),
    }), undefined, registry)
    sessions.createNew("alpha")
    await Effect.runPromise(sessions.adopt({
      sessionId: "alpha",
      createIfMissing: false,
      targetId: "target-a",
      targetUrl: "https://example.com/target-a",
    }))

    await expect(Effect.runPromise(sessions.adopt({
      sessionId: "alpha",
      createIfMissing: false,
      targetId: "target-b",
      targetUrl: "https://example.com/target-b",
    }))).rejects.toThrow("prompt target vanished")

    expect(sessions.adoptedTargetId("alpha")).toBeUndefined()
    expect(registry.targetsByTargetId.get("target-a")?.browserControlSessionId).toBeUndefined()
    expect(registry.targetsByTargetId.get("target-b")?.browserControlSessionId).toBeUndefined()
  })

  it("surfaces a durable adoption rollback failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    let failRollback = false
    const sessions = new BrowserControlSessions("http://127.0.0.1:0", (_id, onDefaultTargetChange) => makeFakeSandbox({
      onDefaultTargetChange,
      onAdopt: (target) => target.targetId === "target-a"
        ? Effect.succeed(target.url)
        : Effect.fail(new Error("target vanished")),
    }), {
      onSessionsChanged: (entries) => failRollback && entries.some((entry) => entry.id === "alpha" && !entry.target)
        ? Promise.reject(new Error("rollback catalog unavailable"))
        : undefined,
    })
    sessions.createNew("alpha")
    await Effect.runPromise(sessions.adopt({
      sessionId: "alpha",
      createIfMissing: false,
      targetId: "target-a",
      targetUrl: "https://example.com/target-a",
    }))
    failRollback = true

    try {
      await expect(Effect.runPromise(sessions.adopt({
        sessionId: "alpha",
        createIfMissing: false,
        targetId: "target-b",
        targetUrl: "https://example.com/target-b",
      }))).rejects.toThrow("rollback catalog unavailable")
    } finally {
      consoleError.mockRestore()
    }
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
