#!/usr/bin/env tsx
import { Cause, Config, Effect, Exit, Option, Schema } from "effect"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { cases } from "../gauntlet/cases.ts"
import { failOnExit, spawnOwned, waitForOwned, type OwnedProcess } from "../gauntlet/owned-process.ts"
import { parseConfig } from "../gauntlet/report.ts"
import { defaultPrimaryPort, defaultSecondaryPort } from "../gauntlet/server.ts"
import { ExtensionStatus, RelayVersion } from "../src/relay-schema.ts"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const attempt = <A>(run: () => PromiseLike<A>) => Effect.tryPromise({
  try: run,
  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
})

const main = Effect.fn("Gauntlet.isolated")(function* () {
  const artifactsBase = yield* Config.String("GAUNTLET_ARTIFACT_DIR").pipe(Config.withDefault(path.join(os.tmpdir(), "browser-control-gauntlet")))
  const timeoutMs = yield* Config.Int("GAUNTLET_TIMEOUT_MS").pipe(Config.withDefault(600_000))
  const headed = yield* Config.Boolean("GAUNTLET_HEADED").pipe(Config.withDefault(false))
  const executable = yield* Config.option(Config.String("GAUNTLET_BROWSER_PATH"))
  if (timeoutMs < 1) return yield* Effect.fail(new Error("GAUNTLET_TIMEOUT_MS must be a positive integer"))
  // Reject case selection typos before paying for a build and a browser launch.
  yield* Effect.try({
    try: () => parseConfig(
      { GAUNTLET_CASE: process.env.GAUNTLET_CASE, GAUNTLET_REPEAT: process.env.GAUNTLET_REPEAT, GAUNTLET_WARMUP: process.env.GAUNTLET_WARMUP, GAUNTLET_VERBOSE: process.env.GAUNTLET_VERBOSE },
      cases.map((testCase) => testCase.name),
      { primaryPort: defaultPrimaryPort, secondaryPort: defaultSecondaryPort },
    ),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  })
  yield* attempt(() => fs.mkdir(artifactsBase, { recursive: true }))
  const directory = yield* attempt(() => fs.mkdtemp(path.join(artifactsBase, "run-")))
  const home = path.join(directory, "home")
  const profile = path.join(directory, "profile")
  const runtime = path.join(directory, "runtime")
  const extension = path.join(directory, "extension")
  const report = path.join(directory, "report.json")
  console.log(`Isolated gauntlet evidence: ${directory}`)
  const startedAt = new Date().toISOString()
  const started = performance.now()
  let phase = "build"
  let setupMs: number | undefined
  let cleanupFailed = false
  const stop = (owned: OwnedProcess) => Effect.promise(async () => {
    try {
      await owned.stop()
    } catch (error) {
      cleanupFailed = true
      throw error
    }
  })
  yield* Effect.gen(function* () {
    yield* attempt(() => fs.mkdir(home, { recursive: true, mode: 0o700 }))

    // Bind ports together to avoid selecting the same ephemeral port twice.
    // A contender winning after release makes startup fail; we never replace it.
    const ports = yield* attempt(reservePorts)
    const endpoint = `http://127.0.0.1:${ports.relay}`
    const env = isolatedEnvironment(home, {
      BROWSER_CONTROL_ENDPOINT: endpoint,
      BROWSER_CONTROL_PORT: String(ports.relay),
      BROWSER_CONTROL_AUTOSTART: "false",
      GAUNTLET_CLI: path.join(runtime, "cli.js"),
      GAUNTLET_PRIMARY_PORT: String(ports.primary),
      GAUNTLET_SECONDARY_PORT: String(ports.secondary),
      GAUNTLET_REPORT: report,
    })
    const own = (label: string, command: string, args: readonly string[], echo = false) => Effect.acquireRelease(
      Effect.sync(() => spawnOwned({ command, args, cwd: root, env, logPath: path.join(directory, `${label}.log`), echo })),
      stop,
    )
    const command = (label: string, args: readonly string[]) => Effect.scoped(Effect.gen(function* () {
      const child = yield* own(label, process.execPath, args)
      const code = yield* attempt(() => waitForOwned(child, 120_000))
      if (code !== 0) return yield* Effect.fail(new Error(`${label} failed (${code}); see ${directory}/${label}.log`))
    }))

    yield* command("build-cli", ["--import", "tsx", "scripts/build-cli.ts", "--outdir", runtime])
    yield* attempt(() => fs.symlink(path.join(root, "node_modules"), path.join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir"))
    yield* attempt(() => fs.writeFile(path.join(runtime, "package.json"), '{"type":"module"}\n'))
    yield* command("build-extension", ["--import", "tsx", "scripts/build-extension.ts", "--outdir", extension])
    // The installed extension always uses its fixed production port. Change only
    // the copied test artifact, exactly as the debugger-ownership proof does.
    yield* attempt(async () => {
      const background = path.join(extension, "background.js")
      const source = await fs.readFile(background, "utf8")
      const declaration = "var relayPort = 19989;"
      if (source.split(declaration).length !== 2) throw new Error("Cannot identify the isolated shim's relay port; refusing to launch it")
      await fs.writeFile(background, source.replace(declaration, `var relayPort = ${ports.relay};`))
    })

    yield* Effect.scoped(Effect.gen(function* () {
      phase = "relay-startup"
      const relay = yield* own("relay", process.execPath, [path.join(runtime, "cli.js"), "serve"])
      yield* attempt(() => waitForReady(endpoint, relay.child, "/version", (body) => Schema.decodeUnknownOption(RelayVersion)(body).pipe(Option.exists((version) => version.pid === relay.child.pid))))
      phase = "browser-startup"
      // Own Chromium's process group directly so teardown does not depend on a
      // responsive renderer or an unbounded BrowserContext.close() promise.
      const browserPath = Option.isSome(executable) ? executable.value : chromium.executablePath()
      const browser = yield* own("browser", browserPath, [
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--disable-sync",
        "--password-store=basic", "--use-mock-keychain", "--site-per-process",
        // Chromium's normal test-runner flags; only this synthetic profile is affected.
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        ...(!headed ? ["--headless=new"] : []),
        "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${ports.browser}`,
        `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "about:blank",
      ])
      yield* attempt(() => Promise.race([
        waitForReady(endpoint, relay.child, "/extension/status", (body) => Schema.decodeUnknownOption(ExtensionStatus)(body).pipe(Option.exists((status) => status.connected))),
        failOnExit(browser, (code) => `Owned Chromium exited during startup (${code}); inspect browser.log`),
      ]))
      const browserVersion = yield* attempt(async () => {
        const response = await fetch(`http://127.0.0.1:${ports.browser}/json/version`, { signal: AbortSignal.timeout(5_000) })
        const version = Schema.decodeUnknownOption(ChromiumVersion)(await response.json())
        if (!response.ok || Option.isNone(version)) throw new Error("Chromium did not report its version")
        return version.value.Browser
      })
      yield* attempt(() => fs.writeFile(path.join(directory, "environment.json"), JSON.stringify({
        endpoint, browserVersion, node: process.version, platform: process.platform,
        architecture: process.arch, cli: env.GAUNTLET_CLI, relayPid: relay.child.pid,
        browserPid: browser.child.pid, browserPath, extensionPortOverride: ports.relay,
      }, null, 2)))
      console.log(`Ready: ${browserVersion}, private relay ${endpoint}`)
      setupMs = performance.now() - started
      phase = "cases"
      const runner = yield* own("gauntlet", process.execPath, ["--import", "tsx", "scripts/gauntlet.ts"], true)
      const code = yield* attempt(() => Promise.race([
        waitForOwned(runner, timeoutMs),
        failOnExit(relay, (exitCode) => `Owned relay exited during the run (${exitCode}); refusing to continue against a replacement`),
        failOnExit(browser, (exitCode) => `Owned Chromium exited during the run (${exitCode})`),
      ]))
      if (code !== 0) return yield* Effect.fail(new Error(`Gauntlet failed (${code}); evidence retained at ${directory}`))
      const receipt = yield* attempt(async () => JSON.parse(await fs.readFile(report, "utf8")) as unknown)
      if (!Schema.is(SuccessfulReceipt)(receipt)) {
        return yield* Effect.fail(new Error("Gauntlet exited successfully without a successful nonempty result receipt"))
      }
      phase = "cleanup"
    }))
  }).pipe(Effect.onExit((exit) => attempt(async () => {
    let cleanupError: unknown
    if (!cleanupFailed) {
      try {
        await fs.rm(profile, { recursive: true, force: true })
        await fs.rm(home, { recursive: true, force: true })
      } catch (error) {
        cleanupFailed = true
        cleanupError = error
      }
    }
    // The outer receipt exists even if build, browser launch, or the case process fails.
    await fs.writeFile(path.join(directory, "run.json"), JSON.stringify({
      schemaVersion: 1, startedAt, durationMs: Math.round(performance.now() - started),
      setupMs: setupMs === undefined ? null : Math.round(setupMs),
      outcome: Exit.isSuccess(exit) && !cleanupFailed ? "pass" : "fail", phase,
      cleanupVerified: !cleanupFailed,
      ...(cleanupError === undefined ? {} : { cleanupError: String(cleanupError) }),
      ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
      report,
    }, null, 2), { mode: 0o600 })
    if (cleanupError !== undefined) throw cleanupError
  }).pipe(Effect.orDie)))
  console.log(`PASS isolated gauntlet; report ${report}`)
})

const ChromiumVersion = Schema.Struct({ Browser: Schema.String })
const SuccessfulReceipt = Schema.Struct({ ok: Schema.Literal(true), results: Schema.NonEmptyArray(Schema.Unknown) })

/** Node adapter boundary: never inherit an agent's browser target or identity. */
function isolatedEnvironment(home: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("BROWSER_CONTROL_"))
  return { ...Object.fromEntries(inherited), HOME: home, USERPROFILE: home, ...overrides }
}

async function reservePorts(): Promise<{ relay: number; primary: number; secondary: number; browser: number }> {
  const servers: net.Server[] = []
  const port = async () => {
    const server = net.createServer()
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No ephemeral port allocated")
    return address.port
  }
  try {
    return { relay: await port(), primary: await port(), secondary: await port(), browser: await port() }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  }
}

async function waitForReady(endpoint: string, relay: ChildProcess, route: string, ready: (body: unknown) => boolean): Promise<void> {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (relay.exitCode !== null || relay.signalCode !== null) throw new Error("Owned relay exited during startup; inspect relay.log")
    try {
      const response = await fetch(new URL(route, endpoint), { signal: AbortSignal.timeout(1_000) })
      if (response.ok && ready(await response.json())) return
    } catch { /* Startup connection refusal is expected until our owned process binds. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${endpoint}${route} did not become ready within 30s`)
}

if (import.meta.main) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    await Effect.runPromise(main(), { signal: controller.signal })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
}
