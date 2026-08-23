import { Effect } from "effect"
import * as AuthProfile from "./auth-profile.ts"

export type Summary = AuthProfile.AuthProfileSummary
export type RunResult = AuthProfile.AuthRunResult
export type RunOptions = AuthProfile.AuthRunOptions
export type StatusOptions = AuthProfile.AuthProfileOptions
export type Error = AuthProfile.AuthProfileError
export const Error = AuthProfile.AuthProfileError

/** Return profile metadata without revealing credential values. */
export const status = Effect.fn("SecretProfile.status")(function* (name: string, options: StatusOptions = {}) {
  return yield* AuthProfile.status(name, options)
})

/**
 * Run a trusted credential-bearing worker with profile slots injected as BC_SECRET_N.
 * Known values are redacted from bounded stdout and stderr before they return.
 */
export const run = Effect.fn("SecretProfile.run")(function* (options: RunOptions) {
  return yield* AuthProfile.run(options)
})
