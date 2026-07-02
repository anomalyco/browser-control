import { describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber } from "effect"
import { BrowserControlSessions } from "../src/session-manager.ts"
import type { ExecuteSandboxLike } from "../src/relay-types.ts"

type FakeSandbox = ExecuteSandboxLike & {
  readonly closes: () => number
}

const makeFakeSandbox = (options?: {
  readonly onExecute?: Effect.Effect<void>
}): FakeSandbox => {
  let closes = 0
  return {
    execute: () =>
      (options?.onExecute ?? Effect.void).pipe(
        Effect.as({ text: "ok", isError: false, logs: [], warnings: [] }),
      ),
    close: () =>
      Effect.sync(() => {
        closes += 1
      }),
    getStatus: () => ({ connected: false, pageUrl: null, stateKeys: [] }),
    closes: () => closes,
  }
}

describe("BrowserControlSessions", () => {
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

  it("delete force-closes the sandbox when an execute is wedged past the permit timeout", async () => {
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
          deletePermitTimeoutMs: 50,
        })
        sessions.createNew("alpha")

        yield* Effect.forkChild(sessions.execute({ sessionId: "alpha", code: "wedged", createIfMissing: false }))
        yield* Deferred.await(started)

        expect(yield* sessions.delete("alpha")).toBe(true)
        expect(sandbox.closes()).toBe(1)
        expect(sessions.listSummaries()).toEqual([])
      }),
    )
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
    const { result } = await Effect.runPromise(
      sessions.execute({ sessionId: "alpha", code: "noop", createIfMissing: false }),
    )
    expect(result.text).toBe("ok")
  })
})
