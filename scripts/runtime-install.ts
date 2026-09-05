import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageName = "@opencode-ai/browser-control"
const markerName = ".browser-control-runtime.json"
const manifestSchema = Schema.Struct({ name: Schema.Literal(packageName), version: Schema.String })
const markerSchema = Schema.Struct({ format: Schema.Literal(1), version: Schema.String, digest: Schema.String })
const inputs = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.build.json",
  "src", "scripts", "extension/src", "extension/icons", "extension/manifest.json",
  "skills/browser-control/SKILL.md", "README.md", "LICENSE",
]
const exec = promisify(execFile)
const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
})

type RunCommand = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Effect.Effect<string, Error>

const runCommand: RunCommand = Effect.fn("RuntimeInstall.command")(function* (command, args, cwd, env) {
  const result = yield* Effect.tryPromise({
    try: (signal) => exec(command, args, {
      cwd, signal, timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
      env: env ?? { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
    }),
    catch: (cause) => new Error(`${command} ${args.join(" ")} failed in ${cwd}`, { cause }),
  })
  return result.stdout
})

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function freshPath(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error(`Use an absolute directory: ${value}`)
  const resolved = path.join(await fs.realpath(path.dirname(value)), path.basename(value))
  if (await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })) throw new Error(`Refusing to overwrite existing path: ${resolved}`)
  return resolved
}

async function digestInstall(install: string): Promise<string> {
  const hash = createHash("sha256")
  async function visit(relative: string): Promise<void> {
    const filename = path.join(install, relative)
    const stat = await fs.lstat(filename)
    hash.update(JSON.stringify([relative, stat.mode]))
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(filename)
      if (path.isAbsolute(link) || !contains(install, await fs.realpath(filename))) {
        throw new Error(`Install symlink escapes its directory: ${relative}`)
      }
      hash.update(JSON.stringify(link))
    } else if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(filename)).sort()) {
        if (relative === "" && entry === markerName) continue
        await visit(path.join(relative, entry))
      }
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error(`Install file is hard-linked: ${relative}`)
      hash.update(createHash("sha256").update(await fs.readFile(filename)).digest())
    } else {
      throw new Error(`Unsupported install entry: ${relative}`)
    }
  }
  await visit("")
  return hash.digest("hex")
}

const validateMcp = Effect.fn("RuntimeInstall.validateMcp")(function* (install: string, version: string, skill: string) {
  yield* attempt(async (signal) => {
    // This endpoint is deliberately not a relay and cannot serve browser work.
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ version, buildId: "runtime-validation", managed: false }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Fake endpoint did not bind")
      await new Promise<void>((resolve, reject) => {
        const child = spawn(path.join(install, "bin", "browser-control-mcp"), [], {
          cwd: install, signal, stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
            BROWSER_CONTROL_PORT: String(address.port), BROWSER_CONTROL_SESSION: "runtime-validation",
          },
        })
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP validation timed out")) }, 10_000)
        let output = ""
        let stderr = ""
        let complete = false
        const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`)
        child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-32_768) })
        child.stdin.on("error", reject)
        child.on("error", reject)
        child.on("close", () => {
          clearTimeout(timer)
          if (complete) resolve()
          else reject(new Error(`MCP validation exited early: ${stderr}`))
        })
        child.stdout.on("data", (chunk) => {
          output += String(chunk)
          if (output.length > 1_000_000) {
            child.kill("SIGKILL")
            reject(new Error("MCP validation output exceeded its bound"))
            return
          }
          while (output.includes("\n")) {
            const end = output.indexOf("\n")
            const line = output.slice(0, end)
            output = output.slice(end + 1)
            try {
              const message: unknown = JSON.parse(line)
              const envelope = Schema.decodeUnknownSync(Schema.Struct({
                id: Schema.optionalKey(Schema.Number),
                method: Schema.optionalKey(Schema.String),
              }))(message)
              if (envelope.id === undefined && envelope.method !== undefined) continue
              const response = Schema.decodeUnknownSync(Schema.Struct({
                id: Schema.optionalKey(Schema.Number),
                result: Schema.Unknown,
              }))(message)
              if (response.id === 1) {
                Schema.decodeUnknownSync(Schema.Struct({ serverInfo: Schema.Struct({
                  name: Schema.Literal("browser-control"), version: Schema.Literal(version),
                }) }))(response.result)
                send({ jsonrpc: "2.0", method: "notifications/initialized" })
                send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
              } else if (response.id === 2) {
                const result = Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }))(response.result)
                if (!result.tools.some((tool) => tool.name === "execute") || !result.tools.some((tool) => tool.name === "skill")) {
                  throw new Error("MCP tools missing")
                }
                send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "skill", arguments: {} } })
              } else if (response.id === 3) {
                const result = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })) }))(response.result)
                if (result.content.map((item) => item.text).join("").trim() !== skill.trim()) throw new Error("MCP skill differs from installed skill")
                complete = true
                child.kill("SIGKILL")
              }
            } catch (error) {
              child.kill("SIGKILL")
              reject(error)
            }
          }
        })
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runtime-validation", version: "1" },
        } })
      })
      if (requests.length === 0 || requests.some((request) => request !== "GET /version")) {
        throw new Error(`Unexpected MCP endpoint requests: ${requests.join(", ")}`)
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

const validatePnpmConsumer = Effect.fn("RuntimeInstall.validatePnpmConsumer")(function* (
  staging: string, archive: string, version: string, packageManager: string, run: RunCommand,
) {
  const consumer = yield* Effect.acquireRelease(
    attempt(() => fs.mkdtemp(path.join(path.dirname(staging), ".browser-control-pnpm-"))),
    (directory) => attempt(() => fs.rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
  )
  // No checkout lockfile, user config or overrides: resolve the packed runtime as a standalone consumer.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: consumer,
    XDG_CONFIG_HOME: path.join(consumer, "config"), XDG_DATA_HOME: path.join(consumer, "data"),
    XDG_CACHE_HOME: path.join(consumer, "cache"), XDG_STATE_HOME: path.join(consumer, "state"),
  }
  yield* attempt(async () => {
    await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", packageManager }), { flag: "wx" })
    await fs.writeFile(path.join(consumer, "pnpm-workspace.yaml"), "packages:\n  - .\n", { flag: "wx" })
  })
  yield* run("pnpm", ["add", "--workspace-root", "--prod", "--ignore-scripts", "--config.node-linker=isolated", archive], consumer, env)
  yield* run("node", ["--input-type=module", "--eval", String.raw`
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(realpathSync('./node_modules/${packageName}/package.json'))
const packed = require('./package.json')
assert.equal(packed.name, '${packageName}')
assert.equal(packed.version, ${JSON.stringify(version)})
const pins = packed.dependencies
assert.match(pins.effect, /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/, 'Effect must be exactly pinned')
for (const name of ['@effect/platform-node', '@effect/platform-node-shared']) {
  assert.equal(pins[name], pins.effect, name + ' must share the exact Effect pin')
  assert.equal(require(name + '/package.json').version, pins.effect, name + ' resolved version mismatch')
}
const node = createRequire(require.resolve('@effect/platform-node/NodeServices'))
const shared = createRequire(node.resolve('@effect/platform-node-shared/NodeFileSystem'))
assert.equal(node('@effect/platform-node-shared/package.json').version, pins.effect)
const runtimes = [require, node, shared]
for (const runtime of runtimes) assert.equal(runtime('effect/package.json').version, pins.effect)
assert.equal(new Set(runtimes.map(runtime => runtime.resolve('effect'))).size, 1, 'Multiple Effect runtimes')
const { BrowserControlClient, AuthenticatedOrigin, SecretProfile } = await import('${packageName}')
assert.ok(BrowserControlClient.Service && AuthenticatedOrigin.reveal && SecretProfile.run && SecretProfile.Error, 'SDK exports missing')
`], consumer, env)
  const cli = path.join(consumer, "node_modules", ".bin", "browser-control")
  if (!(yield* run(cli, ["--help"], consumer, env)).includes("browser-control")) return yield* Effect.fail(new Error("pnpm CLI help is missing"))
  if ((yield* run(cli, ["--version"], consumer, env)).trim() !== `browser-control v${version}`) return yield* Effect.fail(new Error("pnpm CLI version mismatch"))
}, Effect.scoped)

export const prepareRuntime = Effect.fn("RuntimeInstall.prepare")(function* (
  options: { readonly source: string; readonly staging: string; readonly install: string },
  run: RunCommand = runCommand,
) {
  const source = yield* attempt(() => fs.realpath(options.source))
  const staging = yield* attempt(() => freshPath(options.staging))
  const install = yield* attempt(() => freshPath(options.install))
  if (contains(source, staging) || contains(source, install) || contains(staging, install) || contains(install, staging)) {
    return yield* Effect.fail(new Error("Source, staging and install must be separate, non-overlapping directories"))
  }
  yield* attempt(async () => {
    await fs.mkdir(staging)
    await fs.mkdir(install)
    for (const input of inputs) {
      await fs.cp(path.join(source, input), path.join(staging, input), {
        recursive: true, errorOnExist: true, force: false,
        filter: async (filename) => {
          if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error(`Source input must not be a symlink: ${filename}`)
          return true
        },
      })
    }
  })
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
    ...manifestSchema.fields, packageManager: Schema.String,
  })))(
    yield* attempt(() => fs.readFile(path.join(staging, "package.json"), "utf8")),
  )
  yield* run("pnpm", ["install", "--frozen-lockfile"], staging)
  yield* run("pnpm", ["run", "build"], staging)
  yield* attempt(() => fs.mkdir(path.join(staging, "artifacts")))
  yield* run("npm", ["pack", "--ignore-scripts", "--pack-destination", path.join(staging, "artifacts")], staging)
  const archives = yield* attempt(() => fs.readdir(path.join(staging, "artifacts")))
  if (archives.length !== 1 || !archives[0]?.endsWith(".tgz")) return yield* Effect.fail(new Error("Expected one packed tarball"))
  const archive = path.join(staging, "artifacts", archives[0])
  yield* validatePnpmConsumer(staging, archive, manifest.version, manifest.packageManager, run)
  yield* attempt(() => fs.writeFile(path.join(install, "package.json"), '{"private":true,"type":"module"}\n', { flag: "wx" }))
  yield* run("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", archive], install)
  yield* attempt(() => fs.symlink("node_modules/.bin", path.join(install, "bin")))
  const installedPackage = path.join(install, "node_modules", packageName)
  const installed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(manifestSchema))(
    yield* attempt(() => fs.readFile(path.join(installedPackage, "package.json"), "utf8")),
  )
  if (installed.version !== manifest.version) return yield* Effect.fail(new Error("Installed version differs from source"))
  // Reject external links before executing anything from the installed package.
  yield* attempt(() => digestInstall(install))
  for (const [bin, target] of Object.entries({ "browser-control": "cli.js", "browser-control-mcp": "mcp.js" })) {
    const actual = yield* attempt(() => fs.realpath(path.join(install, "bin", bin)))
    if (actual !== path.join(installedPackage, "dist", target)) return yield* Effect.fail(new Error(`Unexpected bin target: ${actual}`))
  }
  const cli = path.join(install, "bin", "browser-control")
  const help = yield* run(cli, ["--help"], install)
  if (!help.includes("browser-control")) return yield* Effect.fail(new Error("CLI help is missing"))
  const version = yield* run(cli, ["--version"], install)
  if (version.trim() !== `browser-control v${manifest.version}`) return yield* Effect.fail(new Error("CLI version mismatch"))
  const skill = yield* attempt(() => fs.readFile(path.join(installedPackage, "skills", "browser-control", "SKILL.md"), "utf8"))
  if (!skill.trim() || (yield* run(cli, ["skill"], install)).trim() !== skill.trim()) return yield* Effect.fail(new Error("CLI skill mismatch"))
  yield* run("node", ["--input-type=module", "--eval", `import { BrowserControlClient, AuthenticatedOrigin, SecretProfile } from '${packageName}'; if (!BrowserControlClient.Service || !AuthenticatedOrigin.reveal || !SecretProfile.run || !SecretProfile.Error) throw new Error('SDK exports missing')`], install)
  const consumer = path.join(install, "validate-sdk.mts")
  yield* attempt(() => fs.writeFile(consumer, `import { BrowserControlClient, AuthenticatedOrigin, SecretProfile } from '${packageName}'\nvoid [BrowserControlClient.Service, AuthenticatedOrigin.reveal, SecretProfile.run, SecretProfile.Error]\n`, { flag: "wx" }))
  yield* run(path.join(staging, "node_modules", ".bin", "tsc"), [
    "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022", "--types", "node",
    "--typeRoots", path.join(staging, "node_modules", "@types"), consumer,
  ], install)
  yield* attempt(() => fs.unlink(consumer))
  yield* validateMcp(install, manifest.version, skill)
  const digest = yield* attempt(() => digestInstall(install))
  yield* attempt(() => fs.writeFile(path.join(install, markerName), JSON.stringify({ format: 1, version: manifest.version, digest }, null, 2) + "\n", { flag: "wx", mode: 0o600 }))
  return { install, staging, archive, version: manifest.version }
})

export const selectRuntime = Effect.fn("RuntimeInstall.select")(function* (options: { readonly install: string; readonly active: string }) {
  if (!path.isAbsolute(options.install) || !path.isAbsolute(options.active)) return yield* Effect.fail(new Error("Use absolute install and active paths"))
  const install = yield* attempt(() => fs.realpath(options.install))
  const active = path.join(yield* attempt(() => fs.realpath(path.dirname(options.active))), path.basename(options.active))
  if (contains(install, active)) return yield* Effect.fail(new Error("Active pointer must be outside the install"))
  const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(markerSchema))(
    yield* attempt(() => fs.readFile(path.join(install, markerName), "utf8")),
  )
  if (marker.digest !== (yield* attempt(() => digestInstall(install)))) return yield* Effect.fail(new Error("Install changed since validation; prepare a fresh candidate"))
  yield* attempt(async () => {
    const checkActive = async () => {
      const stat = await fs.lstat(active).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
      if (stat && !stat.isSymbolicLink()) throw new Error(`Refusing to overwrite non-symlink active path: ${active}`)
    }
    await checkActive()
    const temporary = path.join(path.dirname(active), `.${path.basename(active)}-${randomUUID()}`)
    await fs.symlink(install, temporary)
    try {
      await checkActive()
      await fs.rename(temporary, active)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  })
  return { install, active }
})

const command = Command.make("runtime").pipe(Command.withSubcommands([
  Command.make("prepare", {
    source: Flag.string("source").pipe(Flag.withDefault(root)),
    staging: Flag.string("staging").pipe(Flag.withDescription("Fresh absolute staging directory outside the checkout; parent must exist")),
    install: Flag.string("install").pipe(Flag.withDescription("Fresh absolute standalone install directory; parent must exist")),
  }, (options) => prepareRuntime(options).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))))),
  Command.make("select", {
    install: Flag.string("install").pipe(Flag.withDescription("Absolute directory of a validated candidate")),
    active: Flag.string("active").pipe(Flag.withDescription("Absolute shared symlink path; parent must exist")),
  },
    (options) => selectRuntime(options).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))))),
]))

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  command.pipe(Command.run({ version: "1" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
}
