import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FlightRecorderRelay } from "../src/flight-recorder.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("FlightRecorderRelay", () => {
  it("retains recent compositor frames and saves a clip without stopping", async () => {
    let monotonic = 0
    const sendDebuggerCommand = vi.fn(async ({ method }: { readonly method: string }) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 801, clientHeight: 603 } }
      return {}
    })
    const writes: Array<{ readonly text: string; readonly timestampMs: number; readonly durationMs: number; readonly surfaceWidth?: number }> = []
    const finish = vi.fn(async () => {})
    const cancel = vi.fn(async () => {})
    const recorder = new FlightRecorderRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand,
      monotonicNow: () => monotonic,
      now: () => 1_800_000_000_000,
      startVideoEncoder: async (options) => {
        expect(options).toMatchObject({ artifactType: "webm", frameRate: 30, width: 800, height: 602 })
        return {
          write: async (frame, timestampMs, durationMs, surfaceWidth) => {
            writes.push({ text: frame.toString(), timestampMs, durationMs, ...(surfaceWidth === undefined ? {} : { surfaceWidth }) })
          },
          finish,
          cancel,
        }
      },
    })

    await expect(recorder.start({ tabId: 7, sessionId: "alpha", retentionMs: 5_000, frameRate: 30 })).resolves.toMatchObject({
      active: true,
      tabId: 7,
      retentionMs: 5_000,
      frameRate: 30,
    })
    for (const [time, value] of [[100, "one"], [1_100, "two"], [2_100, "three"]] as const) {
      monotonic = time
      expect(recorder.handleDebuggerEvent({
        tabId: 7,
        method: "Page.screencastFrame",
        params: { data: Buffer.from(value).toString("base64"), sessionId: time, metadata: { deviceWidth: 1600 } },
      })).toBe(true)
    }
    expect(recorder.status({ sessionId: "alpha" })).toMatchObject({ active: true, bufferedFrames: 3, retainedDurationMs: 2_000, sourceFrameCount: 3 })

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-flight-recorder-"))
    temporaryDirectories.push(directory)
    const outputPath = path.join(directory, "last.webm")
    await expect(recorder.saveLast({ sessionId: "alpha", outputPath, durationMs: 1_500 })).resolves.toMatchObject({
      path: outputPath,
      frameCount: 2,
      sourceFrameCount: 3,
    })
    expect(writes).toEqual([
      { text: "two", timestampMs: 0, durationMs: 1_000, surfaceWidth: 1600 },
      { text: "three", timestampMs: 1_000, durationMs: 33, surfaceWidth: 1600 },
    ])
    expect(finish).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(`${outputPath}.json`, "utf8"))).toMatchObject({ frameCount: 2, sourceFrameCount: 3 })
    expect(recorder.status({ tabId: 7 }).active).toBe(true)

    await expect(recorder.cancel({ tabId: 7 })).resolves.toEqual({ cancelled: true })
    expect(recorder.status({ tabId: 7 })).toEqual({ active: false })
    expect(sendDebuggerCommand.mock.calls.map(([call]) => call.method)).toContain("Page.stopScreencast")
  })

  it("trims frames outside the retention window", async () => {
    let monotonic = 0
    const recorder = new FlightRecorderRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async ({ method }) => method === "Page.getLayoutMetrics" ? {} : {},
      monotonicNow: () => monotonic,
    })
    await recorder.start({ tabId: 1, retentionMs: 1_000 })
    for (const time of [0, 500, 1_500]) {
      monotonic = time
      recorder.handleDebuggerEvent({ tabId: 1, method: "Page.screencastFrame", params: { data: Buffer.from(String(time)).toString("base64") } })
    }
    expect(recorder.status({ tabId: 1 })).toMatchObject({ bufferedFrames: 2, retainedDurationMs: 1_000, droppedFrameCount: 1 })
    await recorder.cleanupAll()
  })

  it("rejects a tab already used by a normal recording", async () => {
    const recorder = new FlightRecorderRelay({
      isExtensionConnected: () => true,
      isTabRecording: () => true,
      sendDebuggerCommand: async () => ({}),
    })
    await expect(recorder.start({ tabId: 1 })).rejects.toThrow("Stop the active recording")
  })
})
