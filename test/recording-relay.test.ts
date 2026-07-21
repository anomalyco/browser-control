import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordingRelay, type VideoEncoder } from "../src/recording-relay.ts"
import { encodeRecordingFrame } from "../src/recording-protocol.ts"

const temporaryPaths: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) => fs.rm(temporaryPath, { force: true, recursive: true })))
})

describe("RecordingRelay tab capture", () => {
  it("streams intrinsically framed chunks to an atomic output", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "demo.webm")
    let relay: RecordingRelay
    relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => {
        if (command.method === "recording.start") {
          return { success: true, tabId: 7, startedAt: 1_000, mimeType: "video/webm" }
        }
        if (command.method === "recording.stop") {
          queueMicrotask(() => relay.handleBinaryData(Buffer.from(encodeRecordingFrame({
            tabId: 7,
            sequence: 2,
            final: true,
            payload: new Uint8Array(),
          }))))
          return { success: true, tabId: 7, duration: 100 }
        }
        return { success: true }
      },
    })

    await expect(relay.startRecording({ tabId: 7, owner: "user", outputPath })).resolves.toMatchObject({ success: true })
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({
      tabId: 7,
      sequence: 0,
      final: false,
      payload: new TextEncoder().encode("first"),
    })))
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({
      tabId: 7,
      sequence: 1,
      final: false,
      payload: new TextEncoder().encode("second"),
    })))

    await expect(relay.stopRecording({ tabId: 7 })).resolves.toMatchObject({
      success: true,
      size: 11,
      mode: "tab-capture",
    })
    expect(await fs.readFile(outputPath, "utf8")).toBe("firstsecond")
    expect((await fs.readdir(directory)).some((entry) => entry.includes(".partial-"))).toBe(false)
  })

  it("streams output larger than one frame without retaining the complete recording", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "large.webm")
    let relay: RecordingRelay
    relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => {
        if (command.method === "recording.start") return { success: true, tabId: 7, startedAt: 1_000, mimeType: "video/webm" }
        if (command.method === "recording.stop") {
          queueMicrotask(() => relay.handleBinaryData(Buffer.from(encodeRecordingFrame({
            tabId: 7,
            sequence: 2,
            final: true,
            payload: new Uint8Array(),
          }))))
          return { success: true, tabId: 7, duration: 100 }
        }
        return { success: true }
      },
    })
    await relay.startRecording({ tabId: 7, owner: "user", outputPath })
    const chunk = new Uint8Array(3 * 1024 * 1024).fill(0x5a)
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence: 0, final: false, payload: chunk })))
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence: 1, final: false, payload: chunk })))

    await expect(relay.stopRecording({ tabId: 7 })).resolves.toMatchObject({ success: true, size: 6 * 1024 * 1024 })
    const contents = await fs.readFile(outputPath)
    expect(contents.byteLength).toBe(6 * 1024 * 1024)
    expect(contents[0]).toBe(0x5a)
    expect(contents.at(-1)).toBe(0x5a)
  })

  it("keeps interleaved tab frames isolated", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    const outputs = new Map([[1, path.join(directory, "one.webm")], [2, path.join(directory, "two.webm")]])
    let relay: RecordingRelay
    relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => {
        const tabId = typeof command.params?.tabId === "number" ? command.params.tabId : 0
        if (command.method === "recording.start") return { success: true, tabId, startedAt: 1_000, mimeType: "video/webm" }
        if (command.method === "recording.stop") {
          queueMicrotask(() => relay.handleBinaryData(Buffer.from(encodeRecordingFrame({
            tabId,
            sequence: 1,
            final: true,
            payload: new Uint8Array(),
          }))))
          return { success: true, tabId, duration: 100 }
        }
        return { success: true }
      },
    })

    await relay.startRecording({ tabId: 1, owner: "user", outputPath: outputs.get(1) ?? "" })
    await relay.startRecording({ tabId: 2, owner: "user", outputPath: outputs.get(2) ?? "" })
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 2, sequence: 0, final: false, payload: Uint8Array.of(2) })))
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 1, sequence: 0, final: false, payload: Uint8Array.of(1) })))

    await Promise.all([relay.stopRecording({ tabId: 1 }), relay.stopRecording({ tabId: 2 })])
    expect(Array.from(await fs.readFile(outputs.get(1) ?? ""))).toEqual([1])
    expect(Array.from(await fs.readFile(outputs.get(2) ?? ""))).toEqual([2])
  })

  it("shares an in-flight stop across concurrent callers", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    let stopCalls = 0
    let relay: RecordingRelay
    relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => {
        if (command.method === "recording.start") return { success: true, tabId: 7, startedAt: 1_000, mimeType: "video/webm" }
        if (command.method === "recording.stop") {
          stopCalls += 1
          queueMicrotask(() => relay.handleBinaryData(Buffer.from(encodeRecordingFrame({
            tabId: 7,
            sequence: 1,
            final: true,
            payload: new Uint8Array(),
          }))))
          return { success: true, tabId: 7, duration: 100 }
        }
        return { success: true }
      },
    })
    await relay.startRecording({ tabId: 7, owner: "user", outputPath: path.join(directory, "shared.webm") })
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence: 0, final: false, payload: Uint8Array.of(1) })))

    const [first, second] = await Promise.all([
      relay.stopRecording({ tabId: 7 }),
      relay.stopRecording({ tabId: 7 }),
    ])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ success: true, size: 1 })
    expect(stopCalls).toBe(1)
  })

  it("does not let cancellation race a stream that is already finalizing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "finalizing.webm")
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => command.method === "recording.start"
        ? { success: true, tabId: 7, startedAt: 1_000, mimeType: "video/webm" }
        : { success: true },
    })
    await relay.startRecording({ tabId: 7, owner: "user", outputPath })
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence: 0, final: false, payload: Uint8Array.of(1, 2, 3) })))
    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence: 1, final: true, payload: new Uint8Array() })))

    await expect(relay.cancelRecording({ tabId: 7 })).resolves.toEqual({ success: true })
    await relay.cleanupAll("test shutdown")
    expect(Array.from(await fs.readFile(outputPath))).toEqual([1, 2, 3])
    expect((await fs.readdir(directory)).some((entry) => entry.includes(".partial-"))).toBe(false)
  })

  it("aborts and removes partial output on a sequence violation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    const outputPath = path.join(directory, "bad.webm")
    const commands: string[] = []
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => {
        commands.push(command.method)
        return command.method === "recording.start"
          ? { success: true, tabId: 7, startedAt: 1_000, mimeType: "video/webm" }
          : { success: true }
      },
    })
    await relay.startRecording({ tabId: 7, owner: "user", outputPath })

    relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence: 1, final: false, payload: Uint8Array.of(1) })))
    await vi.waitFor(async () => {
      expect((await relay.statusRecording({ tabId: 7 })).isRecording).toBe(false)
    })

    expect(commands).toContain("recording.cancel")
    await vi.waitFor(async () => {
      expect((await fs.readdir(directory)).some((entry) => entry.includes(".partial-"))).toBe(false)
    })
  })

  it("aborts when pending disk writes exceed the memory bound", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-tab-recording-"))
    temporaryPaths.push(directory)
    const commands: string[] = []
    const relay = new RecordingRelay({
      isExtensionConnected: () => true,
      sendDebuggerCommand: async () => ({}),
      sendToExtension: async (command) => {
        commands.push(command.method)
        return command.method === "recording.start"
          ? { success: true, tabId: 7, startedAt: 1_000, mimeType: "video/webm" }
          : { success: true }
      },
    })
    await relay.startRecording({ tabId: 7, owner: "user", outputPath: path.join(directory, "bounded.webm") })
    const chunk = new Uint8Array(4 * 1024 * 1024)
    for (let sequence = 0; sequence < 5; sequence += 1) {
      relay.handleBinaryData(Buffer.from(encodeRecordingFrame({ tabId: 7, sequence, final: false, payload: chunk })))
    }

    await vi.waitFor(async () => {
      expect((await relay.statusRecording({ tabId: 7 })).isRecording).toBe(false)
      expect((await fs.readdir(directory)).some((entry) => entry.includes(".partial-"))).toBe(false)
    })
    expect(commands).toContain("recording.cancel")
  })
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
