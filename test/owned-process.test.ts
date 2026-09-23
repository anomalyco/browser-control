import { describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnOwned, waitForOwned } from "../gauntlet/owned-process.ts"

describe("isolated gauntlet process containment", () => {
  it.skipIf(process.platform === "win32").each(["normal exit", "SIGTERM exit"])("retires redirected descendants after leader %s", async (mode) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bc-owned-tree-"))
    const ready = path.join(directory, "descendant.pid")
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`
    const leader = `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
      child.unref();
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(ready)})) return;
        clearInterval(timer);
        ${mode === "normal exit" ? "process.exit(0)" : "setInterval(() => {}, 1000)"};
      }, 10);
    `
    const owned = spawnOwned({ command: process.execPath, args: ["-e", leader], cwd: directory, env: {}, logPath: path.join(directory, "leader.log") })
    let descendantPid: number | undefined
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try { descendantPid = Number(await fs.readFile(ready, "utf8")); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
      }
      expect(descendantPid).toBeGreaterThan(0)
      if (mode === "normal exit") expect(await waitForOwned(owned, 5_000)).toBe(0)
      else await owned.stop()
      expect(() => process.kill(descendantPid!, 0)).toThrow()
      expect(() => process.kill(-owned.child.pid!, 0)).toThrow()
      // Repeated finalization must not signal a retired process-group identity.
      await owned.stop()
    } finally {
      // Independent of the implementation under test, including failed assertions.
      if (owned.child.pid) {
        try { process.kill(-owned.child.pid, "SIGKILL") } catch { /* already retired */ }
      }
      await owned.exit
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it("retains a nonzero exit and its evidence", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bc-owned-process-"))
    const logPath = path.join(directory, "child.log")
    try {
      const child = spawnOwned({ command: process.execPath, args: ["-e", "console.error('synthetic failure'); process.exitCode = 7"], cwd: directory, env: {}, logPath })
      expect(await waitForOwned(child, 5_000)).toBe(7)
      expect(await fs.readFile(logPath, "utf8")).toContain("synthetic failure")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("kills and awaits its owned child when a command never settles", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bc-owned-process-"))
    const child = spawnOwned({ command: process.execPath, args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')"], cwd: directory, env: {}, logPath: path.join(directory, "child.log") })
    try {
      await new Promise<void>((resolve, reject) => {
        child.child.stdout?.once("data", () => resolve())
        child.child.once("error", reject)
        child.child.once("exit", () => reject(new Error("Child exited before the readiness barrier")))
      })
      await expect(waitForOwned(child, 10)).rejects.toThrow("deadline")
      expect(child.child.signalCode).not.toBeNull()
      const pid = child.child.pid
      if (pid === undefined) throw new Error("Expected a spawned child PID")
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await child.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
