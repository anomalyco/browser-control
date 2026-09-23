#!/usr/bin/env tsx
import { Cause, Config, Effect, Exit, Option } from "effect"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { spawnOwned, waitForOwned, type OwnedProcess } from "../gauntlet/owned-process.ts"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const attempt = <A>(run: () => PromiseLike<A>) => Effect.tryPromise({
  try: run,
  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
})

const main = Effect.fn("Gauntlet.isolated")(function* () {
  const artifactsBase = yield* Config.string("GAUNTLET_ARTIFACT_DIR").pipe(Config.withDefault(path.join(os.tmpdir(), "browser-control-gauntlet")))
  const timeoutMs = yield* Config.int("GAUNTLET_TIMEOUT_MS").pipe(Config.withDefault(600_000))
  const headed = yield* Config.boolean("GAUNTLET_HEADED").pipe(Config.withDefault(false))
  const executable = yield* Config.option(Config.string("GAUNTLET_BROWSER_PATH"))
  if (timeoutMs < 1) return yield* Effect.fail(new Error("GAUNTLET_TIMEOUT_MS must be a positive integer"))
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
    const command = (label: string, args: readonly string[]) => Effect.scoped(Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => spawnOwned({ command: process.execPath, args, cwd: root, env, logPath: path.join(directory, `${label}.log`) })),
        stop,
      )
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
      const relay = yield* Effect.acquireRelease(
        Effect.sync(() => spawnOwned({ command: process.execPath, args: [path.join(runtime, "cli.js"), "serve"], cwd: root, env, logPath: path.join(directory, "relay.log") })),
        stop,
      )
      yield* attempt(() => waitForReady(endpoint, false, relay.child))
      phase = "browser-startup"
      // Own Chromium's process group directly so teardown does not depend on a
      // responsive renderer or an unbounded BrowserContext.close() promise.
      const browserPath = Option.isSome(executable) ? executable.value : chromium.executablePath()
      const browser = yield* Effect.acquireRelease(
        Effect.sync(() => spawnOwned({
          command: browserPath,
          args: [
            "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            "--disable-component-update", "--disable-default-apps", "--disable-sync",
            "--password-store=basic", "--use-mock-keychain", "--site-per-process",
            // Chromium's normal test-runner flags; only this synthetic profile is affected.
            ...(process.platform === "linux" ? ["--no-sandbox"] : []),
            ...(!headed ? ["--headless=new"] : []),
            "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${ports.browser}`,
            `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
            "about:blank",
          ],
          cwd: root, env, logPath: path.join(directory, "browser.log"),
        })),
        stop,
      )
      yield* attempt(() => Promise.race([
        waitForReady(endpoint, true, relay.child),
        browser.exit.then((code) => { throw new Error(`Owned Chromium exited during startup (${code}); inspect browser.log`) }),
      ]))
      const browserVersion = yield* attempt(async () => {
        const response = await fetch(`http://127.0.0.1:${ports.browser}/json/version`, { signal: AbortSignal.timeout(5_000) })
        const value: unknown = await response.json()
        if (!response.ok || typeof value !== "object" || value === null || !("Browser" in value) || typeof value.Browser !== "string") throw new Error("Chromium did not report its version")
        return value.Browser
      })
      yield* attempt(() => fs.writeFile(path.join(directory, "environment.json"), JSON.stringify({
        endpoint, browserVersion, node: process.version, platform: process.platform,
        architecture: process.arch, cli: env.GAUNTLET_CLI, relayPid: relay.child.pid,
        browserPid: browser.child.pid, browserPath, extensionPortOverride: ports.relay,
      }, null, 2)))
      console.log(`Ready: ${browserVersion}, private relay ${endpoint}`)
      setupMs = performance.now() - started
      phase = "cases"
      const runner = yield* Effect.acquireRelease(
        Effect.sync(() => spawnOwned({ command: process.execPath, args: ["--import", "tsx", "scripts/gauntlet.ts"], cwd: root, env, logPath: path.join(directory, "gauntlet.log"), echo: true })),
        stop,
      )
      const code = yield* attempt(() => Promise.race([
        waitForOwned(runner, timeoutMs),
        relay.exit.then((exitCode) => { throw new Error(`Owned relay exited during the run (${exitCode}); refusing to continue against a replacement`) }),
        browser.exit.then((exitCode) => { throw new Error(`Owned Chromium exited during the run (${exitCode})`) }),
      ]))
      if (code !== 0) return yield* Effect.fail(new Error(`Gauntlet failed (${code}); evidence retained at ${directory}`))
      yield* attempt(async () => {
        const result: unknown = JSON.parse(await fs.readFile(report, "utf8"))
        if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true ||
          !("results" in result) || !Array.isArray(result.results) || result.results.length === 0) {
          throw new Error("Gauntlet exited successfully without a successful nonempty result receipt")
        }
      })
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

/** Node adapter boundary: never inherit an agent's browser target or identity. */
function isolatedEnvironment(home: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("BROWSER_CONTROL_") || ["GAUNTLET_CLI", "GAUNTLET_PRIMARY_PORT", "GAUNTLET_SECONDARY_PORT", "GAUNTLET_REPORT"].includes(key)) delete env[key]
  }
  return { ...env, HOME: home, USERPROFILE: home, ...overrides }
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

async function waitForReady(endpoint: string, extension: boolean, child: import("node:child_process").ChildProcess): Promise<void> {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Owned relay exited during startup; inspect relay.log")
    try {
      const response = await fetch(new URL(extension ? "/extension/status" : "/version", endpoint), { signal: AbortSignal.timeout(1_000) })
      if (response.ok) {
        const value: unknown = await response.json()
        if (!extension && typeof value === "object" && value !== null && "pid" in value && value.pid === child.pid) return
        if (extension && typeof value === "object" && value !== null && "connected" in value && value.connected === true) return
      }
    } catch { /* Startup connection refusal is expected until our owned process binds. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${extension ? "Extension" : "Relay"} did not become ready at ${endpoint} within 30s`)
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
