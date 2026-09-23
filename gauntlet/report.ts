export type ExpectedFailure = { readonly message: string }
export type CaseStatus = "pass" | "fail" | "xfail" | "unexpected-pass" | "budget-exceeded"
export type CaseRunResult = {
  readonly name: string
  readonly iteration: number
  readonly warmup: boolean
  readonly status: CaseStatus
  readonly durationMs: number
  readonly budgetMs: number
  readonly expectedFailure?: ExpectedFailure
  readonly notes: readonly string[]
  readonly value?: unknown
  readonly error?: string
}

export function classifyCase(options: {
  readonly error?: unknown
  readonly leaks?: string | undefined
  readonly cleanupError?: string | undefined
  readonly expectedFailure?: ExpectedFailure | undefined
  readonly durationMs: number
  readonly budgetMs: number
}): CaseStatus {
  if (options.leaks || options.cleanupError) return "fail"
  if (options.error !== undefined) {
    const error = options.error
    return error instanceof Error && error.name === "GauntletAssertion" &&
      error.message.split("\n")[0] === options.expectedFailure?.message &&
      options.durationMs <= options.budgetMs ? "xfail" : "fail"
  }
  if (options.durationMs > options.budgetMs) return "budget-exceeded"
  return options.expectedFailure ? "unexpected-pass" : "pass"
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>, available: readonly string[], defaults: { primaryPort: number; secondaryPort: number }) {
  const integer = (key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[key]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}`)
    return value
  }
  const selected = env.GAUNTLET_CASE === undefined ? [...available] : env.GAUNTLET_CASE.split(",").map((name) => name.trim())
  const unknown = selected.filter((name) => !available.includes(name))
  if (!selected.length || unknown.length) throw new Error(`Unknown gauntlet case(s): ${unknown.map((name) => name || "(empty)").join(", ")}. Available: ${available.join(", ")}`)
  if (new Set(selected).size !== selected.length) throw new Error("GAUNTLET_CASE contains duplicate names")
  for (const key of ["GAUNTLET_REPORT", "GAUNTLET_CLI"]) {
    if (env[key] !== undefined && !env[key]?.trim()) throw new Error(`${key} must not be empty`)
  }
  if (env.GAUNTLET_VERBOSE !== undefined && !["0", "1"].includes(env.GAUNTLET_VERBOSE)) throw new Error("GAUNTLET_VERBOSE must be 0 or 1")
  const primaryPort = integer("GAUNTLET_PRIMARY_PORT", defaults.primaryPort, 1, 65535)
  const secondaryPort = integer("GAUNTLET_SECONDARY_PORT", defaults.secondaryPort, 1, 65535)
  if (primaryPort === secondaryPort) throw new Error("Gauntlet fixture ports must differ")
  let endpoint: URL
  try { endpoint = new URL(env.BROWSER_CONTROL_ENDPOINT ?? "http://127.0.0.1:19989") } catch { throw new Error("BROWSER_CONTROL_ENDPOINT must be an HTTP(S) origin") }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error("BROWSER_CONTROL_ENDPOINT must be an HTTP(S) origin")
  if ([primaryPort, secondaryPort].includes(Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)))) throw new Error("BROWSER_CONTROL_ENDPOINT port must differ from fixture ports")
  return { selected, repeatCount: integer("GAUNTLET_REPEAT", 1, 1), warmupCount: integer("GAUNTLET_WARMUP", 0, 0), primaryPort, secondaryPort, cliOverride: env.GAUNTLET_CLI, reportPath: env.GAUNTLET_REPORT, verbose: env.GAUNTLET_VERBOSE === "1" }
}

export function statistics(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  if (!count) return { count, medianMs: null, p95Ms: null }
  const middle = Math.floor(count / 2)
  return { count, medianMs: count % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2, p95Ms: sorted[Math.ceil(count * 0.95) - 1]! }
}

export function summarize(results: readonly CaseRunResult[]) {
  const measured = results.filter((result) => !result.warmup)
  const count = (status: CaseStatus) => measured.filter((result) => result.status === status).length
  return {
    pass: count("pass"), fail: count("fail"), xfail: count("xfail"), unexpectedPass: count("unexpected-pass"), budgetExceeded: count("budget-exceeded"),
    ...statistics(measured.map((result) => result.durationMs)),
    cases: [...new Set(measured.map((result) => result.name))].map((name) => ({ name, ...statistics(measured.filter((result) => result.name === name).map((result) => result.durationMs)) })),
  }
}

export function runPassed(results: readonly CaseRunResult[]): boolean {
  return results.every((result) => result.status === "pass" || result.status === "xfail")
}
