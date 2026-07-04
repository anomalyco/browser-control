import { describe, expect, it } from "vitest"
import { relayBuildCheck } from "../src/doctor.ts"

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
})
