import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"

export type OwnedProcess = {
  readonly child: ChildProcess
  readonly exit: Promise<number>
  readonly stop: () => Promise<void>
}

/**
 * POSIX: retire the group created by this spawn, including redirected descendants.
 * Descendants that create a new session/group escape this boundary. Windows only
 * retires the direct child; this helper does not claim Windows process-tree safety.
 */
export function spawnOwned(options: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly logPath: string
  readonly echo?: boolean
}): OwnedProcess {
  const log = createWriteStream(options.logPath, { flags: "wx", mode: 0o600 })
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let closed = false
  let logFailed = false
  const write = (chunk: Buffer) => {
    log.write(chunk)
    if (options.echo) process.stdout.write(chunk)
  }
  child.stdout?.on("data", write)
  child.stderr?.on("data", write)
  const exit = new Promise<number>((resolve) => {
    child.once("error", (error) => log.write(`${error.message}\n`))
    child.once("close", (code) => {
      closed = true
      if (logFailed) resolve(1)
      else log.end(() => resolve(code ?? 1))
    })
    log.on("error", () => {
      // An unwritable evidence file is a failed run, never silent success.
      logFailed = true
      child.kill("SIGKILL")
    })
  })
  // The detached POSIX child is the group leader. Never discover groups by name
  // or fall back to signaling an unrelated PID. Once absent, retire its identity.
  const group = process.platform !== "win32" ? child.pid : undefined
  let retired = false
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (retired || group === undefined) return false
    try {
      process.kill(-group, signal)
      return true
    } catch (error) {
      // POSIX EPERM for signal 0 proves existence, not disappearance. Chromium's
      // sandboxed descendants can briefly reach this state during shutdown.
      if (signal === 0 && error instanceof Error && "code" in error && error.code === "EPERM") return true
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
      retired = true
      return false
    }
  }
  const alive = () => group === undefined
    ? child.exitCode === null && child.signalCode === null && !closed
    : signalGroup(0)
  const signal = (value: NodeJS.Signals) => {
    if (group !== undefined) signalGroup(value)
    else if (alive()) child.kill(value)
  }
  const waitUntilGone = async (timeoutMs: number): Promise<boolean> => {
    const deadline = performance.now() + timeoutMs
    while (alive()) {
      if (performance.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return true
  }
  let stopping: Promise<void> | undefined
  const stop = async () => {
    if (alive()) {
      signal("SIGTERM")
      if (!await waitUntilGone(2_000)) {
        signal("SIGKILL")
        if (!await waitUntilGone(2_000)) throw new Error("Owned process group did not disappear after SIGKILL")
      }
    }
    // Also await pipe/log closure, but an escaped descendant holding a pipe must
    // not turn finalization into an unbounded wait.
    await withDeadline(exit, 2_000, "Owned process output did not close after termination")
  }
  return {
    child,
    exit,
    // Share concurrent/repeated finalizers; never re-probe a retired group ID.
    stop: () => stopping ??= stop(),
  }
}

export async function waitForOwned(process: OwnedProcess, timeoutMs: number): Promise<number> {
  try {
    return await withDeadline(process.exit, timeoutMs, `Owned process exceeded ${timeoutMs}ms deadline`)
  } finally {
    await process.stop()
  }
}

/** Reject once an owned process exits, e.g. a browser or relay that must outlive a phase. */
export function failOnExit(process: OwnedProcess, message: (code: number) => string): Promise<never> {
  return process.exit.then((code) => { throw new Error(message(code)) })
}

async function withDeadline<A>(promise: Promise<A>, timeoutMs: number, message: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
