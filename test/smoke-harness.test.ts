import cp from "node:child_process"
import { Effect } from "effect"
import type { Page } from "playwright-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cases, summarize } from "../scripts/smoke.ts"

afterEach(() => vi.restoreAllMocks())

describe("smoke verdicts", () => {
  it("keeps the first fill-helper timeout and still deletes its session without replaying execute", async () => {
    const commands: string[][] = []
    const timeout: cp.ExecException = Object.assign(new Error("first attempt timed out"), { killed: true, signal: "SIGTERM" as const, cmd: "synthetic smoke execute" })
    vi.spyOn(cp, "execFile").mockImplementation((...args) => {
      const callback = args.at(-1)
      if (typeof callback !== "function") throw new Error("Expected execFile callback")
      const command = args[1]
      if (!Array.isArray(command)) throw new Error("Expected CLI arguments")
      commands.push(command)
      queueMicrotask(() => callback(command.includes("execute") ? timeout : null, "", command.includes("execute") ? "first attempt timed out" : ""))
      return new cp.ChildProcess()
    })
    const testCase = cases.find((candidate) => candidate.name === "execute-fill-helpers")
    if (!testCase) throw new Error("Missing fill-helper case")

    await expect(Effect.runPromise(testCase.run({} as Page))).rejects.toThrow("first attempt timed out")
    expect(commands.filter((command) => command.includes("execute"))).toHaveLength(1)
    expect(commands.some((command) => command.includes("new"))).toBe(true)
    expect(commands.at(-1)).toContain("delete")
  })

  it("retains the summary shape without unreachable expected-failure verdicts", () => {
    const status = { connected: true, version: null, protocolVersion: null, protocolCompatible: true, activeTargets: 1, childTargets: 0, cdpClients: 1, sessionIds: [] }
    const common = { name: "fixture", iteration: 1, durationMs: 1, beforeStatus: status, afterStatus: status }
    expect(summarize([{ ...common, status: "pass" }, { ...common, status: "fail", error: "cleanup regression" }])).toEqual({
      pass: 1, fail: 1, expectedFail: 0, unexpectedPass: 0,
    })
  })
})
