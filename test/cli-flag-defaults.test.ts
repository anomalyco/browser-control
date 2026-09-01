import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type * as RelaySchema from "../src/relay-schema.ts"
import { browserControlBuildId, browserControlVersion } from "../src/version.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const session: RelaySchema.SessionSummary = {
  id: "cli-defaults",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  connected: true,
  pageUrl: null,
  stateKeys: [],
}
const routes = new Map<string, unknown>([
  ["GET /version", { version: browserControlVersion, buildId: browserControlBuildId } satisfies RelaySchema.RelayVersion],
  ["GET /extension/status", { connected: true, version: null, activeTargets: 0 } satisfies RelaySchema.ExtensionStatus],
  ["POST /cli/session/new", { session } satisfies RelaySchema.SessionContainer],
  ["POST /cli/execute", { text: "1", value: 1, isError: false, logs: [], session } satisfies RelaySchema.ExecuteResponse],
  ["POST /recording/start", { success: true } satisfies RelaySchema.RecordingStartResponse],
])
const requests: Array<{ route: string; body: unknown }> = []
let home: string
let port: number
const server = http.createServer((request, response) => {
  const route = `${request.method} ${request.url}`
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8")
    if (request.method === "POST") requests.push({ route, body: text ? JSON.parse(text) : undefined })
    response.writeHead(routes.has(route) ? 200 : 404, { "content-type": "application/json" })
    response.end(JSON.stringify(routes.get(route) ?? { error: `Unexpected route: ${route}` }))
  })
})

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "browser-control-cli-"))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected server address")
  port = address.port
})

beforeEach(() => {
  requests.length = 0
})

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    rm(home, { recursive: true, force: true }),
  ])
})

function runCli(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BROWSER_CONTROL_")))
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: packageRoot,
    env: { ...env, HOME: home, BROWSER_CONTROL_PORT: String(port), NO_COLOR: "1" },
    timeout: 10_000,
  })
}

describe("CLI opt-in boolean flags", () => {
  it.each([false, true])("execute accepts --json supplied=%s", async (json) => {
    const { stdout, stderr } = await runCli(["execute", ...(json ? ["--json"] : []), "return 1"])

    if (json) {
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, isError: false, text: "1", value: 1, valueUnavailable: false, session })
    } else {
      expect(stdout).toBe("1\n")
    }
    expect(stderr).toBe(`Session: ${session.id}. Continue with --session ${session.id}.\n`)
    expect(requests).toEqual([{ route: "POST /cli/execute", body: { code: "return 1", createIfMissing: true } }])
  })

  it.each([false, true])("session new accepts --read-only supplied=%s", async (readOnly) => {
    const { stdout, stderr } = await runCli(["session", "new", ...(readOnly ? ["--read-only"] : [])])

    expect(stdout).toBe(`${session.id}\n`)
    expect(stderr).toBe("")
    expect(requests).toEqual([{ route: "POST /cli/session/new", body: readOnly ? { readOnly: true } : {} }])
  })

  it.each([false, true])("recording start accepts --audio supplied=%s", async (audio) => {
    const outputPath = path.join(home, "recording.webm")
    const { stdout, stderr } = await runCli(["recording", "start", outputPath, ...(audio ? ["--audio"] : [])])

    expect(stdout).toContain(`Recording started: ${outputPath}`)
    expect(stderr).toBe("")
    expect(requests).toEqual([{ route: "POST /recording/start", body: { outputPath, audio } }])
  })
})
