#!/usr/bin/env tsx
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Clock, Config, Console, Effect, Option, type Scope } from "effect"
import fs from "node:fs"
import path from "node:path"
import cp from "node:child_process"
import { browserControlBuildId, browserControlVersion } from "../src/version.ts"
import { classifyCase, parseConfig, runPassed, summarize, type CaseRunResult } from "../gauntlet/report.ts"
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

const results: CaseRunResult[] = []
const startedAt = new Date().toISOString()
let reportPath: string | undefined
let verbose = false
let config: ReturnType<typeof parseConfig> | undefined
const metadata: Record<string, unknown> = { runtime: process.version, platform: process.platform, sourceBuildId: browserControlBuildId, sourceVersion: browserControlVersion }

function writeReport(error?: unknown) {
  if (!reportPath) return
  const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), ok: error === undefined && runPassed(results), config, metadata, results, summary: summarize(results), ...(error === undefined ? {} : { error: formatError(error) }) }
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true })
  const temporary = `${reportPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n")
  fs.renameSync(temporary, reportPath)
}

const main = Effect.fn("Gauntlet.main")(function* () {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--list") {
    yield* Console.log(cases.map((item) => `${item.name}${item.expectedFailure ? " (expected failure)" : ""}`).join("\n"))
    return
  }
  if (args.length === 1 && args[0] === "--help") {
    yield* Console.log("Gauntlet: [--help|--list]\nGAUNTLET_CASE=comma,separated,names GAUNTLET_REPEAT=1 GAUNTLET_WARMUP=0\nGAUNTLET_REPORT=report.json GAUNTLET_CLI=auto|source|installed|/path/to/cli.js\nGAUNTLET_PRIMARY_PORT / GAUNTLET_SECONDARY_PORT (distinct 1..65535)\nGAUNTLET_VERBOSE=0|1 BROWSER_CONTROL_ENDPOINT=http://127.0.0.1:19989\nWarmups are reported and must pass, but are excluded from summary statistics. p95 uses nearest rank.")
    return
  }
  const env: Record<string, string | undefined> = {}
  for (const key of ["GAUNTLET_REPORT", "GAUNTLET_CASE", "GAUNTLET_REPEAT", "GAUNTLET_WARMUP", "GAUNTLET_CLI", "GAUNTLET_PRIMARY_PORT", "GAUNTLET_SECONDARY_PORT", "GAUNTLET_VERBOSE", "BROWSER_CONTROL_ENDPOINT"]) {
    env[key] = Option.getOrUndefined(yield* Config.option(Config.String(key)))
  }
  reportPath = env.GAUNTLET_REPORT
  if (args.length) return yield* Effect.fail(new Error(`Unknown arguments: ${args.join(" ")}`))
  config = yield* Effect.try({
    try: () => parseConfig(env, cases.map((item) => item.name), { primaryPort: defaultPrimaryPort, secondaryPort: defaultSecondaryPort }),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  })
  const { repeatCount, warmupCount, primaryPort, secondaryPort, cliOverride, selected } = config
  verbose = config.verbose
  const selectedCases = cases.filter((testCase) => selected.includes(testCase.name))
  metadata.endpoint = endpointUrl
  try {
    metadata.sourceRevision = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim()
    metadata.sourceDirty = cp.execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", timeout: 5000 }).trim().length > 0
  } catch { /* Git metadata is optional in packaged runners. */ }

  yield* Console.log(`browser-control gauntlet: ${selectedCases.map((testCase) => testCase.name).join(", ")} x${repeatCount}`)
  const { cli, status: cliStatus } = yield* resolveCli(cliOverride)
  metadata.cli = cli
  metadata.relay = cliStatus?.relay
  metadata.browser = yield* Effect.tryPromise(async () => {
    const response = await fetch(new URL("/json/version", endpointUrl), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Browser version HTTP ${response.status}`)
    const version = await response.json() as Record<string, unknown>
    return { browser: version.Browser, protocolVersion: version["Protocol-Version"], userAgent: version["User-Agent"], v8Version: version["V8-Version"] }
  }).pipe(Effect.orElseSucceed(() => null))
  yield* Console.log(`cli: ${cli.describe}`)
  const initial = yield* fetchStatus()
  metadata.extension = { protocolVersion: initial.protocolVersion, protocolCompatible: initial.protocolCompatible }
  if (!initial.connected) return yield* Effect.fail(new Error(`Browser Control extension is not connected to ${endpointUrl}; open the browser with the extension loaded before running the gauntlet.`))
  yield* Console.log(`relay: ${endpointUrl} targets=${initial.activeTargets} cdpClients=${initial.cdpClients}`)

  yield* Effect.scoped(Effect.gen(function* () {
    const servers = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => startGauntletServers({ primaryPort, secondaryPort }), catch: (cause) => cause instanceof Error ? cause : new Error("start gauntlet fixture servers", { cause }) }),
      (running) => boundedCleanup("close fixture servers", () => running.close()),
    )
    yield* Console.log(`fixtures: ${servers.primaryOrigin} (primary), ${servers.secondaryOrigin} (secondary)`)
    const runs = [
      ...range(warmupCount).map((index) => ({ iteration: index + 1, warmup: true })),
      ...range(repeatCount).map((index) => ({ iteration: index + 1, warmup: false })),
    ].flatMap((run) => selectedCases.map((testCase) => ({ ...run, testCase })))
    return yield* Effect.forEach(
      runs,
      ({ testCase, iteration, warmup }) => runCase({ testCase, iteration, warmup, cli, servers }).pipe(Effect.scoped, Effect.tap((result) => Effect.sync(() => { results.push(result); delete metadata.activeCase })), Effect.tap(printCaseResult)),
      { concurrency: 1, discard: true },
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
  readonly warmup: boolean
  readonly cli: CliSelection
  readonly servers: GauntletServers
}): Effect.fn.Return<CaseRunResult, Error, Scope.Scope> {
  const { testCase, cli, servers } = options
  metadata.activeCase = { name: testCase.name, iteration: options.iteration, warmup: options.warmup }
  // This watchdog lives outside the case fiber: an uninterruptible teardown
  // cannot defeat it. The isolated parent then retires the owned relay/browser.
  const cleanupGraceMs = testCase.userTabCleanupGraceMs ?? 15_000
  const deadlineMs = testCase.budgetMs + cleanupGraceMs + 10_000
  yield* Effect.acquireRelease(
    Effect.sync(() => setTimeout(() => {
      throw new Error(`Gauntlet case ${testCase.name} exceeded its ${deadlineMs}ms hard deadline (including cleanup)`)
    }, deadlineMs)),
    (timer) => Effect.sync(() => clearTimeout(timer)),
  )
  const notes: string[] = []
  const createdSessionIds = new Set<string>()
  const ctx = makeContext({ cli, servers, notes, createdSessionIds })
  yield* Console.log(`--- ${testCase.name}#${options.iteration}: ${testCase.summary}`)
  yield* Console.log(`    fixture ${testCase.fixtureUrl(servers)} budget ${testCase.budgetMs}ms${testCase.expectedFailure ? " (expected failure)" : ""}`)
  const start = yield* Clock.currentTimeMillis
  // Case assertions throw synchronously inside generators; surface them as
  // typed failures so they are reported like any other case error.
  const attempt = withUserTab((page) => testCase.run(page, ctx), cleanupGraceMs).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect instanceof Error ? defect : new Error(`gauntlet case defect: ${formatValue(defect)}`))),
  )
  const outcome = yield* Effect.result(attempt)
  const end = yield* Clock.currentTimeMillis
  const durationMs = end - start
  const leakCheck = { createdSessionIds, fixtureOrigins: [servers.primaryOrigin, servers.secondaryOrigin] }
  const cleanup = yield* Effect.result(waitForRelayCleanup(leakCheck))
  const cleanupError = cleanup._tag === "Failure" ? formatError(cleanup.failure) : undefined
  const leaks = cleanup._tag === "Success" ? resourceLeaks({ after: cleanup.success, ...leakCheck }) : undefined
  const errors = [
    outcome._tag === "Failure" ? formatError(outcome.failure) : undefined,
    leaks ? `Gauntlet case leaked relay resources: ${leaks}` : undefined,
    cleanupError ? `Cleanup verification failed: ${cleanupError}` : undefined,
  ].filter((error) => error !== undefined)
  const status = classifyCase({ error: outcome._tag === "Failure" ? outcome.failure : undefined, leaks, cleanupError, expectedFailure: testCase.expectedFailure, durationMs, budgetMs: testCase.budgetMs })
  return {
    name: testCase.name,
    iteration: options.iteration,
    warmup: options.warmup,
    status,
    durationMs,
    budgetMs: testCase.budgetMs,
    ...(testCase.expectedFailure ? { expectedFailure: testCase.expectedFailure } : {}),
    notes,
    ...(outcome._tag === "Success" ? { value: outcome.success } : {}),
    ...(errors.length ? { error: errors.join("\n") } : {}),
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
    if (result.value !== undefined && verbose) yield* Console.log(formatValue(result.value))
    if (result.error) yield* Console.error(indent(result.error))
  })
}

function renderTable(results: readonly CaseRunResult[]): string {
  const rows = results.map((result) => [
    `${result.name}#${result.iteration}${result.warmup ? " (warmup)" : ""}`,
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

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n")
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

if (import.meta.main) {
  // Monitor records the fatal failure without suppressing Node's default exit.
  process.on("uncaughtExceptionMonitor", (error) => writeReport(error))
  main().pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => Effect.sync(() => writeReport(Cause.pretty(cause))).pipe(Effect.andThen(Effect.failCause(cause))),
      onSuccess: () => Effect.sync(() => writeReport()),
    }),
    Effect.provide(NodeServices.layer), NodeRuntime.runMain,
  )
}
