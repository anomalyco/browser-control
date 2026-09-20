#!/usr/bin/env tsx
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Clock, Console, Effect } from "effect"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { registerAriaSnapshotSelector } from "../src/aria-snapshot.ts"
import { cases, type GauntletCase } from "../gauntlet/cases.ts"
import {
  boundedCleanup,
  endpointUrl,
  fetchStatus,
  formatError,
  formatValue,
  parseExecuteEnvelope,
  playwright,
  resolveCli,
  resourceLeaks,
  runCli,
  scopedOwnerCdpPage,
  type CliSelection,
  type GauntletContext,
} from "../gauntlet/harness.ts"
import { defaultPrimaryPort, defaultSecondaryPort, startGauntletServers, type GauntletServers } from "../gauntlet/server.ts"

const selectedCaseNames = parseCaseFilter(process.env.GAUNTLET_CASE)
const repeatCount = parsePositiveInteger(process.env.GAUNTLET_REPEAT) ?? 1
const cliOverride = process.env.GAUNTLET_CLI
const primaryPort = parsePositiveInteger(process.env.GAUNTLET_PRIMARY_PORT) ?? defaultPrimaryPort
const secondaryPort = parsePositiveInteger(process.env.GAUNTLET_SECONDARY_PORT) ?? defaultSecondaryPort

type CaseStatus = "pass" | "fail" | "xfail" | "unexpected-pass" | "budget-exceeded"

type CaseRunResult = {
  readonly name: string
  readonly iteration: number
  readonly status: CaseStatus
  readonly durationMs: number
  readonly budgetMs: number
  readonly notes: readonly string[]
  readonly value?: unknown
  readonly error?: string
}

const main = Effect.fn("Gauntlet.main")(function* () {
  const selectedCases = cases.filter((testCase) => selectedCaseNames.size === 0 || selectedCaseNames.has(testCase.name))
  const unknown = Array.from(selectedCaseNames).filter((name) => !cases.some((testCase) => testCase.name === name))
  if (unknown.length > 0 || selectedCases.length === 0) {
    return yield* Effect.fail(new Error(`Unknown gauntlet case(s): ${unknown.join(", ") || "(none selected)"}. Available: ${cases.map((testCase) => testCase.name).join(", ")}`))
  }

  yield* Console.log(`browser-control gauntlet: ${selectedCases.map((testCase) => testCase.name).join(", ")} x${repeatCount}`)
  const cli = yield* resolveCli(cliOverride)
  yield* Console.log(`cli: ${cli.describe}`)
  const initial = yield* fetchStatus()
  if (!initial.connected) return yield* Effect.fail(new Error(`Browser Control extension is not connected to ${endpointUrl}; open the browser with the extension loaded before running the gauntlet.`))
  yield* Console.log(`relay: ${endpointUrl} targets=${initial.activeTargets} cdpClients=${initial.cdpClients}`)

  const results = yield* Effect.scoped(Effect.gen(function* () {
    const servers = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => startGauntletServers({ primaryPort, secondaryPort }), catch: (cause) => cause instanceof Error ? cause : new Error("start gauntlet fixture servers", { cause }) }),
      (running) => boundedCleanup("close fixture servers", () => running.close()),
    )
    yield* Console.log(`fixtures: ${servers.primaryOrigin} (primary), ${servers.secondaryOrigin} (secondary)`)
    return yield* Effect.forEach(
      range(repeatCount).flatMap((iteration) => selectedCases.map((testCase) => ({ iteration: iteration + 1, testCase }))),
      ({ testCase, iteration }) => runCase({ testCase, iteration, cli, servers }).pipe(Effect.tap(printCaseResult)),
      { concurrency: 1 },
    )
  }))

  yield* Console.log("")
  yield* Console.log(renderTable(results))
  const summary = summarize(results)
  yield* Console.log(`summary: ${formatValue(summary)}`)
  const failing = results.filter((result) => result.status !== "pass" && result.status !== "xfail")
  if (failing.length > 0) {
    return yield* Effect.fail(new Error(`${failing.length} gauntlet case(s) need attention: ${failing.map((result) => `${result.name}#${result.iteration}=${result.status}`).join(", ")}`))
  }
})

const runCase = Effect.fn("Gauntlet.runCase")(function* (options: {
  readonly testCase: GauntletCase
  readonly iteration: number
  readonly cli: CliSelection
  readonly servers: GauntletServers
}): Effect.fn.Return<CaseRunResult, Error> {
  const { testCase, cli, servers } = options
  const notes: string[] = []
  const createdSessionIds = new Set<string>()
  const ctx = makeContext({ cli, servers, notes, createdSessionIds })
  yield* Console.log(`--- ${testCase.name}#${options.iteration}: ${testCase.summary}`)
  yield* Console.log(`    fixture ${testCase.fixtureUrl(servers)} budget ${testCase.budgetMs}ms${testCase.expectedFailure ? " (expected failure)" : ""}`)
  const start = yield* Clock.currentTimeMillis
  // Case assertions throw synchronously inside generators; surface them as
  // typed failures so they are reported like any other case error.
  const attempt = withUserTab((page) => testCase.run(page, ctx), testCase.userTabCleanupGraceMs ?? 15_000).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect instanceof Error ? defect : new Error(`gauntlet case defect: ${formatValue(defect)}`))),
  )
  const outcome = yield* Effect.matchEffect(attempt, {
    onFailure: (error) => Effect.succeed({ _tag: "Failure" as const, error }),
    onSuccess: (value) => Effect.succeed({ _tag: "Success" as const, value }),
  })
  const end = yield* Clock.currentTimeMillis
  const durationMs = end - start
  const leakCheck = { createdSessionIds, fixtureOrigins: [servers.primaryOrigin, servers.secondaryOrigin] }
  const after = yield* waitForRelayCleanup(leakCheck)
  const leaks = resourceLeaks({ after, ...leakCheck })
  if (leaks) notes.push(`leaked relay resources: ${leaks}`)

  const passed = outcome._tag === "Success" && !leaks
  const withinBudget = durationMs <= testCase.budgetMs
  const status: CaseStatus = passed
    ? (withinBudget ? (testCase.expectedFailure ? "unexpected-pass" : "pass") : "budget-exceeded")
    : (testCase.expectedFailure ? "xfail" : "fail")
  return {
    name: testCase.name,
    iteration: options.iteration,
    status,
    durationMs,
    budgetMs: testCase.budgetMs,
    notes,
    ...(outcome._tag === "Success" ? { value: outcome.value } : {}),
    ...(outcome._tag === "Failure" ? { error: formatError(outcome.error) } : leaks ? { error: `Gauntlet case leaked relay resources: ${leaks}` } : {}),
  }
})

function makeContext(options: {
  readonly cli: CliSelection
  readonly servers: GauntletServers
  readonly notes: string[]
  readonly createdSessionIds: Set<string>
}): GauntletContext {
  const { cli, servers, notes, createdSessionIds } = options
  const run: GauntletContext["run"] = (args, runOptions) => runCli(cli, args, runOptions ?? {})
  const execute: GauntletContext["execute"] = (executeOptions) => Effect.gen(function* () {
    const args = ["execute", "--json"]
    if (executeOptions.sessionId) args.push("--session", executeOptions.sessionId)
    if (executeOptions.targetUrl) args.push("--target-url", executeOptions.targetUrl)
    args.push(executeOptions.code)
    const start = yield* Clock.currentTimeMillis
    const result = yield* run(args, { timeoutMs: executeOptions.timeoutMs ?? 90_000 })
    const end = yield* Clock.currentTimeMillis
    return yield* Effect.try({
      try: () => parseExecuteEnvelope(result, end - start),
      catch: (cause) => cause instanceof Error ? cause : new Error("parse execute envelope", { cause }),
    })
  })
  const sessionTargets: GauntletContext["sessionTargets"] = (sessionId) => fetchStatus().pipe(
    Effect.map((status) => status.targets.filter((target) => target.browserControlSessionId === sessionId)),
  )
  return {
    cli,
    fixtures: { primaryOrigin: servers.primaryOrigin, secondaryOrigin: servers.secondaryOrigin },
    run,
    execute,
    // Bare execute creates the session atomically without touching the user's
    // current-session store, unlike `session new`.
    createSession: () => execute({ code: "return 'gauntlet'" }).pipe(
      Effect.flatMap((envelope) => envelope.ok && envelope.session
        ? Effect.sync(() => {
          createdSessionIds.add(envelope.session!.id)
          return envelope.session!.id
        })
        : Effect.fail(new Error(`could not create a gauntlet session: ${envelope.text}`))),
    ),
    deleteSession: (sessionId) => run(["session", "delete", sessionId], { timeoutMs: 30_000 }).pipe(Effect.ignore),
    status: fetchStatus,
    sessionTargets,
    ownerCdpPage: scopedOwnerCdpPage,
    note: (text) => { notes.push(text) },
    trackSession: (sessionId) => { createdSessionIds.add(sessionId) },
  }
}

/**
 * Every case gets an unowned attached tab, like a tab the user opened, so
 * `--target-url` selection and adoption run against a realistic pool. Cleanup
 * must cope with hostile fixtures: an adoption attempt can retire the raw
 * client's Page object, and closing a tab whose renderer is still blocked can
 * pop the browser's "page unresponsive" dialog and leave the tab open. So after
 * the ordinary close, the tab is looked up again by URL and closed through a
 * fresh connection once its main thread answers, within a bounded grace.
 */
const withUserTab = Effect.fnUntraced(function* <A>(run: (page: Page) => Effect.Effect<A, Error>, cleanupGraceMs: number) {
  let lastUrl = "about:blank"
  return yield* Effect.scoped(Effect.gen(function* () {
    const browser = yield* Effect.acquireRelease(
      playwright("connect over CDP", () => chromium.connectOverCDP(endpointUrl)),
      (connected: Browser) => boundedCleanup("close browser", () => connected.close()),
    )
    const context: BrowserContext = browser.contexts()[0] ?? (yield* playwright("create browser context", () => browser.newContext()))
    yield* playwright("register ARIA snapshot selector", () => registerAriaSnapshotSelector(context))
    const page = yield* playwright("create user tab", () => context.newPage())
    return yield* run(page).pipe(Effect.ensuring(Effect.gen(function* () {
      lastUrl = page.url()
      yield* boundedCleanup("close user tab", () => page.close(), 10_000)
    })))
  })).pipe(
    // Reconnect only after the original raw client is gone: a second concurrent
    // raw client during an adoption rollback can trip playwright-core's fatal
    // "Duplicate target" assertion.
    Effect.ensuring(Effect.suspend(() => lastUrl === "about:blank" ? Effect.void : closeLingeringUserTab(lastUrl, cleanupGraceMs))),
  )
})

const closeLingeringUserTab = Effect.fnUntraced(function* (url: string, graceMs: number) {
  const deadline = Date.now() + graceMs
  let reported = false
  yield* Effect.sleep("1500 millis")
  while (Date.now() < deadline) {
    const status = yield* fetchStatus().pipe(Effect.orElseSucceed(() => undefined))
    const lingering = status?.targets.find((target) => target.url === url)
    if (!lingering) return
    if (!reported) {
      reported = true
      yield* Console.log(`    user tab still open after close; waiting up to ${graceMs}ms for its renderer before closing it again`)
    }
    yield* Effect.scoped(Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        playwright("reconnect over CDP", () => chromium.connectOverCDP(endpointUrl)),
        (connected: Browser) => boundedCleanup("close reconnect browser", () => connected.close()),
      )
      const candidate = browser.contexts().flatMap((context) => context.pages()).find((candidatePage) => candidatePage.url() === url)
      if (!candidate) return
      const responsive = yield* Effect.promise(() => Promise.race([
        candidate.evaluate(() => true).then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]))
      if (responsive) yield* boundedCleanup("close lingering user tab", () => candidate.close(), 10_000)
    })).pipe(Effect.ignore)
    yield* Effect.sleep("1500 millis")
  }
  yield* Console.log(`    warning: user tab ${url} is still open after ${graceMs}ms; close it manually`)
})

const waitForRelayCleanup = Effect.fnUntraced(function* (leakCheck: { readonly createdSessionIds: ReadonlySet<string>; readonly fixtureOrigins: readonly string[] }) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = yield* fetchStatus()
    if (!resourceLeaks({ after: status, ...leakCheck })) return status
    yield* Effect.sleep("200 millis")
  }
  return yield* fetchStatus()
})

function printCaseResult(result: CaseRunResult): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Console.log(`${result.status.toUpperCase()} ${result.name}#${result.iteration} ${result.durationMs}ms / ${result.budgetMs}ms`)
    for (const note of result.notes) yield* Console.log(`    note: ${note}`)
    if (result.value !== undefined && process.env.GAUNTLET_VERBOSE) yield* Console.log(formatValue(result.value))
    if (result.error) yield* Console.error(indent(result.error))
  })
}

function renderTable(results: readonly CaseRunResult[]): string {
  const rows = results.map((result) => [
    repeatCount > 1 ? `${result.name}#${result.iteration}` : result.name,
    result.status,
    String(result.durationMs),
    String(result.budgetMs),
    [...result.notes, ...(result.error ? [result.error.split("\n")[0] ?? ""] : [])].join("; "),
  ])
  const header = ["case", "status", "ms", "budget", "note"]
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => Math.min(row[index]?.length ?? 0, index === 4 ? 96 : 40))))
  const line = (row: readonly string[]) => row.map((cell, index) => cell.slice(0, widths[index]).padEnd(widths[index] ?? 0)).join("  ").trimEnd()
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n")
}

export function summarize(results: readonly CaseRunResult[]) {
  return {
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    xfail: results.filter((result) => result.status === "xfail").length,
    unexpectedPass: results.filter((result) => result.status === "unexpected-pass").length,
    budgetExceeded: results.filter((result) => result.status === "budget-exceeded").length,
  }
}

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n")
}

function parseCaseFilter(value: string | undefined): Set<string> {
  if (!value) return new Set()
  return new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

// playwright-core asserts (for example a duplicate target announcement) throw
// from its event dispatcher and would otherwise kill the runner mid-table.
process.on("uncaughtException", (error) => {
  console.error(`gauntlet: uncaught exception from a browser connection was contained: ${formatError(error)}`)
})

if (import.meta.main) main().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
