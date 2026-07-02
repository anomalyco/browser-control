import fs from "node:fs/promises"
import path from "node:path"
import type { ExtensionCommand, JsonObject } from "./protocol.ts"
import { getObject } from "./relay-helpers.ts"
import type { ConnectedTarget } from "./relay-types.ts"

const defaultMaxDurationMs = 15 * 60 * 1_000
const defaultCdpFrameRate = 5
const maxCdpFrameRate = 15

export type RecordingMode = "auto" | "tab-capture" | "cdp"
export type ActiveRecordingMode = "tab-capture" | "cdp"
export type RecordingArtifactType = "webm" | "frame-directory"

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
  artifactType: "frame-directory"
  frameRate: number
  captureTimer?: ReturnType<typeof setTimeout>
  frameCount: number
  totalSize: number
  framePaths: string[]
  stopped: boolean
  capturePromise?: Promise<void>
}

type ActiveRecording = TabCaptureRecording | CdpRecording

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
  private lastRecordingMetadataTabId: number | undefined

  constructor(readonly options: {
    readonly sendToExtension: (command: Omit<ExtensionCommand, "id">) => Promise<JsonObject>
    readonly sendDebuggerCommand: SendDebuggerCommand
    readonly isExtensionConnected: () => boolean
  }) {}

  async startRecording(options: RecordingStartOptions): Promise<RecordingStartResult> {
    if (!this.options.isExtensionConnected()) {
      return { success: false, error: "Browser Control extension is not connected" }
    }
    if (this.activeRecordings.has(options.tabId)) {
      return { success: false, error: "Recording already in progress for this tab" }
    }
    const mode = selectRecordingMode(options)
    if (mode === "cdp") {
      return this.startCdpRecording(options)
    }

    await fs.mkdir(path.dirname(options.outputPath), { recursive: true })
    const result = parseExtensionStartResult(await this.options.sendToExtension({
      method: "recording.start",
      params: recordingStartParams(options),
    }))
    if (!result.success) {
      return result
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
    const maxDurationMs = options.maxDurationMs ?? defaultMaxDurationMs
    if (maxDurationMs > 0 && Number.isFinite(maxDurationMs)) {
      recording.maxDurationTimer = setTimeout(() => {
        void this.stopRecording({ tabId: result.tabId }).catch((error) => {
          console.error("Recording max duration stop failed", error)
        })
      }, maxDurationMs)
    }
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

    const finalResult = new Promise<RecordingStopResult>((resolve) => {
      const timeout = setTimeout(() => {
        delete recording.resolveStop
        this.cleanupRecording(recording.tabId)
        resolve({ success: false, error: "Timeout waiting for recording data" })
      }, 30_000)
      recording.resolveStop = (result) => {
        clearTimeout(timeout)
        resolve(result)
      }
    })

    try {
      const result = parseExtensionStopResult(await this.options.sendToExtension({
        method: "recording.stop",
        params: { tabId: recording.tabId },
      }))
      if (!result.success) {
        delete recording.resolveStop
        this.cleanupRecording(recording.tabId)
        return result
      }
      return await finalResult
    } catch (error) {
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
        size: recording.totalSize,
        mode: "cdp",
        artifactType: "frame-directory",
        frameCount: recording.frameCount,
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

  cleanupAll(reason: string): void {
    Array.from(this.activeRecordings.values()).map((recording) => {
      if (recording.resolveStop) {
        recording.resolveStop({ success: false, error: reason })
      }
      this.cleanupRecording(recording.tabId)
      return undefined
    })
  }

  async abortRecordingForTab(options: { readonly tabId: number; readonly reason: string }): Promise<void> {
    const recording = this.activeRecordings.get(options.tabId)
    if (!recording) {
      return
    }
    recording.resolveStop?.({ success: false, error: options.reason })
    if (recording.mode === "cdp") {
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

  private cleanupRecording(tabId: number): void {
    const recording = this.activeRecordings.get(tabId)
    if (recording?.maxDurationTimer) {
      clearTimeout(recording.maxDurationTimer)
    }
    if (recording?.mode === "cdp") {
      recording.stopped = true
      if (recording.captureTimer) {
        clearTimeout(recording.captureTimer)
      }
    }
    this.activeRecordings.delete(tabId)
  }

  private async startCdpRecording(options: RecordingStartOptions): Promise<RecordingStartResult> {
    if (options.audio === true) {
      return { success: false, error: "CDP recording captures video frames only; audio is not supported" }
    }
    await fs.mkdir(options.outputPath, { recursive: true })
    const startedAt = Date.now()
    const requestedFrameRate = options.frameRate ?? defaultCdpFrameRate
    if (requestedFrameRate <= 0 || !Number.isFinite(requestedFrameRate)) {
      return { success: false, error: "Recording frameRate must be a positive finite number" }
    }
    const frameRate = Math.min(requestedFrameRate, maxCdpFrameRate)
    const recording: CdpRecording = {
      tabId: options.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      outputPath: options.outputPath,
      mode: "cdp",
      artifactType: "frame-directory",
      startedAt,
      frameRate,
      frameCount: 0,
      totalSize: 0,
      framePaths: [],
      stopped: false,
    }
    const maxDurationMs = options.maxDurationMs ?? defaultMaxDurationMs
    if (maxDurationMs > 0 && Number.isFinite(maxDurationMs)) {
      recording.maxDurationTimer = setTimeout(() => {
        void this.stopRecording({ tabId: options.tabId }).catch((error) => {
          console.error("Recording max duration stop failed", error)
        })
      }, maxDurationMs)
    }
    this.activeRecordings.set(options.tabId, recording)
    this.captureCdpFrame(recording)
    return {
      success: true,
      tabId: options.tabId,
      startedAt,
      path: options.outputPath,
      mimeType: "image/jpeg",
      mode: "cdp",
      artifactType: "frame-directory",
    }
  }

  private captureCdpFrame(recording: CdpRecording): void {
    if (recording.stopped || recording.capturePromise) {
      return
    }
    recording.capturePromise = this.writeCdpFrame(recording).finally(() => {
      delete recording.capturePromise
      this.scheduleCdpFrame(recording)
    })
    recording.capturePromise.catch((error: unknown) => {
      if (!recording.stopped) {
        console.error("CDP recording frame capture failed", error)
      }
    })
  }

  private scheduleCdpFrame(recording: CdpRecording): void {
    if (recording.stopped) {
      return
    }
    const delayMs = Math.max(1, Math.floor(1_000 / recording.frameRate))
    recording.captureTimer = setTimeout(() => {
      delete recording.captureTimer
      this.captureCdpFrame(recording)
    }, delayMs)
  }

  private async writeCdpFrame(recording: CdpRecording): Promise<void> {
    const result = await this.options.sendDebuggerCommand({
      tabId: recording.tabId,
      method: "Page.captureScreenshot",
      params: { format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false },
    })
    const data = typeof result.data === "string" ? result.data : undefined
    if (!data) {
      throw new Error("Page.captureScreenshot did not return image data")
    }
    const frameIndex = recording.frameCount + 1
    const framePath = path.join(recording.outputPath, `frame-${String(frameIndex).padStart(6, "0")}.jpg`)
    const buffer = Buffer.from(data, "base64")
    await fs.writeFile(framePath, buffer)
    recording.frameCount = frameIndex
    recording.totalSize += buffer.byteLength
    recording.framePaths.push(framePath)
  }

  private async stopCdpRecording(recording: CdpRecording): Promise<RecordingStopResult> {
    const stoppedAt = Date.now()
    this.cleanupRecording(recording.tabId)
    await recording.capturePromise?.catch((error: unknown) => {
      console.error("CDP recording final frame capture failed", error)
    })
    const metadata = {
      mode: "cdp",
      artifactType: "frame-directory",
      tabId: recording.tabId,
      ...(recording.sessionId ? { sessionId: recording.sessionId } : {}),
      startedAt: new Date(recording.startedAt).toISOString(),
      stoppedAt: new Date(stoppedAt).toISOString(),
      durationMs: stoppedAt - recording.startedAt,
      frameRate: recording.frameRate,
      frameCount: recording.frameCount,
      framePattern: "frame-000001.jpg",
      mimeType: "image/jpeg",
    }
    const metadataText = `${JSON.stringify(metadata, null, 2)}\n`
    await fs.writeFile(path.join(recording.outputPath, "metadata.json"), metadataText, "utf8")
    const size = recording.totalSize + Buffer.byteLength(metadataText)
    return {
      success: true,
      tabId: recording.tabId,
      duration: stoppedAt - recording.startedAt,
      path: recording.outputPath,
      size,
      mode: "cdp",
      artifactType: "frame-directory",
      frameCount: recording.frameCount,
    }
  }

  private async cancelCdpRecording(recording: CdpRecording): Promise<void> {
    this.cleanupRecording(recording.tabId)
    await recording.capturePromise?.catch(() => {})
    await Promise.all(recording.framePaths.map(async (framePath) => {
      await fs.rm(framePath, { force: true })
    }))
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
