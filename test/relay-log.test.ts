import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { appendManagedRelayProcessLog, managedRelayLogPath } from "../src/relay-log.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("managed relay process log", () => {
  it("repairs permissions and bounds retained process-fault diagnostics", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-relay-log-"))
    temporaryDirectories.push(home)
    const logPath = managedRelayLogPath(home)
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o755 })
    fs.writeFileSync(logPath, "x".repeat(999_990), { mode: 0o644 })

    appendManagedRelayProcessLog("fatal relay failure", home)

    expect(fs.readFileSync(logPath, "utf8")).toContain("fatal relay failure")
    expect(fs.statSync(logPath).size).toBeLessThan(100_000)
    expect(fs.statSync(path.dirname(logPath)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
  })
})
