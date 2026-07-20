import { describe, expect, it } from "vitest"
import { extensionProtocolCheck, formatTargetSummary, relayBuildCheck, unhealthyTargetsCheck } from "../src/doctor.ts"

describe("formatTargetSummary", () => {
  it("shows crashed target state", () => {
    expect(formatTargetSummary({
      id: "target-1",
      type: "page",
      title: "Crashed",
      url: "chrome-error://chromewebdata/",
      tabId: 7,
      owner: "relay",
      crashed: true,
    })).toContain("crashed=true chrome-error://chromewebdata/")
  })
})

describe("unhealthyTargetsCheck", () => {
  it("warns when target health cannot be read", () => {
    expect(unhealthyTargetsCheck({
      targetsResult: { ok: false, error: "relay target request failed" },
      unhealthyTargets: [],
    })).toMatchObject({ status: "warn", message: "target health unknown: relay target request failed" })
  })

  it("warns when a target is unhealthy", () => {
    const target = {
      id: "target-1",
      type: "page",
      title: "Crashed",
      url: "chrome-error://chromewebdata/",
      crashed: true,
    }
    expect(unhealthyTargetsCheck({
      targetsResult: { ok: true, value: [target] },
      unhealthyTargets: [target],
    })).toMatchObject({ status: "warn", message: "1 unhealthy target(s)" })
  })
})

describe("relayBuildCheck", () => {
  it("accepts the running relay built with the current CLI", () => {
    expect(relayBuildCheck({
      cliBuildId: "build-current",
      relayResult: { ok: true, value: { version: "0.1.0", buildId: "build-current" } },
    })).toMatchObject({ status: "ok", message: "matches CLI build (build-current)" })
  })

  it("warns when the running relay is stale", () => {
    expect(relayBuildCheck({
      cliBuildId: "build-current",
      relayResult: { ok: true, value: { version: "0.1.0", buildId: "build-old" } },
    })).toMatchObject({ status: "warn", message: "runtime build-old does not match CLI build-current" })
  })

  it("warns when an older relay does not report a build id", () => {
    expect(relayBuildCheck({
      cliBuildId: "build-current",
      relayResult: { ok: true, value: { version: "0.1.0" } },
    })).toMatchObject({ status: "warn", message: "running relay does not report a build id" })
  })

  it("compares legacy development build ids instead of treating them as wildcards", () => {
    expect(relayBuildCheck({
      cliBuildId: "dev",
      relayResult: { ok: true, value: { version: "0.1.0", buildId: "build-from-dist" } },
    })).toMatchObject({ status: "warn", message: "runtime build-from-dist does not match CLI dev" })
  })
})

describe("extensionProtocolCheck", () => {
  it("accepts independently-versioned extensions on the supported protocol", () => {
    expect(extensionProtocolCheck({
      ok: true,
      value: {
        connected: true,
        version: "9.4.2",
        protocolVersion: 1,
        protocolCompatible: true,
        protocolLegacy: false,
        activeTargets: 0,
      },
    })).toMatchObject({ status: "ok", message: "runtime 1 is compatible with relay 1" })
  })

  it("fails an incompatible extension protocol", () => {
    expect(extensionProtocolCheck({
      ok: true,
      value: {
        connected: false,
        version: "10.0.0",
        protocolVersion: 2,
        protocolCompatible: false,
        protocolLegacy: false,
        activeTargets: 0,
      },
    })).toMatchObject({ status: "fail", message: "runtime 2 is incompatible with relay 1" })
  })
})
