import type { RecordingQuality } from "./relay-schema.ts"

export function formatRecordingQuality(quality: RecordingQuality | undefined): string {
  if (!quality) return "Capture quality: unavailable (tab capture or older relay)."
  return [
    `Capture: ${quality.width}×${quality.height}, output ${quality.frameRate} fps; source surface ${quality.sourceWidth ?? "?"}×${quality.sourceHeight ?? "?"} CSS px`,
    `Source frames: ${quality.sourceFrameCount} received (${quality.achievedSourceFrameRate.toFixed(1)}/s), ${quality.encodedSourceFrameCount} retained (${quality.achievedEncodedSourceFrameRate.toFixed(1)}/s), ${quality.coalescedFrameCount} coalesced, ${quality.droppedFrameCount} dropped`,
    quality.screenshotFallback
      ? "WARNING: no compositor frames arrived; this video holds a single stop-time screenshot."
      : "Source counts are compositor events, not a measurement of distinct motion. Inspect the video before sharing.",
  ].join("\n")
}
