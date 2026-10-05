import { describe, expect, it, vi } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import { Command } from "effect/cli"

vi.mock("@effect/platform-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/platform-node")>()
  return {
    ...actual,
    NodeRuntime: {
      ...actual.NodeRuntime,
      runMain: vi.fn(),
    },
  }
})

import {
  browserControl,
  executeJsonEnvelope,
  formatRecordingQuality,
  formatSessionContinuation,
  normalizeCliArguments,
  resolveExplicitSessionSelector,
} from "../src/cli.ts"
import type { ExecuteResponse, RecordingQuality } from "../src/relay-schema.ts"

const session: ExecuteResponse["session"] = {
  id: "schedules-check",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:01.000Z",
  connected: true,
  pageUrl: null,
  stateKeys: [],
}

function executeResponse(overrides: Partial<ExecuteResponse>): ExecuteResponse {
  return {
    text: "undefined",
    isError: false,
    logs: [],
    session,
    ...overrides,
  }
}

describe("executeJsonEnvelope", () => {
  it("uses the structured wire value when present", () => {
    const envelope = executeJsonEnvelope(executeResponse({ text: "{ a: 1 }", value: { a: 1 } }))

    expect(envelope).toMatchObject({
      ok: true,
      isError: false,
      text: "{ a: 1 }",
      value: { a: 1 },
      valueUnavailable: false,
    })
  })

  it("marks value unavailable when the wire value is absent", () => {
    const envelope = executeJsonEnvelope(executeResponse({ text: "Symbol(browser)" }))

    expect(envelope.value).toBeNull()
    expect(envelope.valueUnavailable).toBe(true)
  })

  it("distinguishes a structured null result from an unavailable value", () => {
    const envelope = executeJsonEnvelope(executeResponse({ text: "null", value: null }))

    expect(envelope.value).toBeNull()
    expect(envelope.valueUnavailable).toBe(false)
  })

  it("preserves a bounded execution-context diagnostic", () => {
    const envelope = executeJsonEnvelope(executeResponse({
      isError: true,
      diagnostic: "execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
    }))

    expect(envelope.diagnostic).toContain("context-destroyed")
  })
})

describe("session continuation", () => {
  it("prints one exact continuation instruction", () => {
    expect(formatSessionContinuation("cosmic-otter-866")).toBe(
      "Session: cosmic-otter-866. Continue with --session cosmic-otter-866.",
    )
  })
})

describe("CLI argument normalization", () => {
  it("preserves secrets run operands after the end-of-options delimiter", () => {
    const normalized = normalizeCliArguments([
      "secrets",
      "run",
      "github",
      "--",
      "/usr/bin/node",
      "-e",
      "process.stdout.write(process.env.BC_SECRET_1 || '')",
    ])

    expect(normalized).toEqual([
      "secrets",
      "run",
      "github",
      "bc-cli-operands:v1",
      "bc-cli-operand:%2Fusr%2Fbin%2Fnode",
      "bc-cli-operand:-e",
      "bc-cli-operand:process.stdout.write(process.env.BC_SECRET_1%20%7C%7C%20'')",
    ])
  })

  it("leaves other commands unchanged", () => {
    const args = ["execute", "--", "return page.url()"]
    expect(normalizeCliArguments(args)).toBe(args)
  })

  it("finds secrets run after leading command flags", () => {
    expect(normalizeCliArguments(["--help", "secrets", "run", "github", "--", "printf", "-n"])).toEqual([
      "--help",
      "secrets",
      "run",
      "github",
      "bc-cli-operands:v1",
      "bc-cli-operand:printf",
      "bc-cli-operand:-n",
    ])
  })
})

describe("CLI boolean defaults", () => {
  it.each([
    { path: ["relay", "restart"], args: [], expected: {} },
    { path: ["execute"], args: ["--file", "script.js"], expected: { json: false, code: [], file: Option.some("script.js") } },
    { path: ["execute"], args: ["--file", "script.js", "--json"], expected: { json: true, code: [] } },
    { path: ["execute"], args: ["--file", "script.js", "--no-json"], expected: { json: false, code: [] } },
    { path: ["session", "new"], args: [], expected: { readOnly: false } },
    { path: ["session", "new"], args: ["--read-only"], expected: { readOnly: true } },
    { path: ["session", "list"], args: [], expected: { json: false } },
    { path: ["status"], args: [], expected: { json: false } },
    { path: ["recording", "start"], args: ["recording.webm"], expected: { audio: false } },
    { path: ["recording", "start"], args: ["recording.webm", "--audio"], expected: { audio: true } },
    { path: ["recording", "status"], args: [], expected: { json: false } },
    { path: ["network", "start"], args: [], expected: { json: false } },
    { path: ["network", "status"], args: [], expected: { json: false } },
    { path: ["network", "stop"], args: [], expected: { json: false } },
    { path: ["secrets", "status"], args: ["profile"], expected: { json: false } },
    { path: ["secrets", "refresh"], args: ["profile"], expected: { json: false } },
    { path: ["journal"], args: [], expected: { json: false } },
    { path: ["doctor"], args: [], expected: { json: false } },
  ])("parses $path $args without changing flag defaults", async ({ path, args, expected }) => {
    let command: Command.Command.Any = browserControl
    for (const name of path) {
      const child = command.subcommands.flatMap((group) => group.commands).find((child) => child.name === name)
      if (!child) throw new Error(`Missing command: ${name}`)
      command = child
    }
    let parsed: unknown
    const parseOnly = command.pipe(Command.withHandler((input: unknown) => Effect.sync(() => { parsed = input })))
    await Effect.runPromise(
      Command.runWith(parseOnly, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
    )
    expect(parsed).toMatchObject(expected)
  })
})

describe("resolveExplicitSessionSelector", () => {
  it("accepts positional, flag, and environment selectors in precedence order", () => {
    expect(resolveExplicitSessionSelector({ positional: "positional", flag: undefined, environment: "environment" })).toBe("positional")
    expect(resolveExplicitSessionSelector({ positional: undefined, flag: "flag", environment: "environment" })).toBe("flag")
    expect(resolveExplicitSessionSelector({ positional: undefined, flag: undefined, environment: "environment" })).toBe("environment")
    expect(resolveExplicitSessionSelector({ positional: undefined, flag: undefined, environment: undefined })).toBeUndefined()
  })

  it("rejects combining positional and flag selectors", () => {
    expect(() => resolveExplicitSessionSelector({
      positional: "positional",
      flag: "flag",
      environment: undefined,
    })).toThrow("Use either a positional session id or --session, not both")
  })
})

const quality: RecordingQuality = {
  width: 1280, height: 720, frameRate: 60,
  sourceFrameCount: 120, encodedSourceFrameCount: 90,
  coalescedFrameCount: 25, droppedFrameCount: 5,
  achievedSourceFrameRate: 40, achievedEncodedSourceFrameRate: 30,
  screenshotFallback: false, sourceWidth: 2560, sourceHeight: 1273,
}

describe("recording quality receipt", () => {
  it("distinguishes source and output rates without claiming distinct motion", () => {
    const text = formatRecordingQuality(quality)
    expect(text).toContain("1280×720, output 60 fps")
    expect(text).toContain("2560×1273 CSS px")
    expect(text).toContain("120 received (40.0/s), 90 retained (30.0/s), 25 coalesced, 5 dropped")
    expect(text).toContain("not a measurement of distinct motion")
  })
  it("calls out the stop-time screenshot fallback", () => {
    expect(formatRecordingQuality({ ...quality, screenshotFallback: true, sourceFrameCount: 0 })).toContain("WARNING: no compositor frames arrived")
  })
  it("does not fabricate metrics for tab capture or an older relay", () => {
    expect(formatRecordingQuality(undefined)).toContain("unavailable")
  })
})
