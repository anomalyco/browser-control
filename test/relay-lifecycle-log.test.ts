import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendRelayLifecycleEvent, RelayLifecycleEvent } from "../src/relay-lifecycle-log.ts"

let home: string
let file: string
const fields = {
  instanceId: "relay-test",
  requestId: "restart-test",
  client: { kind: "cli" as const, instanceId: "client-test", buildId: "build-test" },
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-lifecycle-log-"))
  file = path.join(home, ".browser-control", "lifecycle.jsonl")
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe("relay lifecycle log", () => {
  it("writes schema-valid JSON lines with restrictive file and directory permissions", () => {
    const events = [
      RelayLifecycleEvent.cases.Requested.make(fields),
      RelayLifecycleEvent.cases.Cancelled.make(fields),
      RelayLifecycleEvent.cases.Stopping.make(fields),
      RelayLifecycleEvent.cases.Ready.make({ instanceId: "relay-next", buildId: "build-next", restartRequestId: fields.requestId }),
    ]
    for (const event of events) appendRelayLifecycleEvent(file, event)
    const entries = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
    expect(entries).toHaveLength(events.length)
    for (const [index, entry] of entries.entries()) {
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Schema.decodeUnknownSync(RelayLifecycleEvent)(entry)).toEqual(events[index])
      expect(entry).toEqual({ ...events[index], timestamp: entry.timestamp })
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)

    fs.chmodSync(file, 0o644)
    fs.chmodSync(path.dirname(file), 0o755)
    appendRelayLifecycleEvent(file, RelayLifecycleEvent.cases.Requested.make(fields))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it("bounds the log to 256k without retaining partial JSON entries", () => {
    const event = RelayLifecycleEvent.cases.Requested.make(fields)
    appendRelayLifecycleEvent(file, event)
    const line = fs.readFileSync(file, "utf8")
    fs.writeFileSync(file, line.repeat(Math.floor(256_000 / Buffer.byteLength(line))))
    expect(fs.statSync(file).size).toBeLessThanOrEqual(256_000)
    appendRelayLifecycleEvent(file, event)
    expect(fs.statSync(file).size).toBeLessThanOrEqual(256_000)
    const entries = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((entry) => Schema.decodeUnknownSync(RelayLifecycleEvent)(JSON.parse(entry)))
    expect(entries).toEqual([event])
    appendRelayLifecycleEvent(file, RelayLifecycleEvent.cases.Ready.make({ instanceId: "relay-next", buildId: "build-next" }))
    expect(fs.readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(2)
  })

  it.each(["write", "file-sync", "directory-sync"] as const)("propagates %s failure and closes descriptors", (step) => {
    const failure = new Error(`Injected ${step} failure`)
    const closed = vi.spyOn(fs, "closeSync")
    const opened = vi.spyOn(fs, "openSync")
    const sync = fs.fsyncSync.bind(fs)
    if (step === "write") vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw failure })
    else vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const directory = fs.fstatSync(fd).isDirectory()
      if (directory === (step === "directory-sync")) throw failure
      sync(fd)
    })

    expect(() => appendRelayLifecycleEvent(file, RelayLifecycleEvent.cases.Requested.make(fields))).toThrow(failure)
    expect(opened).toHaveBeenCalledTimes(step === "directory-sync" ? 2 : 1)
    expect(closed).toHaveBeenCalledTimes(opened.mock.results.length)
    for (const result of opened.mock.results) {
      expect(result.type).toBe("return")
      expect(closed).toHaveBeenCalledWith(result.value)
      expect(() => fs.fstatSync(result.value)).toThrow()
    }
  })

  it("syncs the file and containing directory before returning", () => {
    const sync = fs.fsyncSync.bind(fs)
    const synced: string[] = []
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file")
      sync(fd)
    })
    appendRelayLifecycleEvent(file, RelayLifecycleEvent.cases.Requested.make(fields))
    expect(synced).toEqual(["file", "directory"])
  })

  it("omits expressions, URLs, credentials, and unknown nested metadata", () => {
    const event = {
      ...RelayLifecycleEvent.cases.Requested.make(fields),
      expression: "page.title()",
      url: "https://private.example/account",
      credentials: "Bearer fixture-secret",
      client: { ...fields.client, credentials: "fixture-password" },
    }
    appendRelayLifecycleEvent(file, event)
    const entry = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(entry).toEqual({ ...RelayLifecycleEvent.cases.Requested.make(fields), timestamp: expect.any(String) })
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/page\.title|https:|fixture-secret|fixture-password/)
  })

  it.each(["page.title()", "https://private.example/", "Bearer fixture-secret", "build\nsecond-line"])("rejects unsafe identity/build metadata %j", (unsafe) => {
    const invalid = [
      { ...RelayLifecycleEvent.cases.Requested.make(fields), instanceId: unsafe },
      { ...RelayLifecycleEvent.cases.Requested.make(fields), requestId: unsafe },
      { ...RelayLifecycleEvent.cases.Requested.make(fields), client: { ...fields.client, instanceId: unsafe } },
      { ...RelayLifecycleEvent.cases.Requested.make(fields), client: { ...fields.client, buildId: unsafe } },
      { ...RelayLifecycleEvent.cases.Ready.make({ instanceId: "relay-next", buildId: "build-next" }), buildId: unsafe },
    ]
    for (const event of invalid) {
      expect(() => appendRelayLifecycleEvent(file, event)).toThrow()
    }
    expect(fs.existsSync(file)).toBe(false)
  })
})
