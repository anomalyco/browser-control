import { Config, Data, Effect, Exit, Latch, Match, Schema } from "effect"
import type { RelayDrain, RelayShutdownRequest } from "./relay-schema.ts"
import { RelayLifecycleEvent } from "./relay-lifecycle-log.ts"

type State = Data.TaggedEnum<{
  Running: {}
  Draining: { readonly since: number }
  Stopping: { readonly since: number }
  Closing: { readonly since: number }
}>
const State = Data.taggedEnum<State>()

/** Grace period for accepted work once the relay process is told to stop. */
export const shutdownTimeoutConfig = Config.Int("BROWSER_CONTROL_SHUTDOWN_TIMEOUT_MS").pipe(Config.withDefault(10_000))

/**
 * Process backstop for the relay entrypoint. The runtime turns the first SIGTERM or
 * SIGINT into a graceful, deadline-bounded shutdown; if teardown still has not exited
 * after `deadlineMs`, or another signal arrives, exit immediately.
 */
export const installSignalDeadline = (deadlineMs: number) => Effect.acquireRelease(
  Effect.sync(() => {
    let deadline: NodeJS.Timeout | undefined
    const onSignal = (signal: NodeJS.Signals) => {
      const code = signal === "SIGINT" ? 130 : 143
      if (deadline) {
        console.error(`[browser-control relay] received ${signal} again during shutdown; exiting now`)
        process.exit(code)
      }
      deadline = setTimeout(() => {
        console.error(`[browser-control relay] shutdown did not finish within ${deadlineMs}ms of ${signal}; exiting now`)
        process.exit(code)
      }, deadlineMs)
      deadline.unref()
    }
    process.on("SIGTERM", onSignal)
    process.on("SIGINT", onSignal)
    return onSignal
  }),
  (onSignal) => Effect.sync(() => {
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
  }),
)

export class RelayShutdownError extends Schema.TaggedError<RelayShutdownError>()(
  "RelayShutdown.Error",
  {
    reason: Schema.Literals(["busy", "instance-changed", "not-managed"]),
    message: Schema.String,
  },
) {}

export class RelayShutdown {
  private state: State = State.Running()
  private requests = 0
  private readonly idle = Latch.makeUnsafe(true)

  constructor(private readonly options: {
    readonly instanceId: string
    readonly managed: boolean
    readonly drain: Effect.Effect<void, Error>
    readonly resume: () => void
    readonly busy: () => "raw-clients" | "recordings" | undefined
    /** Human-readable work the relay is still waiting on, for status and doctor. */
    readonly holders?: () => readonly string[]
    readonly settle: Effect.Effect<void, Error>
    readonly quiescent: () => boolean
    readonly audit: (event: RelayLifecycleEvent) => Effect.Effect<void, Error>
    readonly stop: () => void
    readonly timeoutMs?: number
  }) {}

  get accepting(): boolean {
    return State.$is("Running")(this.state)
  }

  get stopping(): boolean {
    return State.$is("Stopping")(this.state) || State.$is("Closing")(this.state)
  }

  /** Where a drain or shutdown stands; undefined while the relay accepts work. */
  status(now = Date.now()): RelayDrain | undefined {
    const state = this.state
    if (State.$is("Running")(state)) return undefined
    return {
      phase: State.$is("Draining")(state) ? "draining" : State.$is("Stopping")(state) ? "stopping" : "closing",
      since: new Date(state.since).toISOString(),
      elapsedMs: Math.max(0, now - state.since),
      holders: this.holders(),
    }
  }

  holders(): readonly string[] {
    const accepted = this.requests > 0 ? [`${this.requests} accepted request(s)`] : []
    return [...accepted, ...(this.options.holders?.() ?? [])].slice(0, 12)
  }

  private get since(): number {
    return State.$is("Running")(this.state) ? Date.now() : this.state.since
  }

  /** Callers bound this wait; a shutdown must not depend on every holder letting go. */
  close(): Effect.Effect<void, Error> {
    const control = this
    return Effect.gen(function* () {
      control.state = State.Closing({ since: control.since })
      yield* Effect.all([control.options.drain, control.idle.await], { concurrency: "unbounded" })
      yield* control.idle.await
      yield* control.options.settle
    })
  }

  track<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | RelayShutdownError, R> {
    const control = this
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (!control.accepting) return Effect.fail(control.busyError())
        return Effect.sync(() => control.retain())
      }),
      () => effect,
      (release) => Effect.sync(release),
    )
  }

  // Already-admitted sandbox work needs continuation RPCs during a drain.
  // Keep their lifetime independent of the client socket remaining connected.
  trackTransport<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.retain()),
      () => effect,
      (release) => Effect.sync(release),
    )
  }

  private retain(): () => void {
    this.requests += 1
    this.idle.closeUnsafe()
    return () => {
      if (--this.requests === 0) this.idle.openUnsafe()
    }
  }

  request(request: RelayShutdownRequest): Effect.Effect<void, Error> {
    const control = this
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (request.instanceId !== control.options.instanceId) {
        return yield* new RelayShutdownError({ reason: "instance-changed", message: "Relay shutdown does not match the active managed instance" })
      }
      if (!control.options.managed) {
        return yield* new RelayShutdownError({ reason: "not-managed", message: "A foreground relay must be stopped by its owner" })
      }
      if (!control.accepting) return yield* control.busyError()
      control.state = State.Draining({ since: Date.now() })
      const fields = { instanceId: request.instanceId, requestId: request.requestId, client: request.client }
      yield* Effect.gen(function* () {
        yield* control.options.audit(RelayLifecycleEvent.cases.Requested.make(fields))
        const drain = Effect.gen(function* () {
          const busy = control.options.busy()
          if (busy) return yield* control.busyError(busy)
          yield* Effect.all([control.options.drain, control.idle.await], { concurrency: "unbounded" })
          yield* control.idle.await
          yield* control.options.settle
          const remaining = control.options.busy()
          if (remaining) return yield* control.busyError(remaining)
        })
        yield* restore(drain.pipe(Effect.timeoutOrElse({
          duration: control.options.timeoutMs ?? 10_000,
          orElse: () => control.busyError("timeout"),
        })))
        if (!State.$is("Draining")(control.state)) {
          return yield* control.busyError()
        }
        yield* control.options.audit(RelayLifecycleEvent.cases.Stopping.make(fields))
        yield* restore(Effect.void)
        if (!State.$is("Draining")(control.state)) {
          return yield* control.busyError()
        }
        if (control.requests !== 0 || !control.options.quiescent()) {
          return yield* control.busyError("changed")
        }
        const busy = control.options.busy()
        if (busy) return yield* control.busyError(busy)
        control.state = State.Stopping({ since: control.since })
        control.options.stop()
      }).pipe(Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || !State.$is("Draining")(control.state)) return Effect.void
        control.options.resume()
        control.state = State.Running()
        return control.options.audit(RelayLifecycleEvent.cases.Cancelled.make(fields)).pipe(
          Effect.catch(() => Effect.sync(() => {
            console.error(`Relay cancellation audit failed for request ${request.requestId}`)
          })),
        )
      }))
    }))
  }

  private busyError(reason?: "raw-clients" | "recordings" | "timeout" | "changed"): RelayShutdownError {
    const message = Match.value(reason).pipe(
      Match.when("raw-clients", () => "Relay has raw CDP clients attached; disconnect them before restarting"),
      Match.when("recordings", () => "Relay has active recordings or network captures; stop them before restarting"),
      Match.when("timeout", () => "Relay restart timed out waiting for accepted work; the relay is still running"),
      Match.when("changed", () => "Relay changed while preparing restart; it is still running, retry the restart"),
      Match.orElse(() => State.$is("Closing")(this.state)
        ? "Relay is shutting down; retry once a fresh relay has started"
        : "Relay is draining for an explicit restart; retry after it completes"),
    )
    return new RelayShutdownError({ reason: "busy", message })
  }
}
