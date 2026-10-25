// The contract between the gauntlet runner and an agent. The runner owns the server, the headless
// browser, network isolation and grading; a policy only drives the page it is given.
import type { Page } from "playwright-core"
import type { GauntletTask } from "./tasks.ts"

export type PolicyStep = {
  readonly op: string
  readonly label?: string
  readonly ms?: number
  readonly costUsd?: number
  readonly [key: string]: unknown
}

export type PolicyContext = {
  readonly task: GauntletTask
  readonly page: Page
  readonly maxSteps: number
  /** Report each action after it ran; the runner timestamps it and records milestone progress. */
  readonly step: (step: PolicyStep) => Promise<void>
}

type PolicyResult = {
  /** done, blocked, max_steps, stuck, error or anything the policy wants to report. */
  readonly status: string
  readonly costUsd?: number
  readonly modelMs?: number
  readonly detail?: string
}

export type GauntletPolicy = {
  readonly name: string
  readonly run: (ctx: PolicyContext) => Promise<PolicyResult>
}
