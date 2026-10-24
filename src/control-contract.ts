// control-contract v1: the shared JSON contract for Kit's *-control CLIs.
// Canonical source: control-kit/contract/control-contract.ts. Repos vendor a copy
// with `bun scripts/sync.ts`; edit the canonical file, never a copy.
import { writeSync } from "node:fs"

export const contractVersion = 1

export type Coverage = "complete" | "partial" | "unavailable"

export interface Envelope<T> {
  readonly ok: true
  readonly command: string
  readonly checkedAt: string
  readonly items: ReadonlyArray<T>
  readonly coverage: Coverage
  readonly warnings: ReadonlyArray<string>
  readonly readOnly: boolean
  readonly readEffects: ReadonlyArray<string>
}

export interface FailureEnvelope {
  readonly ok: false
  readonly command: string
  readonly checkedAt: string
  readonly error: {
    readonly code: string
    readonly message: string
    readonly hint?: string
    readonly exitCode: number
  }
}

/** 2 usage, 3 auth/permission, 4 relay/host/bridge unreachable. */
export const ExitCode = { ok: 0, failure: 1, usage: 2, auth: 3, host: 4 } as const
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export interface EnvelopeOptions {
  readonly coverage?: Coverage
  readonly warnings?: ReadonlyArray<string>
  readonly readOnly?: boolean
  readonly readEffects?: ReadonlyArray<string>
}

/** Extra fields (e.g. `nextBefore`, `failures`) go after the contract keys and can't override them. */
// biome-ignore lint/complexity/noBannedTypes: the default adds no extra keys
export const envelope = <T, X extends Record<string, unknown> = {}>(
  command: string,
  items: ReadonlyArray<T>,
  options: EnvelopeOptions = {},
  extra?: X,
): Envelope<T> & X => ({
  ...(extra as X),
  ok: true,
  command,
  checkedAt: new Date().toISOString(),
  items,
  coverage: options.coverage ?? (options.warnings?.length ? "partial" : "complete"),
  warnings: options.warnings ?? [],
  readOnly: options.readOnly ?? true,
  readEffects: options.readEffects ?? [],
})

export const failure = (
  command: string,
  code: string,
  message: string,
  options: { readonly hint?: string; readonly exitCode?: number } = {},
): FailureEnvelope => ({
  ok: false,
  command,
  checkedAt: new Date().toISOString(),
  error: {
    code,
    message,
    ...(options.hint ? { hint: options.hint } : {}),
    exitCode: options.exitCode ?? ExitCode.failure,
  },
})

/** `--json` may appear anywhere, including before the subcommand. */
export const takeJsonFlag = (argv: ReadonlyArray<string>) => ({
  json: argv.includes("--json"),
  argv: argv.filter((arg) => arg !== "--json"),
})

const pause = new Int32Array(new SharedArrayBuffer(4))

/**
 * Write all of `text` to stdout synchronously. Bun can exit before an async
 * stdout write to a pipe drains (output past 64 KiB is lost), so loop on
 * writeSync and wait briefly when a full pipe reports EAGAIN.
 */
export const writeStdout = (text: string, fd = 1): void => {
  const buffer = Buffer.from(text)
  let offset = 0
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EPIPE") return
      if (code !== "EAGAIN") throw error
      Atomics.wait(pause, 0, 0, 2)
    }
  }
}

export const printJson = (value: unknown): void => writeStdout(`${JSON.stringify(value, null, 2)}\n`)
