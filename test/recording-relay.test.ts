import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordingRelay, type VideoEncoder } from "../src/recording-relay.ts"

const temporaryPaths: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) => fs.rm(temporaryPath, { force: true, recursive: true })))
})

describe("RecordingRelay CDP screencast", () => {
  it("acknowledges compositor frames and timestamps source frames for constant-rate encoding", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "demo.mp4")
    const debuggerCommands: Array<{ readonly method: string; readonly params: object }> = []
    const encodedFrames: Array<{ readonly contents: string; readonly timestampMs: number; readonly durationMs: number }> = []
    let now = 1_000
    const encoder: VideoEncoder = {
      write: async (frame, timestampMs, durationMs) => {
        encodedFrames.push({ contents: frame.toString(), timestampMs, durationMs })
      },
      finish: async () => {
        await fs.writeFile(outputPath, "video")
      },
      cancel: async () => {},
    }
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async (command) => {
        debuggerCommands.push(command)
        if (command.method === "Page.getLayoutMetrics") {
          return { cssVisualViewport: { clientWidth: 2560, clientHeight: 1276 } }
        }
        return {}
      },
      startVideoEncoder: async () => encoder,
      now: () => now,
    })

    const start = await relay.startRecording({
      tabId: 7,
      sessionId: "demo",
      owner: "relay",
      outputPath,
      mode: "cdp",
      frameRate: 10,
    })

    expect(start).toMatchObject({ success: true, artifactType: "mp4", mimeType: "video/mp4" })
    expect(debuggerCommands[0]).toEqual({
      tabId: 7,
      method: "Page.bringToFront",
      params: {},
    })
    expect(debuggerCommands[1]).toEqual({
      tabId: 7,
      method: "Page.getLayoutMetrics",
      params: {},
    })
    expect(debuggerCommands[2]).toEqual({
      tabId: 7,
      method: "Page.startScreencast",
      params: { format: "jpeg", quality: 80, maxWidth: 1280, maxHeight: 638, everyNthFrame: 1 },
    })

    now = 1_100
    expect(relay.handleDebuggerEvent({
      tabId: 7,
      method: "Page.screencastFrame",
      params: frameParams("first", 20, 1),
    })).toBe(true)
    now = 1_300
    relay.handleDebuggerEvent({
      tabId: 7,
      method: "Page.screencastFrame",
      params: frameParams("second", 20.2, 2),
    })
    now = 1_500

    const stop = await relay.stopRecording({ sessionId: "demo" })

    expect(stop).toMatchObject({ success: true, artifactType: "mp4", frameCount: 5 })
    expect(encodedFrames).toEqual([
      { contents: "first", timestampMs: 0, durationMs: 300 },
      { contents: "second", timestampMs: 300, durationMs: 200 },
    ])
    expect(debuggerCommands.filter((command) => command.method === "Page.screencastFrameAck")).toHaveLength(2)
    expect(debuggerCommands.at(-1)?.method).toBe("Page.stopScreencast")
    expect(JSON.parse(await fs.readFile(`${outputPath}.json`, "utf8"))).toMatchObject({
      artifactType: "mp4",
      frameRate: 10,
      frameCount: 5,
      sourceFrameCount: 2,
      encodedSourceFrameCount: 2,
      droppedFrameCount: 0,
      width: 1280,
      height: 638,
      sourceWidth: 1920,
      sourceHeight: 1080,
    })
  })

  it("requires a video file extension for CDP recording", async () => {
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
    })

    await expect(relay.startRecording({
      tabId: 7,
      owner: "relay",
      outputPath: "/tmp/browser-control-frames",
      mode: "cdp",
    })).resolves.toEqual({ success: false, error: "CDP recording output path must end in .webm or .mp4" })
  })

  it("caps timestamp discontinuities by wall-clock duration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "jump.webm")
    let now = 0
    let encodedFrameCount = 0
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
      startVideoEncoder: async () => ({
        write: async () => {
          encodedFrameCount += 1
        },
        finish: async () => {
          await fs.writeFile(outputPath, "video")
        },
        cancel: async () => {},
      }),
      now: () => now,
    })
    await relay.startRecording({ tabId: 8, owner: "relay", outputPath, mode: "cdp", frameRate: 25 })
    now = 100
    relay.handleDebuggerEvent({ tabId: 8, method: "Page.screencastFrame", params: frameParams("before", 1, 1) })
    now = 200
    relay.handleDebuggerEvent({ tabId: 8, method: "Page.screencastFrame", params: frameParams("after", 10_000, 2) })
    now = 1_000

    const stop = await relay.stopRecording({ tabId: 8 })

    expect(stop).toMatchObject({ success: true, frameCount: 25 })
    expect(encodedFrameCount).toBe(2)
  })

  it("does not overfeed the encoder when compositor frames exceed output fps", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "fast.mp4")
    let now = 0
    let encodedFrameCount = 0
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
      startVideoEncoder: async () => ({
        write: async () => {
          encodedFrameCount += 1
        },
        finish: async () => {
          await fs.writeFile(outputPath, "video")
        },
        cancel: async () => {},
      }),
      now: () => now,
    })
    await relay.startRecording({ tabId: 9, owner: "relay", outputPath, mode: "cdp", frameRate: 25 })
    for (let index = 0; index < 6; index += 1) {
      now = index * 10
      relay.handleDebuggerEvent({ tabId: 9, method: "Page.screencastFrame", params: frameParams(String(index), 1 + index / 100, index + 1) })
    }
    now = 100

    const stop = await relay.stopRecording({ tabId: 9 })

    expect(stop).toMatchObject({ success: true, frameCount: 3 })
    expect(encodedFrameCount).toBe(2)
  })

  it("stops Chrome screencasting before relay shutdown cleanup", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "shutdown.webm")
    const debuggerMethods: string[] = []
    let cancelled = false
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async (command) => {
        debuggerMethods.push(command.method)
        return {}
      },
      startVideoEncoder: async () => ({
        write: async () => {},
        finish: async () => {},
        cancel: async () => {
          cancelled = true
        },
      }),
    })
    await relay.startRecording({ tabId: 10, owner: "relay", outputPath, mode: "cdp" })

    await relay.cleanupAll("Relay closed")

    expect(debuggerMethods).toEqual(["Page.bringToFront", "Page.getLayoutMetrics", "Page.startScreencast", "Page.stopScreencast"])
    expect(cancelled).toBe(true)
    await expect(relay.statusRecording({ tabId: 10 })).resolves.toEqual({ isRecording: false })
  })

  it("prevents tabCapture WebM data from being mislabeled as MP4", async () => {
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
    })

    await expect(relay.startRecording({
      tabId: 7,
      owner: "user",
      outputPath: "/tmp/browser-control.mp4",
      mode: "auto",
    })).resolves.toEqual({ success: false, error: "tabCapture recording output path must end in .webm; use --mode cdp for MP4" })
  })

  it("clears a failed tabCapture stop timer before a later recording starts", async () => {
    vi.useFakeTimers()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "timer.webm")
    let stopAttempts = 0
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async (command) => {
        if (command.method === "recording.start") {
          return { success: true, tabId: 7, startedAt: Date.now(), mimeType: "video/webm" }
        }
        if (command.method === "recording.stop") {
          stopAttempts += 1
          return { success: false, error: "extension stop failed" }
        }
        if (command.method === "recording.status") {
          return { isRecording: true, tabId: 7, startedAt: Date.now(), mimeType: "video/webm" }
        }
        return {}
      },
      sendDebuggerCommand: async () => ({}),
    })

    await expect(relay.startRecording({ tabId: 7, owner: "user", outputPath, mode: "tab-capture" })).resolves.toMatchObject({ success: true })
    await expect(relay.stopRecording({ tabId: 7 })).resolves.toEqual({ success: false, error: "extension stop failed" })
    await expect(relay.startRecording({ tabId: 7, owner: "user", outputPath, mode: "tab-capture" })).resolves.toMatchObject({ success: true })

    await vi.advanceTimersByTimeAsync(30_000)

    await expect(relay.statusRecording({ tabId: 7 })).resolves.toMatchObject({ isRecording: true, tabId: 7 })
    expect(stopAttempts).toBe(1)
    await relay.cancelRecording({ tabId: 7 })
  })

  it("reserves a tab while its encoder is starting", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "concurrent.mp4")
    const encoderStarted = deferred<void>()
    const releaseEncoder = deferred<void>()
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
      startVideoEncoder: async () => {
        encoderStarted.resolve()
        await releaseEncoder.promise
        return {
          write: async () => {},
          finish: async () => {
            await fs.writeFile(outputPath, "video")
          },
          cancel: async () => {},
        }
      },
    })

    const firstStart = relay.startRecording({ tabId: 11, owner: "relay", outputPath, mode: "cdp" })
    await encoderStarted.promise
    await expect(relay.startRecording({ tabId: 11, owner: "relay", outputPath, mode: "cdp" })).resolves.toEqual({
      success: false,
      error: "Recording already in progress for this tab",
    })
    releaseEncoder.resolve()
    await expect(firstStart).resolves.toMatchObject({ success: true })
    await relay.cancelRecording({ tabId: 11 })
  })

  it("cancels a recording while its encoder is starting", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "cancel-start.mp4")
    const encoderStarted = deferred<void>()
    const releaseEncoder = deferred<void>()
    let encoderCancelled = false
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
      startVideoEncoder: async () => {
        encoderStarted.resolve()
        await releaseEncoder.promise
        return {
          write: async () => {},
          finish: async () => {},
          cancel: async () => {
            encoderCancelled = true
          },
        }
      },
    })

    const start = relay.startRecording({ tabId: 14, owner: "relay", outputPath, mode: "cdp" })
    await encoderStarted.promise
    const cancel = relay.cancelRecording({ tabId: 14 })
    releaseEncoder.resolve()

    await expect(start).resolves.toEqual({ success: false, error: "Recording was cancelled while starting" })
    await expect(cancel).resolves.toEqual({ success: true })
    expect(encoderCancelled).toBe(true)
    await expect(relay.statusRecording({ tabId: 14 })).resolves.toEqual({ isRecording: false })
  })

  it("keeps a stopping recording reserved until the encoder finishes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "stopping.mp4")
    const finishStarted = deferred<void>()
    const releaseFinish = deferred<void>()
    let now = 0
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
      startVideoEncoder: async () => ({
        write: async () => {},
        finish: async () => {
          finishStarted.resolve()
          await releaseFinish.promise
          await fs.writeFile(outputPath, "video")
        },
        cancel: async () => {},
      }),
      now: () => now,
    })
    await relay.startRecording({ tabId: 12, owner: "relay", outputPath, mode: "cdp" })
    now = 100
    relay.handleDebuggerEvent({ tabId: 12, method: "Page.screencastFrame", params: frameParams("frame", 1, 1) })
    now = 200
    const stop = relay.stopRecording({ tabId: 12 })
    await finishStarted.promise

    await expect(relay.startRecording({ tabId: 12, owner: "relay", outputPath, mode: "cdp" })).resolves.toEqual({
      success: false,
      error: "Recording already in progress for this tab",
    })
    releaseFinish.resolve()
    await expect(stop).resolves.toMatchObject({ success: true })
  })

  it("turns encoder write failures into a stop result and cancels the encoder", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "write-error.mp4")
    let now = 0
    let cancelled = false
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendToExtension: async () => ({}),
      sendDebuggerCommand: async () => ({}),
      startVideoEncoder: async () => ({
        write: async () => {
          throw new Error("encoder pipe closed")
        },
        finish: async () => {},
        cancel: async () => {
          cancelled = true
        },
      }),
      now: () => now,
    })
    await relay.startRecording({ tabId: 13, owner: "relay", outputPath, mode: "cdp" })
    now = 100
    relay.handleDebuggerEvent({ tabId: 13, method: "Page.screencastFrame", params: frameParams("first", 1, 1) })
    now = 200
    relay.handleDebuggerEvent({ tabId: 13, method: "Page.screencastFrame", params: frameParams("second", 1.1, 2) })
    now = 300

    await expect(relay.stopRecording({ tabId: 13 })).resolves.toEqual({
      success: false,
      error: "CDP video encoding failed: encoder pipe closed",
    })
    expect(cancelled).toBe(true)
    await expect(relay.statusRecording({ tabId: 13 })).resolves.toEqual({ isRecording: false })
  })
})

function frameParams(contents: string, timestamp: number, sessionId: number) {
  return {
    data: Buffer.from(contents).toString("base64"),
    sessionId,
    metadata: {
      timestamp,
      deviceWidth: 1920,
      deviceHeight: 1080,
    },
  }
}

function deferred<A>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((resume) => {
    resolve = resume
  })
  return { promise, resolve }
}
