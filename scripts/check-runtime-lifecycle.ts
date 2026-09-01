import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Console, Effect, Schedule, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocket } from "ws"
import { parseExtensionCommand } from "../src/protocol.ts"
import * as RelayClient from "../src/relay-client.ts"
import { RelayLifecycleEvent } from "../src/relay-lifecycle-log.ts"
import { ExtensionStatus, RelayVersion, SessionsContainer } from "../src/relay-schema.ts"
import { defaultSessionCatalogPath, SessionCatalog } from "../src/session-catalog.ts"

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
})
const wait = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.retry({ times: 160, schedule: Schedule.spaced("50 millis") }), Effect.timeout("15 seconds"),
)
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text)
const identity = RelayVersion.pipe(Schema.fieldsAssign({
  instanceId: Schema.String, buildId: Schema.String, pid: Schema.Number,
  managed: Schema.Literal(true), shutdownProtocol: Schema.Literal(2),
}))
const fixtureSession = "lifecycle-adopted"
const targetInfo = { targetId: "lifecycle-target", type: "page", title: "Synthetic lifecycle fixture", url: "https://lifecycle.invalid/", attached: true, canAccessOpener: false }
const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
type Child = { child: ChildProcessWithoutNullStreams; closed: Promise<number | null>; managed: boolean; output: () => { stdout: string; stderr: string } }

const artifact = Effect.fn("LifecycleCheck.artifact")(function* (prefix: string) {
  return yield* attempt(async () => {
    assert(path.isAbsolute(prefix), "Use an absolute standalone install prefix")
    assert(!(await fs.lstat(prefix)).isSymbolicLink(), "Use the install directory, not an active-install symlink")
    const directory = await fs.realpath(prefix)
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    assert(directory !== root && !directory.startsWith(`${root}${path.sep}`), "Install must be outside the checkout")
    const marker = decode(Schema.Struct({ format: Schema.Literal(1), version: Schema.String, digest: Schema.String }), await fs.readFile(path.join(directory, ".browser-control-runtime.json"), "utf8"))
    const pkg = path.join(directory, "node_modules/@opencode-ai/browser-control")
    const manifest = decode(Schema.Struct({ name: Schema.Literal("@opencode-ai/browser-control"), version: Schema.String }), await fs.readFile(path.join(pkg, "package.json"), "utf8"))
    assert.equal(manifest.version, marker.version)
    for (const entry of ["cli.js", "mcp.js"]) assert.equal(await fs.realpath(path.join(pkg, "dist", entry)), path.join(pkg, "dist", entry))
    return { cli: path.join(pkg, "dist/cli.js"), mcp: path.join(pkg, "dist/mcp.js"), version: manifest.version }
  })
})

// Binding also proves absence during cleanup; never discover or signal a port's PID.
const bindAndRelease = (port: number) => attempt(() => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.once("error", reject)
  server.listen(port, "127.0.0.1", () => {
    const address = server.address()
    server.close((error) => {
      if (error) reject(error)
      else if (!address || typeof address === "string") reject(new Error("Missing fixture TCP address"))
      else resolve(address.port)
    })
  })
}))

const check = Effect.fn("LifecycleCheck.run")(function* (options: { previous: string; candidate: string }) {
  assert(!process.versions.bun, "Run this script with Node/tsx so installed artifacts use absolute-path Node")
  const [previous, candidate] = yield* Effect.all([artifact(options.previous), artifact(options.candidate)])
  assert.notEqual(previous.cli, candidate.cli, "Prepare two independent installs")
  const port = yield* bindAndRelease(0)
  assert.notEqual(port, 19989, "Never use the production relay port")
  const scratch = path.join(os.tmpdir(), "opencode")
  yield* attempt(() => fs.mkdir(scratch, { recursive: true }))
  const home = yield* attempt(() => fs.mkdtemp(path.join(scratch, "bc-lifecycle-")))
  const env = {
    HOME: home, USERPROFILE: home, PATH: path.join(home, "bin"), TMPDIR: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
    BROWSER_CONTROL_PORT: String(port), BROWSER_CONTROL_EXTENSION_ORIGINS: origin, NO_COLOR: "1",
  }
  const relay = yield* RelayClient.make({ endpoint: RelayClient.endpointForPort(port) }).pipe(
    Effect.provide(FetchHttpClient.layer), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  )
  const catalog = new SessionCatalog(defaultSessionCatalogPath(port, home))
  const log = path.join(path.dirname(catalog.filePath), "lifecycle.jsonl")
  const events = () => attempt(async () => {
    assert((await fs.stat(log)).size <= 256_000, "Fixture lifecycle log exceeded its bound")
    const text = await fs.readFile(log, "utf8")
    return text.trim().split("\n").map((line) => decode(RelayLifecycleEvent, line))
  })
  const children: Child[] = []
  const sockets: WebSocket[] = []
  const forbidden: string[] = []
  let adapterError: Error | undefined
  function launch(entry: string, args: string[], managed = false): Child {
    const child = spawn(process.execPath, [entry, ...args], { cwd: home, env: { ...env, ...(managed ? { BROWSER_CONTROL_MANAGED_RELAY: "1" } : {}) }, stdio: "pipe" })
    let stdout = "", stderr = ""
    child.stdout.on("data", (data) => { stdout = (stdout + String(data)).slice(-32_768) })
    child.stderr.on("data", (data) => { stderr = (stderr + String(data)).slice(-32_768) })
    child.on("error", (error) => { stderr = (stderr + error.message).slice(-32_768) })
    child.stdin.on("error", () => {})
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve))
    const result = { child, closed, managed, output: () => ({ stdout, stderr }) }
    children.push(result)
    return result
  }
  const run = Effect.fn("LifecycleCheck.command")(function* (entry: string, args: string[]) {
    const process = launch(entry, args)
    const code = yield* attempt(() => process.closed).pipe(Effect.timeout("20 seconds"))
    return { code, ...process.output() }
  })
  // A failed cleanup retains HOME. Only fixture-recorded identities receive shutdown.
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    for (const process of children.filter((item) => !item.managed)) {
      if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM")
      yield* attempt(() => process.closed).pipe(Effect.timeout("5 seconds"))
    }
    const current = yield* Effect.result(relay.version.pipe(Effect.timeout("3 seconds")))
    if (current._tag === "Success") {
      const owned = yield* Schema.decodeUnknownEffect(identity)(current.success)
      assert((yield* events()).some((event) => event._tag === "Ready" && event.instanceId === owned.instanceId), "Refusing to shut down an unowned listener")
      yield* relay.shutdown({ instanceId: owned.instanceId, requestId: randomUUID(), reason: "explicit-restart", client: { kind: "sdk", instanceId: randomUUID(), buildId: owned.buildId } }).pipe(Effect.timeout("15 seconds"))
    } else if (!(current.failure instanceof RelayClient.RelayUnreachable)) {
      return yield* Effect.fail(new Error("Cannot identify fixture relay for safe cleanup"))
    }
    for (const process of children.filter((item) => item.managed)) {
      // A directly spawned serve may have failed before publishing its identity.
      if (current._tag === "Failure" && process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM")
      yield* attempt(() => process.closed).pipe(Effect.timeout("5 seconds"))
    }
    yield* wait(bindAndRelease(port))
    assert.deepEqual(forbidden, [], "Lifecycle sent destructive extension commands")
    if (adapterError) throw adapterError
    yield* attempt(() => fs.rm(home, { recursive: true }))
  }).pipe(
    Effect.tapCause(() => Console.error(`Cleanup failed; fixture retained at ${home}`)), Effect.orDie,
    Effect.ensuring(Effect.sync(() => { for (const socket of sockets) socket.terminate() })),
  ))

  const connectExtension = Effect.fn("LifecycleCheck.extension")(function* () {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin })
    sockets.push(socket)
    socket.on("error", (error) => { adapterError = error })
    socket.on("message", (data) => {
      try {
        const command = parseExtensionCommand(data.toString())
        if (["tabs.remove", "debugger.detach", "tabs.create", "runtime.reload"].includes(command.method)) forbidden.push(command.method)
        const result = command.method === "debugger.sendCommand" && command.params?.method === "Target.getTargetInfo" ? { targetInfo } : {}
        socket.send(JSON.stringify({ id: command.id, result }))
      } catch (cause) { adapterError = cause instanceof Error ? cause : new Error(String(cause)) }
    })
    yield* attempt(() => new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })).pipe(Effect.timeout("5 seconds"))
    socket.send(JSON.stringify({ method: "hello", params: { version: "lifecycle-fixture", protocolVersion: 2 } }))
    socket.send(JSON.stringify({ method: "debugger.attached", params: { tabId: 1 } }))
    socket.send(JSON.stringify({ method: "ready" }))
    yield* wait(relay.extensionStatus.pipe(Effect.flatMap((status) => Effect.try(() => {
      assert(status.connected && status.protocolCompatible === true && status.protocolVersion === 2)
      assert.equal(status.targets?.length, 1)
      const target = status.targets[0]
      assert(target && target.id === targetInfo.targetId && target.tabId === 1 && target.owner === "user" && target.browserControlSessionId === fixtureSession)
    }))))
    return socket
  })
  const mcpStatus = Effect.fn("LifecycleCheck.mcp")(function* () {
    const process = launch(candidate.mcp, [])
    const result = yield* attempt(() => new Promise<unknown>((resolve, reject) => {
      let buffer = ""
      const send = (message: unknown) => process.child.stdin.write(`${JSON.stringify(message)}\n`)
      process.closed.then(() => reject(new Error("MCP exited before status response")))
      process.child.stdout.on("data", (data) => {
        buffer += String(data)
        try {
          assert(buffer.length <= 65_536, "MCP output exceeded fixture bound")
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n"), line = buffer.slice(0, end)
            buffer = buffer.slice(end + 1)
            const response = decode(Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.optionalKey(Schema.Number), result: Schema.optionalKey(Schema.Unknown), error: Schema.optionalKey(Schema.Unknown) }), line)
            assert.equal(response.error, undefined, "MCP returned a protocol error")
            if (response.id === 1) {
              Schema.decodeUnknownSync(Schema.Struct({ protocolVersion: Schema.Literal("2025-06-18"), serverInfo: Schema.Struct({ name: Schema.Literal("browser-control"), version: Schema.Literal(candidate.version) }), capabilities: Schema.Struct({ tools: Schema.Unknown }) }))(response.result)
              send({ jsonrpc: "2.0", method: "notifications/initialized" })
              send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
            } else if (response.id === 2) {
              const tools = Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }))(response.result)
              assert(tools.tools.some((tool) => tool.name === "status"))
              send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } })
            } else if (response.id === 3) resolve(response.result)
          }
        } catch (error) { reject(error) }
      })
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lifecycle-fixture", version: "1" } } })
    })).pipe(Effect.timeout("15 seconds"))
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ isError: Schema.optionalKey(Schema.Literal(false)), structuredContent: Schema.Struct({ version: identity, status: ExtensionStatus, buildProblem: Schema.String }) }))(result)
    process.child.kill("SIGTERM")
    yield* attempt(() => process.closed).pipe(Effect.timeout("5 seconds"))
    return decoded.structuredContent
  })

  return yield* Effect.gen(function* () {
    yield* attempt(async () => { for (const directory of [env.PATH, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) await fs.mkdir(directory) })
    const timestamp = new Date().toISOString()
    // Synthetic catalog restoration only: no Playwright connection or real browser adoption.
    yield* attempt(() => catalog.save([{ id: fixtureSession, createdAt: timestamp, updatedAt: timestamp, readOnly: true, target: { id: targetInfo.targetId, owner: "user" } }]))
    const serve = launch(previous.cli, ["serve"], true)
    const before = yield* wait(relay.version.pipe(Effect.flatMap(Schema.decodeUnknownEffect(identity))))
    assert.equal(before.pid, serve.child.pid, "Fixture port was claimed by another process")
    assert.equal(before.version, previous.version)
    const oldSocket = yield* connectExtension()
    const oldClosed = new Promise<void>((resolve) => oldSocket.once("close", () => resolve()))
    const ordinary = yield* run(candidate.cli, ["session", "list", "--json"])
    assert.notEqual(ordinary.code, 0, "Different-build ordinary CLI must refuse work")
    assert.match(ordinary.stdout + ordinary.stderr, /does not match CLI build/)
    assert.equal((yield* relay.version).instanceId, before.instanceId)
    const status = yield* mcpStatus()
    assert.equal(status.version.instanceId, before.instanceId)
    assert(status.status.connected)
    assert.equal((yield* relay.version).instanceId, before.instanceId)
    assert.equal((yield* events()).filter((event) => event._tag === "Requested").length, 0)

    const restarted = yield* run(candidate.cli, ["relay", "restart"])
    assert.equal(restarted.code, 0, restarted.stderr.slice(-4_096))
    yield* attempt(() => oldClosed).pipe(Effect.timeout("5 seconds"))
    yield* attempt(() => serve.closed).pipe(Effect.timeout("5 seconds"))
    const after = yield* wait(relay.version.pipe(Effect.flatMap(Schema.decodeUnknownEffect(identity))))
    assert.notEqual(after.instanceId, before.instanceId)
    assert.equal(after.version, candidate.version)
    assert(Date.parse(after.buildId) > Date.parse(before.buildId), "Candidate must be a strictly later ordered build")
    const audit = yield* events()
    const request = audit.find((event) => event._tag === "Requested")
    assert(request?._tag === "Requested" && request.instanceId === before.instanceId && request.client.kind === "cli" && request.client.buildId === after.buildId)
    assert(audit.some((event) => event._tag === "Stopping" && event.instanceId === before.instanceId && event.requestId === request.requestId))
    assert(audit.some((event) => event._tag === "Ready" && event.instanceId === after.instanceId && event.restartRequestId === request.requestId))
    yield* connectExtension()
    const listed = yield* run(candidate.cli, ["session", "list", "--json"])
    assert.equal(listed.code, 0, listed.stderr.slice(-4_096))
    const sessions = decode(SessionsContainer, listed.stdout).sessions
    assert.equal(sessions.length, 1)
    assert(sessions[0]?.id === fixtureSession && sessions[0].readOnly === true)
    assert.deepEqual((yield* attempt(() => catalog.load()))[0]?.target, { id: targetInfo.targetId, owner: "user" })
    const downgrade = yield* run(previous.cli, ["relay", "restart"])
    assert.notEqual(downgrade.code, 0)
    assert.match(downgrade.stdout + downgrade.stderr, /Refusing to downgrade/)
    assert.equal((yield* relay.version).instanceId, after.instanceId)
    assert.equal((yield* events()).filter((event) => event._tag === "Requested").length, 1)
    return `PASS: installed-artifact lifecycle mechanism test (${before.buildId} -> ${after.buildId}). Synthetic adopted-target restoration only; not cross-release compatibility or real browser adoption proof.`
  }).pipe(Effect.tapCause(() => Console.error(`Fixture diagnostics (${home}):\n${children.map((child) => child.output().stderr.slice(-2_048)).join("\n").slice(-8_192)}`)))
})

Command.make("check-runtime-lifecycle", {
  previous: Flag.string("previous").pipe(Flag.withDescription("Absolute standalone install prefix; requires shutdown protocol 2")),
  candidate: Flag.string("candidate").pipe(Flag.withDescription("Absolute standalone install prefix with a strictly later build id")),
}, (options) => check(options).pipe(Effect.scoped, Effect.flatMap(Console.log))).pipe(
  Command.run({ version: "1" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain,
)
