import cp from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execFile = promisify(cp.execFile)

it("rejects invalid configuration before connecting and writes a failure report", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gauntlet-report-test-"))
  const report = path.join(directory, "nested", "report.json")
  try {
    await expect(execFile(process.execPath, ["--import", "tsx", "scripts/gauntlet.ts"], {
      timeout: 20_000,
      env: { ...process.env, GAUNTLET_CASE: "not-a-real-case", GAUNTLET_REPORT: report, BROWSER_CONTROL_ENDPOINT: "http://127.0.0.1:1" },
    })).rejects.toThrow()
    const parsed = JSON.parse(await fs.readFile(report, "utf8"))
    expect(parsed).toMatchObject({ schemaVersion: 1, ok: false, results: [], summary: { count: 0, medianMs: null, p95Ms: null } })
    expect(parsed.error.split("\n")[0]).toMatch(/^Error: Unknown gauntlet case\(s\): not-a-real-case\./)
    expect(parsed.metadata.sourceBuildId).toEqual(expect.any(String))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 25_000)

it("lists cases without requiring a running relay or valid run configuration", async () => {
  const result = await execFile(process.execPath, ["--import", "tsx", "scripts/gauntlet.ts", "--list"], {
    timeout: 20_000,
    env: { ...process.env, GAUNTLET_REPEAT: "invalid", BROWSER_CONTROL_ENDPOINT: "http://127.0.0.1:1" },
  })
  expect(result.stdout.split("\n")).toContain("stalled-main-world")
  expect(result.stdout).toContain("adopt-stalled-user-tab")
}, 25_000)

it("records an uncaught exception and retains Node's fatal exit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gauntlet-fatal-test-"))
  const report = path.join(directory, "report.json")
  const preload = path.join(directory, "fatal.mjs")
  try {
    await fs.writeFile(preload, `const timer = setInterval(() => {
      if (process.listenerCount('uncaughtExceptionMonitor') > 0) {
        clearInterval(timer)
        throw new Error('synthetic gauntlet uncaught exception')
      }
    }, 1)\n`)
    await expect(execFile(process.execPath, ["--import", "tsx", "--import", preload, "scripts/gauntlet.ts"], {
      timeout: 20_000,
      env: { ...process.env, GAUNTLET_CASE: "stalled-main-world", GAUNTLET_REPEAT: "1", GAUNTLET_CLI: path.join(directory, "missing-cli.js"), GAUNTLET_REPORT: report, BROWSER_CONTROL_ENDPOINT: "http://127.0.0.1:1" },
    })).rejects.toThrow()
    const parsed = JSON.parse(await fs.readFile(report, "utf8"))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain("synthetic gauntlet uncaught exception")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 25_000)
