import type {
  ChromeTabCaptureAudioConstraints,
  ChromeTabCaptureVideoConstraints,
  OffscreenCancelRecordingMessage,
  OffscreenCancelRecordingResult,
  OffscreenMessage,
  OffscreenResult,
  OffscreenStartRecordingMessage,
  OffscreenStartRecordingResult,
  OffscreenStatusRecordingMessage,
  OffscreenStatusRecordingResult,
  OffscreenStopRecordingMessage,
  OffscreenStopRecordingResult,
} from "./recording-types.ts"

type RecordingState = {
  readonly recorder: MediaRecorder
  readonly stream: MediaStream
  readonly pendingChunks: Set<Promise<void>>
  readonly startedAt: number
  readonly tabId: number
}

const recordings = new Map<number, RecordingState>()

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true
})

async function handleMessage(message: OffscreenMessage): Promise<OffscreenResult> {
  if (message.action === "recording.start") {
    return handleStartRecording(message)
  }
  if (message.action === "recording.stop") {
    return handleStopRecording(message)
  }
  if (message.action === "recording.status") {
    return handleStatusRecording(message)
  }
  return handleCancelRecording(message)
}

async function handleStartRecording(message: OffscreenStartRecordingMessage): Promise<OffscreenStartRecordingResult> {
  if (recordings.has(message.tabId)) {
    return { success: false, error: `Recording already in progress for tab ${message.tabId}` }
  }

  let stream: MediaStream | undefined
  try {
    const audioConstraints: ChromeTabCaptureAudioConstraints | false = message.audio
      ? {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      }
      : false
    const videoConstraints: ChromeTabCaptureVideoConstraints = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId,
        minFrameRate: message.frameRate,
        maxFrameRate: message.frameRate,
      },
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints,
    } as MediaStreamConstraints)
    const mimeType = selectWebmMimeType()
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: message.videoBitsPerSecond,
      audioBitsPerSecond: message.audioBitsPerSecond,
    })
    const startedAt = Date.now()
    const pendingChunks = new Set<Promise<void>>()

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return
      }
      const pendingChunk = event.data.arrayBuffer().then((arrayBuffer) => {
        chrome.runtime.sendMessage({
          action: "recording.chunk",
          tabId: message.tabId,
          data: Array.from(new Uint8Array(arrayBuffer)),
        })
      }).finally(() => {
        pendingChunks.delete(pendingChunk)
      })
      pendingChunks.add(pendingChunk)
    }
    recorder.onerror = () => {
      handleCancelRecordingForTab(message.tabId)
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MediaRecorder failed to start within 5 seconds"))
      }, 5_000)
      recorder.onstart = () => {
        clearTimeout(timeout)
        resolve()
      }
      recorder.start(1_000)
    })

    recordings.set(message.tabId, { recorder, stream, pendingChunks, startedAt, tabId: message.tabId })
    return { success: true, tabId: message.tabId, startedAt, mimeType: recorder.mimeType || mimeType || "video/webm" }
  } catch (error) {
    stream?.getTracks().map((track) => {
      track.stop()
      return undefined
    })
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleStopRecording(message: OffscreenStopRecordingMessage): Promise<OffscreenStopRecordingResult> {
  const recording = recordings.get(message.tabId)
  if (!recording) {
    return { success: false, error: `No active recording for tab ${message.tabId}` }
  }

  try {
    await new Promise<void>((resolve) => {
      const previousStop = recording.recorder.onstop
      recording.recorder.onstop = (event) => {
        if (previousStop) {
          previousStop.call(recording.recorder, event)
        }
        resolve()
      }
      if (recording.recorder.state === "inactive") {
        resolve()
        return
      }
      recording.recorder.stop()
    })
    await Promise.allSettled(recording.pendingChunks)
    recording.stream.getTracks().map((track) => {
      track.stop()
      return undefined
    })
    recordings.delete(message.tabId)
    chrome.runtime.sendMessage({ action: "recording.chunk", tabId: message.tabId, final: true })
    return { success: true, tabId: message.tabId, duration: Date.now() - recording.startedAt }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function handleStatusRecording(message: OffscreenStatusRecordingMessage): OffscreenStatusRecordingResult {
  const recording = recordings.get(message.tabId)
  if (!recording) {
    return { isRecording: false, tabId: message.tabId }
  }
  return {
    isRecording: recording.recorder.state === "recording",
    tabId: message.tabId,
    startedAt: recording.startedAt,
  }
}

function handleCancelRecording(message: OffscreenCancelRecordingMessage): OffscreenCancelRecordingResult {
  return handleCancelRecordingForTab(message.tabId)
}

function handleCancelRecordingForTab(tabId: number): OffscreenCancelRecordingResult {
  const recording = recordings.get(tabId)
  if (!recording) {
    return { success: true, tabId }
  }
  try {
    if (recording.recorder.state !== "inactive") {
      recording.recorder.stop()
    }
    recording.stream.getTracks().map((track) => {
      track.stop()
      return undefined
    })
    recordings.delete(tabId)
    chrome.runtime.sendMessage({ action: "recording.cancelled", tabId })
    return { success: true, tabId }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function selectWebmMimeType(): string {
  return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((mimeType) => {
    return MediaRecorder.isTypeSupported(mimeType)
  }) ?? ""
}
