import { describe, expect, it } from "vitest"
import { classifyCase, parseConfig, runPassed, statistics, summarize, type CaseRunResult } from "../gauntlet/report.ts"
import { assert, resourceLeaks, type ExtensionStatus } from "../gauntlet/harness.ts"

const defaults = { primaryPort: 31001, secondaryPort: 31002 }
const config = (env: Record<string, string | undefined>) => parseConfig(env, ["passing", "known-gap"], defaults)

describe("gauntlet configuration", () => {
  it("defaults to all cases and permits a passing-only lane", () => {
    expect(config({})).toMatchObject({ selected: ["passing", "known-gap"], repeatCount: 1, warmupCount: 0 })
    expect(config({ GAUNTLET_CASE: "passing", GAUNTLET_REPEAT: "3", GAUNTLET_WARMUP: "2" })).toMatchObject({ selected: ["passing"], repeatCount: 3, warmupCount: 2 })
  })
  it.each(["unknown", "passing,unknown", "", "passing,", "passing,passing"])("rejects malformed selection %j", (selection) => {
    expect(() => config({ GAUNTLET_CASE: selection })).toThrow()
  })
  it.each(["0", "-1", "1.5", "abc", "", "Infinity", "2e2", " 2", "9007199254740992"])("rejects invalid repeat %j rather than defaulting", (repeat) => {
    expect(() => config({ GAUNTLET_REPEAT: repeat })).toThrow("GAUNTLET_REPEAT")
  })
  it("validates warmups, ports, and optional settings", () => {
    expect(config({ GAUNTLET_WARMUP: "0" }).warmupCount).toBe(0)
    for (const env of [{ GAUNTLET_WARMUP: "-1" }, { GAUNTLET_PRIMARY_PORT: "65536" }, { GAUNTLET_SECONDARY_PORT: "31001" }, { GAUNTLET_REPORT: "" }, { GAUNTLET_CLI: " " }, { GAUNTLET_VERBOSE: "yes" }]) {
      expect(() => config(env)).toThrow()
    }
  })
  it.each(["", "not-a-url", "ws://localhost:19989", "http://localhost:31001", "http://localhost:19989/path"])("rejects invalid or conflicting relay endpoint %j", (endpoint) => {
    expect(() => config({ BROWSER_CONTROL_ENDPOINT: endpoint })).toThrow("BROWSER_CONTROL_ENDPOINT")
  })
})

describe("gauntlet classification", () => {
  const expectedFailure = { message: "known missing diagnosis" }
  const base = { durationMs: 10, budgetMs: 100, expectedFailure }
  function knownError() {
    try { assert(false, expectedFailure.message, { diagnostic: "generic timeout" }) } catch (error) { return error }
    throw new Error("assert did not throw")
  }
  it("accepts only the exact known assertion, including structured details", () => {
    expect(classifyCase({ ...base, error: knownError() })).toBe("xfail")
    expect(classifyCase({ ...base, error: new Error(expectedFailure.message) })).toBe("fail")
    expect(classifyCase({ ...base, error: new Error("Timeout 30000ms exceeded") })).toBe("fail")
    expect(classifyCase({ ...base, error: new Error("Duplicate target") })).toBe("fail")
    try { assert(false, `${expectedFailure.message} extra`) } catch (error) {
      expect(classifyCase({ ...base, error })).toBe("fail")
    }
  })
  it("never turns leaks, unverifiable cleanup, or over-budget known failures into xfail", () => {
    expect(classifyCase({ ...base, error: knownError(), leaks: "session remains" })).toBe("fail")
    expect(classifyCase({ ...base, error: knownError(), cleanupError: "status timed out" })).toBe("fail")
    expect(classifyCase({ ...base, error: knownError(), durationMs: 101 })).toBe("fail")
    expect(classifyCase({ ...base, leaks: "tab remains" })).toBe("fail")
  })
  it("distinguishes pass, unexpected pass and budget failures", () => {
    expect(classifyCase(base)).toBe("unexpected-pass")
    expect(classifyCase({ durationMs: 100, budgetMs: 100 })).toBe("pass")
    expect(classifyCase({ durationMs: 101, budgetMs: 100 })).toBe("budget-exceeded")
  })
})

describe("repeat statistics", () => {
  const result = (durationMs: number, warmup = false): CaseRunResult => ({ name: "case", iteration: 1, warmup, durationMs, budgetMs: 100, status: "pass", notes: [] })
  it("uses a sorted median and nearest-rank p95 without mutating inputs", () => {
    const values = [40, 10, 30, 20]
    expect(statistics(values)).toEqual({ count: 4, medianMs: 25, p95Ms: 40 })
    expect(values).toEqual([40, 10, 30, 20])
    expect(statistics(Array.from({ length: 20 }, (_, i) => i + 1)).p95Ms).toBe(19)
    expect(statistics([])).toEqual({ count: 0, medianMs: null, p95Ms: null })
  })
  it("excludes warmups from stats, but a failed warmup fails the run", () => {
    const results = [result(999, true), result(10), result(20), result(30)]
    expect(summarize(results)).toMatchObject({ count: 3, pass: 3, medianMs: 20, p95Ms: 30, cases: [{ name: "case", count: 3, medianMs: 20, p95Ms: 30 }] })
    expect(runPassed(results)).toBe(true)
    expect(runPassed([{ ...result(999, true), status: "fail" }, result(10)])).toBe(false)
    expect(runPassed([{ ...result(10), status: "xfail" }])).toBe(true)
    expect(runPassed([{ ...result(10), status: "unexpected-pass" }])).toBe(false)
  })
})

describe("resource leaks", () => {
  const after: ExtensionStatus = { connected: true, protocolVersion: 2, protocolCompatible: true, activeTargets: 0, childTargets: 0, cdpClients: 0, sessionIds: [], targets: [] }
  it("finds sessions even after their target is gone, without blaming unrelated sessions", () => {
    const check = { createdSessionIds: new Set(["owned"]), fixtureOrigins: ["http://localhost:31001"] }
    expect(resourceLeaks({ ...check, after: { ...after, sessionIds: ["other"] } })).toBeUndefined()
    expect(resourceLeaks({ ...check, after: { ...after, sessionIds: ["owned"] } })).toContain("owned")
  })
  it("finds owned targets after navigation and compares exact fixture origins", () => {
    const check = { createdSessionIds: new Set(["owned"]), fixtureOrigins: ["http://localhost:31001"] }
    const target = { id: "target", type: "page", title: "", url: "about:blank", browserControlSessionId: "owned" }
    expect(resourceLeaks({ ...check, after: { ...after, targets: [target] } })).toContain("about:blank")
    expect(resourceLeaks({ ...check, after: { ...after, targets: [{ ...target, browserControlSessionId: "other", url: "http://localhost:310010/unrelated" }] } })).toBeUndefined()
    expect(resourceLeaks({ ...check, after: { ...after, targets: [{ ...target, browserControlSessionId: "other", url: "http://localhost:31001/fixture" }] } })).toContain("fixture")
  })
})
