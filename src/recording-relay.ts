import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { mjpegMatroskaFrame, mjpegMatroskaHeader } from "./mjpeg-matroska.ts"
import type { ExtensionCommand, JsonObject } from "./protocol.ts"
import { getObject } from "./relay-helpers.ts"
import type { ConnectedTarget } from "./relay-types.ts"

const defaultMaxDurationMs = 15 * 60 * 1_000
const defaultCdpFrameRate = 25
const maxCdpFrameRate = 30
const maxPendingCdpFrames = 30
const maxCdpWidth = 1_280
const maxCdpHeight = 720
const cdpJpegQuality = 80

export type RecordingMode = "auto" | "tab-capture" | "cdp"
export type ActiveRecordingMode = "tab-capture" | "cdp"
export type RecordingArtifactType = "webm" | "mp4"

export type SendDebuggerCommand = (options: {
  readonly tabId: number
  readonly sessionId?: string
  readonly method: string
  readonly params: JsonObject
}) => Promise<JsonObject>

export type RecordingStartOptions = {
  readonly tabId: number
  readonly sessionId?: string
  readonly owner: ConnectedTarget["owner"]
  readonly outputPath: string
  readonly mode?: RecordingMode
  readonly frameRate?: number
  readonly audio?: boolean
  readonly videoBitsPerSecond?: number
  readonly audioBitsPerSecond?: number
  readonly maxDurationMs?: number
}

export type RecordingTargetOptions = {
  readonly tabId?: number
  readonly sessionId?: string
}

export type RecordingStartResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly startedAt: number
    readonly path: string
    readonly mimeType: string
    readonly mode: ActiveRecordingMode
    readonly artifactType: RecordingArtifactType
  }
  | {
    readonly success: false
    readonly error: string
  }

export type RecordingStopResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly duration: number
    readonly path: string
    readonly size: number
    readonly mode: ActiveRecordingMode
    readonly artifactType: RecordingArtifactType
    readonly frameCount?: number
  }
  | {
    readonly success: false
    readonly error: string
  }

export type RecordingStatusResult = {
  readonly isRecording: boolean
  readonly tabId?: number
  readonly startedAt?: number
  readonly path?: string
  readonly size?: number
  readonly mode?: ActiveRecordingMode
  readonly artifactType?: RecordingArtifactType
  readonly frameCount?: number
}

export type RecordingCancelResult = {
  readonly success: boolean
  readonly error?: string
}

type ActiveRecordingBase = {
  tabId: number
  sessionId?: string
  outputPath: string
  startedAt: number
  mode: ActiveRecordingMode
  artifactType: RecordingArtifactType
  maxDurationTimer?: ReturnType<typeof setTimeout>
  resolveStop?: (result: RecordingStopResult) => void
}

type TabCaptureRecording = ActiveRecordingBase & {
  mode: "tab-capture"
  artifactType: "webm"
  chunks: Buffer[]
}

type CdpRecording = ActiveRecordingBase & {
  mode: "cdp"
  artifactType: "webm" | "mp4"
  frameRate: number
  encoder: VideoEncoder
  lastFrame?: CdpVideoFrame
  frameCount: number
  sourceFrameCount: number
  encodedSourceFrameCount: number
  coalescedFrameCount: number
  droppedFrameCount: number
  pendingFrameCount: number
  width: number
  height: number
  sourceWidth?: number
  sourceHeight?: number
  stopped: boolean
  stopping: boolean
  startedMonotonicAt: number
  stopPromise?: Promise<RecordingStopResult>
  writePromise: Promise<void>
  writeError?: Error
}

type CdpVideoFrame = {
  readonly buffer: Buffer
  readonly frameNumber: number
}

export type VideoEncoder = {
  readonly write: (frame: Buffer, timestampMs: number, durationMs: number) => Promise<void>
  readonly finish: () => Promise<void>
  readonly cancel: () => Promise<void>
}

export type StartVideoEncoder = (options: {
  readonly outputPath: string
  readonly artifactType: "webm" | "mp4"
  readonly frameRate: number
  readonly width: number
  readonly height: number
}) => Promise<VideoEncoder>

type ActiveRecording = TabCaptureRecording | CdpRecording

type StartingRecording = {
  readonly tabId: number
  readonly sessionId?: string
  cancelled: boolean
  promise?: Promise<RecordingStartResult>
}

type ExtensionStartResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly startedAt: number
    readonly mimeType?: string
  }
  | {
    readonly success: false
    readonly error: string
  }

type ExtensionStopResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly duration: number
  }
  | {
    readonly success: false
    readonly error: string
  }

type ExtensionStatusResult = {
  readonly isRecording: boolean
  readonly tabId?: number
  readonly startedAt?: number
}

export class RecordingRelay {
  private readonly activeRecordings = new Map<number, ActiveRecording>()
  private readonly startingRecordings = new Map<number, StartingRecording>()
  private lastRecordingMetadataTabId: number | undefined

  constructor(readonly options: {
    readonly sendToExtension: (command: Omit<ExtensionCommand, "id">) => Promise<JsonObject>
    readonly sendDebuggerCommand: SendDebuggerCommand
    readonly isExtensionConnected: () => boolean
    readonly startVideoEncoder?: StartVideoEncoder
    readonly now?: () => number
    readonly monotonicNow?: () => number
  }) {}

  async startRecording(options: RecordingStartOptions): Promise<RecordingStartResult> {
    if (!this.options.isExtensionConnected()) {
      return { success: false, error: "Browser Control extension is not connected" }
    }
    if (this.activeRecordings.has(options.tabId) || this.startingRecordings.has(options.tabId)) {
      return { success: false, error: "Recording already in progress for this tab" }
    }
    const starting: StartingRecording = {
      tabId: options.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cancelled: false,
    }
    this.startingRecordings.set(options.tabId, starting)
    const promise = this.startReservedRecording(options, starting)
    starting.promise = promise
    try {
      return await promise
    } finally {
      if (this.startingRecordings.get(options.tabId) === starting) {
        this.startingRecordings.delete(options.tabId)
      }
    }
  }

  async stopRecording(options: RecordingTargetOptions): Promise<RecordingStopResult> {
    if (!this.options.isExtensionConnected()) {
      return { success: false, error: "Browser Control extension is not connected" }
    }
    const recording = this.findRecording(options)
    if (!recording) {
      return { success: false, error: "No active recording found" }
    }
    if (recording.mode === "cdp") {
      return this.stopCdpRecording(recording)
    }

    let stopTimeout: ReturnType<typeof setTimeout> | undefined
    const finalResult = new Promise<RecordingStopResult>((resolve) => {
      stopTimeout = setTimeout(() => {
        delete recording.resolveStop
        if (this.activeRecordings.get(recording.tabId) === recording) {
          this.cleanupRecording(recording.tabId)
        }
        resolve({ success: false, error: "Timeout waiting for recording data" })
      }, 30_000)
      recording.resolveStop = (result) => {
        if (stopTimeout) clearTimeout(stopTimeout)
        resolve(result)
      }
    })

    try {
      const result = parseExtensionStopResult(await this.options.sendToExtension({
        method: "recording.stop",
        params: { tabId: recording.tabId },
      }))
      if (!result.success) {
        if (stopTimeout) clearTimeout(stopTimeout)
        delete recording.resolveStop
        this.cleanupRecording(recording.tabId)
        return result
      }
      return await finalResult
    } catch (error) {
      if (stopTimeout) clearTimeout(stopTimeout)
      delete recording.resolveStop
      this.cleanupRecording(recording.tabId)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async statusRecording(options: RecordingTargetOptions): Promise<RecordingStatusResult> {
    const recording = this.findRecording(options)
    if (!recording || !this.options.isExtensionConnected()) {
      return { isRecording: false }
    }
    if (recording.mode === "cdp") {
      return {
        isRecording: true,
        tabId: recording.tabId,
        startedAt: recording.startedAt,
        path: recording.outputPath,
        mode: "cdp",
        artifactType: recording.artifactType,
        frameCount: recording.stopping
          ? recording.frameCount
          : Math.max(0, Math.round(((this.monotonicNow() - recording.startedMonotonicAt) / 1_000) * recording.frameRate)),
      }
    }
    try {
      const result = parseExtensionStatusResult(await this.options.sendToExtension({
        method: "recording.status",
        params: { tabId: recording.tabId },
      }))
      const size = recording.chunks.reduce((total, chunk) => {
        return total + chunk.byteLength
      }, 0)
      return {
        isRecording: result.isRecording,
        tabId: recording.tabId,
        startedAt: result.startedAt ?? recording.startedAt,
        path: recording.outputPath,
        size,
        mode: "tab-capture",
        artifactType: "webm",
      }
    } catch {
      // A transient status poll failure must not destroy an in-progress
      // recording; report last-known local state instead.
      return {
        isRecording: true,
        tabId: recording.tabId,
        startedAt: recording.startedAt,
        path: recording.outputPath,
        size: recording.chunks.reduce((total, chunk) => {
          return total + chunk.byteLength
        }, 0),
        mode: "tab-capture",
        artifactType: "webm",
      }
    }
  }

  async cancelRecording(options: RecordingTargetOptions): Promise<RecordingCancelResult> {
    const starting = this.findStartingRecording(options)
    if (starting) {
      starting.cancelled = true
      await starting.promise?.catch(() => {})
      return { success: true }
    }
    const recording = this.findRecording(options)
    if (!recording) {
      return { success: true }
    }
    if (recording.mode === "cdp") {
      await this.cancelCdpRecording(recording)
      return { success: true }
    }
    if (!this.options.isExtensionConnected()) {
      this.cleanupRecording(recording.tabId)
      return { success: false, error: "Browser Control extension is not connected" }
    }
    try {
      const result = await this.options.sendToExtension({ method: "recording.cancel", params: { tabId: recording.tabId } })
      this.cleanupRecording(recording.tabId)
      return parseCancelResult(result)
    } catch (error) {
      this.cleanupRecording(recording.tabId)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async cleanupAll(reason: string): Promise<void> {
    const starting = Array.from(this.startingRecordings.values())
    for (const recording of starting) recording.cancelled = true
    await Promise.all(starting.map(async (recording) => {
      await recording.promise?.catch(() => {})
    }))
    await Promise.all(Array.from(this.activeRecordings.values()).map(async (recording) => {
      if (recording.resolveStop) {
        recording.resolveStop({ success: false, error: reason })
      }
      if (recording.mode === "cdp") {
        if (recording.stopPromise) {
          await recording.stopPromise.catch(() => {})
          return
        }
        await this.cancelCdpRecording(recording)
        return
      }
      this.cleanupRecording(recording.tabId)
    }))
  }

  async abortRecordingForTab(options: { readonly tabId: number; readonly reason: string }): Promise<void> {
    const starting = this.startingRecordings.get(options.tabId)
    if (starting) {
      starting.cancelled = true
      await starting.promise?.catch(() => {})
      return
    }
    const recording = this.activeRecordings.get(options.tabId)
    if (!recording) {
      return
    }
    recording.resolveStop?.({ success: false, error: options.reason })
    if (recording.mode === "cdp") {
      if (recording.stopPromise) {
        await recording.stopPromise.catch(() => {})
        return
      }
      await this.cancelCdpRecording(recording)
      return
    }
    this.cleanupRecording(recording.tabId)
  }

  handleRecordingData(message: JsonObject): void {
    const params = getObject(message.params)
    const tabId = typeof params?.tabId === "number" ? params.tabId : undefined
    if (tabId === undefined) {
      return
    }
    if (params?.final !== true) {
      this.lastRecordingMetadataTabId = tabId
      return
    }
    const recording = this.activeRecordings.get(tabId)
    if (!recording || recording.mode !== "tab-capture") {
      return
    }
    void this.finishRecording(recording)
  }

  handleRecordingCancelled(message: JsonObject): void {
    const params = getObject(message.params)
    const tabId = typeof params?.tabId === "number" ? params.tabId : undefined
    if (tabId === undefined) {
      return
    }
    const recording = this.activeRecordings.get(tabId)
    if (recording?.resolveStop) {
      recording.resolveStop({ success: false, error: "Recording was cancelled" })
    }
    this.cleanupRecording(tabId)
  }

  handleDebuggerEvent(options: { readonly tabId: number; readonly method: string; readonly params: JsonObject | undefined }): boolean {
    if (options.method !== "Page.screencastFrame") {
      return false
    }
    const recording = this.activeRecordings.get(options.tabId)
    if (!recording || recording.mode !== "cdp") {
      return false
    }
    const frameSessionId = options.params?.sessionId
    if (typeof frameSessionId === "number") {
      void this.options.sendDebuggerCommand({
        tabId: recording.tabId,
        method: "Page.screencastFrameAck",
        params: { sessionId: frameSessionId },
      }).catch((error: unknown) => {
        if (!recording.stopped && !recording.stopping) console.error("CDP recording frame acknowledgement failed", error)
      })
    }
    if (recording.stopped || recording.stopping || typeof options.params?.data !== "string") {
      return true
    }
    const metadata = getObject(options.params.metadata)
    recording.sourceFrameCount += 1
    if (recording.pendingFrameCount >= maxPendingCdpFrames || recording.writeError) {
      recording.droppedFrameCount += 1
      return true
    }
    if (typeof metadata?.deviceWidth === "number") recording.sourceWidth = metadata.deviceWidth
    if (typeof metadata?.deviceHeight === "number") recording.sourceHeight = metadata.deviceHeight
    const buffer = Buffer.from(options.params.data, "base64")
    const receivedAt = this.monotonicNow()
    const frameNumber = recording.sourceFrameCount === 1
      ? 0
      : Math.max(0, Math.floor(((receivedAt - recording.startedMonotonicAt) / 1_000) * recording.frameRate))
    recording.pendingFrameCount += 1
    recording.writePromise = recording.writePromise.then(async () => {
      if (recording.lastFrame && frameNumber !== recording.lastFrame.frameNumber) {
        await this.writeSourceFrame(recording, recording.lastFrame, frameNumber)
      } else if (recording.lastFrame) {
        recording.coalescedFrameCount += 1
      }
      recording.lastFrame = { buffer, frameNumber }
    }).catch((error: unknown) => {
      recording.writeError = error instanceof Error ? error : new Error(String(error))
    }).finally(() => {
      recording.pendingFrameCount -= 1
    })
    return true
  }

  handleBinaryData(data: Buffer): void {
    const tabId = this.lastRecordingMetadataTabId
    this.lastRecordingMetadataTabId = undefined
    if (tabId === undefined) {
      return
    }
    const recording = this.activeRecordings.get(tabId)
    if (!recording || recording.mode !== "tab-capture") {
      return
    }
    recording.chunks.push(Buffer.from(data))
  }

  private async finishRecording(recording: TabCaptureRecording): Promise<void> {
    try {
      const size = recording.chunks.reduce((total, chunk) => {
        return total + chunk.byteLength
      }, 0)
      await fs.writeFile(recording.outputPath, Buffer.concat(recording.chunks))
      recording.resolveStop?.({
        success: true,
        tabId: recording.tabId,
        duration: Date.now() - recording.startedAt,
        path: recording.outputPath,
        size,
        mode: "tab-capture",
        artifactType: "webm",
      })
    } catch (error) {
      recording.resolveStop?.({ success: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.cleanupRecording(recording.tabId)
    }
  }

  private findRecording(options: RecordingTargetOptions): ActiveRecording | undefined {
    if (options.tabId !== undefined) {
      return this.activeRecordings.get(options.tabId)
    }
    if (options.sessionId) {
      return Array.from(this.activeRecordings.values()).find((recording) => {
        return recording.sessionId === options.sessionId
      })
    }
    const recordings = Array.from(this.activeRecordings.values())
    if (recordings.length > 1) {
      throw new Error("Multiple active recordings; provide sessionId or tabId")
    }
    return recordings[0]
  }

  private findStartingRecording(options: RecordingTargetOptions): StartingRecording | undefined {
    if (options.tabId !== undefined) return this.startingRecordings.get(options.tabId)
    if (options.sessionId) {
      return Array.from(this.startingRecordings.values()).find((recording) => recording.sessionId === options.sessionId)
    }
    const recordings = Array.from(this.startingRecordings.values())
    if (recordings.length > 1) throw new Error("Multiple recordings are starting; provide sessionId or tabId")
    return recordings[0]
  }

  private cleanupRecording(tabId: number): void {
    const recording = this.activeRecordings.get(tabId)
    if (recording?.maxDurationTimer) {
      clearTimeout(recording.maxDurationTimer)
    }
    if (recording?.mode === "cdp") {
      void this.cleanupCdpRecording(recording)
      return
    }
    this.activeRecordings.delete(tabId)
  }

  private async startReservedRecording(options: RecordingStartOptions, starting: StartingRecording): Promise<RecordingStartResult> {
    const mode = selectRecordingMode(options)
    if (mode === "cdp") {
      return this.startCdpRecording(options, starting)
    }
    if (cdpArtifactType(options.outputPath) !== "webm") {
      return { success: false, error: "tabCapture recording output path must end in .webm; use --mode cdp for MP4" }
    }

    await fs.mkdir(path.dirname(options.outputPath), { recursive: true })
    if (starting.cancelled) return { success: false, error: "Recording was cancelled while starting" }
    const result = parseExtensionStartResult(await this.options.sendToExtension({
      method: "recording.start",
      params: recordingStartParams(options),
    }))
    if (!result.success) return result
    if (starting.cancelled) {
      await this.options.sendToExtension({ method: "recording.cancel", params: { tabId: result.tabId } }).catch(() => {})
      return { success: false, error: "Recording was cancelled while starting" }
    }

    const recording: ActiveRecording = {
      tabId: result.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      outputPath: options.outputPath,
      mode: "tab-capture",
      artifactType: "webm",
      chunks: [],
      startedAt: result.startedAt,
    }
    this.armMaxDuration(recording, options.maxDurationMs)
    this.activeRecordings.set(result.tabId, recording)
    return {
      success: true,
      tabId: result.tabId,
      startedAt: result.startedAt,
      path: options.outputPath,
      mimeType: result.mimeType ?? "video/webm",
      mode: "tab-capture",
      artifactType: "webm",
    }
  }

  private async startCdpRecording(options: RecordingStartOptions, starting: StartingRecording): Promise<RecordingStartResult> {
    if (options.audio === true) {
      return { success: false, error: "CDP recording captures video frames only; audio is not supported" }
    }
    const artifactType = cdpArtifactType(options.outputPath)
    if (!artifactType) {
      return { success: false, error: "CDP recording output path must end in .webm or .mp4" }
    }
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true })
    if (starting.cancelled) return { success: false, error: "Recording was cancelled while starting" }
    const requestedFrameRate = options.frameRate ?? defaultCdpFrameRate
    if (requestedFrameRate <= 0 || !Number.isFinite(requestedFrameRate)) {
      return { success: false, error: "Recording frameRate must be a positive finite number" }
    }
    const frameRate = Math.min(requestedFrameRate, maxCdpFrameRate)
    let size: { readonly width: number; readonly height: number }
    try {
      await this.options.sendDebuggerCommand({
        tabId: options.tabId,
        method: "Page.bringToFront",
        params: {},
      })
      const metrics = await this.options.sendDebuggerCommand({
        tabId: options.tabId,
        method: "Page.getLayoutMetrics",
        params: {},
      })
      size = cdpRecordingSize(metrics)
    } catch (error) {
      return { success: false, error: `Could not prepare the page for recording: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (starting.cancelled) return { success: false, error: "Recording was cancelled while starting" }
    let encoder: VideoEncoder
    try {
      encoder = await (this.options.startVideoEncoder ?? startFfmpegVideoEncoder)({
        outputPath: options.outputPath,
        artifactType,
        frameRate,
        width: size.width,
        height: size.height,
      })
    } catch (error) {
      return { success: false, error: `Could not start CDP video encoder: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (starting.cancelled) {
      await encoder.cancel()
      return { success: false, error: "Recording was cancelled while starting" }
    }
    const startedAt = this.now()
    const startedMonotonicAt = this.monotonicNow()
    const recording: CdpRecording = {
      tabId: options.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      outputPath: options.outputPath,
      mode: "cdp",
      artifactType,
      startedAt,
      frameRate,
      encoder,
      frameCount: 0,
      sourceFrameCount: 0,
      encodedSourceFrameCount: 0,
      coalescedFrameCount: 0,
      droppedFrameCount: 0,
      pendingFrameCount: 0,
      width: size.width,
      height: size.height,
      stopped: false,
      stopping: false,
      startedMonotonicAt,
      writePromise: Promise.resolve(),
    }
    this.activeRecordings.set(options.tabId, recording)
    try {
      await this.options.sendDebuggerCommand({
        tabId: recording.tabId,
        method: "Page.startScreencast",
        params: {
          format: "jpeg",
          quality: cdpJpegQuality,
          maxWidth: size.width,
          maxHeight: size.height,
          everyNthFrame: 1,
        },
      })
    } catch (error) {
      await this.cleanupCdpRecording(recording)
      return { success: false, error: `Could not start CDP screencast: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (starting.cancelled || this.activeRecordings.get(recording.tabId) !== recording) {
      await this.cleanupCdpRecording(recording)
      return { success: false, error: "Recording was cancelled while starting" }
    }
    this.armMaxDuration(recording, options.maxDurationMs)
    return {
      success: true,
      tabId: options.tabId,
      startedAt,
      path: options.outputPath,
      mimeType: artifactType === "mp4" ? "video/mp4" : "video/webm",
      mode: "cdp",
      artifactType,
    }
  }

  private async stopCdpRecording(recording: CdpRecording): Promise<RecordingStopResult> {
    if (recording.stopPromise) return recording.stopPromise
    recording.stopping = true
    if (recording.maxDurationTimer) clearTimeout(recording.maxDurationTimer)
    const stopPromise = this.finishCdpRecording(recording).finally(() => {
      if (this.activeRecordings.get(recording.tabId) === recording) {
        this.activeRecordings.delete(recording.tabId)
      }
      recording.stopped = true
    })
    recording.stopPromise = stopPromise
    return stopPromise
  }

  private async cancelCdpRecording(recording: CdpRecording): Promise<void> {
    if (recording.stopPromise) {
      await recording.stopPromise.catch(() => {})
      return
    }
    await this.cleanupCdpRecording(recording)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private armMaxDuration(recording: ActiveRecording, requestedMaxDurationMs: number | undefined): void {
    const maxDurationMs = requestedMaxDurationMs ?? defaultMaxDurationMs
    if (maxDurationMs <= 0 || !Number.isFinite(maxDurationMs)) return
    recording.maxDurationTimer = setTimeout(() => {
      void this.stopRecording({ tabId: recording.tabId }).catch((error) => {
        console.error("Recording max duration stop failed", error)
      })
    }, maxDurationMs)
  }

  private monotonicNow(): number {
    return this.options.monotonicNow?.() ?? this.options.now?.() ?? performance.now()
  }

  private async finishCdpRecording(recording: CdpRecording): Promise<RecordingStopResult> {
    const stoppedAt = this.now()
    const stoppedMonotonicAt = this.monotonicNow()
    try {
      await this.options.sendDebuggerCommand({ tabId: recording.tabId, method: "Page.stopScreencast", params: {} }).catch(() => {})
      await recording.writePromise
      if (recording.writeError) throw recording.writeError
      if (!recording.lastFrame) {
        const screenshot = await this.options.sendDebuggerCommand({
          tabId: recording.tabId,
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: cdpJpegQuality, fromSurface: true, captureBeyondViewport: false },
        })
        if (typeof screenshot.data !== "string") throw new Error("No video frames were captured")
        recording.lastFrame = { buffer: Buffer.from(screenshot.data, "base64"), frameNumber: 0 }
      }
      const durationMs = Math.max(0, stoppedMonotonicAt - recording.startedMonotonicAt)
      const expectedFrameCount = Math.max(1, Math.round((durationMs / 1_000) * recording.frameRate))
      const endFrameNumber = Math.max(recording.lastFrame.frameNumber + 1, expectedFrameCount)
      await this.writeSourceFrame(recording, recording.lastFrame, endFrameNumber)
      recording.frameCount = endFrameNumber
      await recording.encoder.finish()

      const stat = await fs.stat(recording.outputPath)
      const metadata = {
        mode: "cdp",
        artifactType: recording.artifactType,
        tabId: recording.tabId,
        ...(recording.sessionId ? { sessionId: recording.sessionId } : {}),
        startedAt: new Date(recording.startedAt).toISOString(),
        stoppedAt: new Date(stoppedAt).toISOString(),
        durationMs,
        frameRate: recording.frameRate,
        frameCount: recording.frameCount,
        sourceFrameCount: recording.sourceFrameCount,
        encodedSourceFrameCount: recording.encodedSourceFrameCount,
        coalescedFrameCount: recording.coalescedFrameCount,
        droppedFrameCount: recording.droppedFrameCount,
        achievedSourceFrameRate: recording.sourceFrameCount / Math.max(0.001, durationMs / 1_000),
        width: recording.width,
        height: recording.height,
        ...(recording.sourceWidth === undefined ? {} : { sourceWidth: recording.sourceWidth }),
        ...(recording.sourceHeight === undefined ? {} : { sourceHeight: recording.sourceHeight }),
        mimeType: recording.artifactType === "mp4" ? "video/mp4" : "video/webm",
      }
      await fs.writeFile(`${recording.outputPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
      return {
        success: true,
        tabId: recording.tabId,
        duration: durationMs,
        path: recording.outputPath,
        size: stat.size,
        mode: "cdp",
        artifactType: recording.artifactType,
        frameCount: recording.frameCount,
      }
    } catch (error) {
      await recording.encoder.cancel().catch(() => {})
      return { success: false, error: `CDP video encoding failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async cleanupCdpRecording(recording: CdpRecording): Promise<void> {
    recording.stopped = true
    if (recording.maxDurationTimer) clearTimeout(recording.maxDurationTimer)
    if (this.activeRecordings.get(recording.tabId) === recording) {
      this.activeRecordings.delete(recording.tabId)
    }
    await Promise.all([
      this.options.sendDebuggerCommand({ tabId: recording.tabId, method: "Page.stopScreencast", params: {} }).catch(() => {}),
      recording.encoder.cancel().catch(() => {}),
    ])
    await recording.writePromise.catch(() => {})
  }

  private async writeSourceFrame(recording: CdpRecording, frame: CdpVideoFrame, endFrameNumber: number): Promise<void> {
    const timestampMs = Math.round((frame.frameNumber * 1_000) / recording.frameRate)
    const durationMs = Math.max(1, Math.round(((endFrameNumber - frame.frameNumber) * 1_000) / recording.frameRate))
    await recording.encoder.write(frame.buffer, timestampMs, durationMs)
    recording.encodedSourceFrameCount += 1
  }
}

function selectRecordingMode(options: RecordingStartOptions): ActiveRecordingMode {
  if (options.mode === "cdp") {
    return "cdp"
  }
  if (options.mode === "tab-capture") {
    return "tab-capture"
  }
  return options.owner === "relay" ? "cdp" : "tab-capture"
}

function recordingStartParams(options: RecordingStartOptions): JsonObject {
  return {
    tabId: options.tabId,
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    ...(options.videoBitsPerSecond === undefined ? {} : { videoBitsPerSecond: options.videoBitsPerSecond }),
    ...(options.audioBitsPerSecond === undefined ? {} : { audioBitsPerSecond: options.audioBitsPerSecond }),
  }
}

function parseExtensionStartResult(value: JsonObject): ExtensionStartResult {
  if (value.success === true && typeof value.tabId === "number" && typeof value.startedAt === "number") {
    return {
      success: true,
      tabId: value.tabId,
      startedAt: value.startedAt,
      ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    }
  }
  if (value.success === false && typeof value.error === "string") {
    return { success: false, error: value.error }
  }
  return { success: false, error: "Invalid recording.start response from extension" }
}

function parseExtensionStopResult(value: JsonObject): ExtensionStopResult {
  if (value.success === true && typeof value.tabId === "number" && typeof value.duration === "number") {
    return { success: true, tabId: value.tabId, duration: value.duration }
  }
  if (value.success === false && typeof value.error === "string") {
    return { success: false, error: value.error }
  }
  return { success: false, error: "Invalid recording.stop response from extension" }
}

function parseExtensionStatusResult(value: JsonObject): ExtensionStatusResult {
  return {
    isRecording: value.isRecording === true,
    ...(typeof value.tabId === "number" ? { tabId: value.tabId } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
  }
}

function parseCancelResult(value: JsonObject): RecordingCancelResult {
  return {
    success: value.success === true,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  }
}

function cdpArtifactType(outputPath: string): "webm" | "mp4" | undefined {
  const extension = path.extname(outputPath).toLowerCase()
  if (extension === ".webm") return "webm"
  if (extension === ".mp4") return "mp4"
  return undefined
}

function cdpRecordingSize(metrics: JsonObject): { readonly width: number; readonly height: number } {
  const viewport = getObject(metrics.cssVisualViewport) ?? getObject(metrics.visualViewport)
  const viewportWidth = typeof viewport?.clientWidth === "number" ? viewport.clientWidth : maxCdpWidth
  const viewportHeight = typeof viewport?.clientHeight === "number" ? viewport.clientHeight : maxCdpHeight
  const scale = Math.min(1, maxCdpWidth / viewportWidth, maxCdpHeight / viewportHeight)
  return {
    width: Math.max(2, Math.floor(viewportWidth * scale) & ~1),
    height: Math.max(2, Math.floor(viewportHeight * scale) & ~1),
  }
}

async function startFfmpegVideoEncoder(options: {
  readonly outputPath: string
  readonly artifactType: "webm" | "mp4"
  readonly frameRate: number
  readonly width: number
  readonly height: number
}): Promise<VideoEncoder> {
  const temporaryOutputPath = `${options.outputPath}.partial-${process.pid}-${Date.now()}`
  const outputArgs = options.artifactType === "webm"
    ? ["-c:v", "libvpx", "-crf", "8", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M", "-threads", "1"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
  const child = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "matroska",
    "-fpsprobesize",
    "0",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-i",
    "pipe:0",
    "-an",
    "-r",
    String(options.frameRate),
    "-fps_mode",
    "cfr",
    "-vf",
    `pad=${options.width}:${options.height}:0:0:gray,crop=${options.width}:${options.height}:0:0`,
    ...outputArgs,
    "-f",
    options.artifactType,
    temporaryOutputPath,
  ], { stdio: "pipe" })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  const exit = new Promise<Error | undefined>((resolve) => {
    child.once("error", (error) => resolve(error))
    child.once("close", (code, signal) => {
      if (code === 0) resolve(undefined)
      else resolve(new Error(`ffmpeg exited with ${code ?? signal ?? "unknown status"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
    })
  })
  try {
    await once(child, "spawn")
    await writeStreamChunk(child.stdin, mjpegMatroskaHeader(options.width, options.height))
  } catch (error) {
    await exit
    await fs.rm(temporaryOutputPath, { force: true })
    throw error
  }
  let completed = false
  let finishingPromise: Promise<void> | undefined
  let cancelPromise: Promise<void> | undefined
  const terminate = async () => {
    child.stdin.destroy()
    if (child.exitCode === null) child.kill("SIGTERM")
    const exited = await waitForProcessExit(exit, 2_000)
    if (!exited && child.exitCode === null) {
      child.kill("SIGKILL")
      await exit
    }
  }
  return {
    write: async (frame, timestampMs, durationMs) => {
      if (completed || finishingPromise || cancelPromise) throw new Error("ffmpeg input closed before recording finished")
      const envelope = mjpegMatroskaFrame(timestampMs, durationMs, frame.length)
      await writeStreamChunk(child.stdin, envelope.header)
      await writeStreamChunk(child.stdin, frame)
      await writeStreamChunk(child.stdin, envelope.trailer)
    },
    finish: async () => {
      if (completed) return
      if (cancelPromise) throw new Error("ffmpeg recording was cancelled")
      if (finishingPromise) return finishingPromise
      finishingPromise = (async () => {
        child.stdin.end()
        const exited = await waitForProcessExit(exit, 30_000)
        if (!exited) {
          await terminate()
          throw new Error("ffmpeg did not finish within 30000ms")
        }
        const error = await exit
        if (error) throw error
        await fs.rename(temporaryOutputPath, options.outputPath)
        completed = true
      })().catch(async (error: unknown) => {
        await fs.rm(temporaryOutputPath, { force: true })
        throw error
      })
      return finishingPromise
    },
    cancel: async () => {
      if (completed) return
      if (cancelPromise) return cancelPromise
      cancelPromise = (async () => {
        await terminate()
        await fs.rm(temporaryOutputPath, { force: true })
      })()
      return cancelPromise
    },
  }
}

async function writeStreamChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error("ffmpeg input closed before recording finished"))
    }
    const cleanup = () => {
      stream.removeListener("error", onError)
      stream.removeListener("close", onClose)
    }
    stream.once("error", onError)
    stream.once("close", onClose)
    stream.write(chunk, (error?: Error | null) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    })
  })
}

async function waitForProcessExit(exit: Promise<Error | undefined>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs)
  })
  const result = await Promise.race([exit.then(() => true as const), timedOut])
  if (timeout) clearTimeout(timeout)
  return result
}
