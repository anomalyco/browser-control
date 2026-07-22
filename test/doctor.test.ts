import { describe, expect, it } from "vitest"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createDoctorReport, extensionProtocolCheck, formatTargetSummary, relayBuildCheck, unhealthyTargetsCheck } from "../src/doctor.ts"
import * as RelayClient from "../src/relay-client.ts"
import * as SessionStore from "../src/session-store.ts"

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
        protocolVersion: 2,
        protocolCompatible: true,
        protocolLegacy: false,
        activeTargets: 0,
      },
    })).toMatchObject({ status: "ok", message: "runtime 2 is compatible with relay 2" })
  })

  it("fails an incompatible extension protocol", () => {
    expect(extensionProtocolCheck({
      ok: true,
      value: {
        connected: false,
        version: "10.0.0",
        protocolVersion: 3,
        protocolCompatible: false,
        protocolLegacy: false,
        activeTargets: 0,
      },
    })).toMatchObject({ status: "fail", message: "runtime 3 is incompatible with relay 2" })
  })
})

describe("createDoctorReport", () => {
  it("compares the runtime extension with the manifest shipped in the package", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-doctor-"))
    try {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true })
      await fs.mkdir(path.join(packageRoot, "extension", "dist"), { recursive: true })
      await Promise.all([
        fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
          name: "@opencode-ai/browser-control",
          version: "1.0.0",
          bin: { "browser-control": "./dist/cli.js", "browser-control-mcp": "./dist/mcp.js" },
        })),
        fs.writeFile(path.join(packageRoot, "dist", "cli.js"), ""),
        fs.writeFile(path.join(packageRoot, "dist", "mcp.js"), ""),
        fs.writeFile(path.join(packageRoot, "extension", "manifest.json"), JSON.stringify({ version: "9.9.9" })),
        fs.writeFile(path.join(packageRoot, "extension", "dist", "manifest.json"), JSON.stringify({ version: "0.0.23" })),
      ])
      const relay = {
        endpoint: "http://127.0.0.1:19989",
        version: Effect.succeed({ version: "1.0.0", buildId: "test" }),
        extensionStatus: Effect.succeed({
          connected: true,
          version: "0.0.23",
          protocolVersion: 2,
          protocolCompatible: true,
          protocolLegacy: false,
          activeTargets: 0,
        }),
        targets: Effect.succeed([]),
        sessions: Effect.succeed([]),
      } as unknown as RelayClient.Interface
      const store = {
        endpoint: relay.endpoint,
        filePath: path.join(packageRoot, "session.json"),
        read: Effect.succeed(undefined),
      } as unknown as SessionStore.Interface
      const report = await Effect.runPromise(createDoctorReport({ packageRoot }).pipe(
        Effect.provide(Layer.mergeAll(
          NodeFileSystem.layer,
          NodePath.layer,
          Layer.succeed(RelayClient.Service, relay),
          Layer.succeed(SessionStore.Service, store),
        )),
      ))

      expect(report.extension).toMatchObject({ expectedVersion: "0.0.23", versionMatches: true })
      expect(report.checks.find((check) => check.id === "extension-version")).toMatchObject({
        status: "ok",
        message: "matches bundled extension (0.0.23)",
      })
    } finally {
      await fs.rm(packageRoot, { recursive: true, force: true })
    }
  })
})
