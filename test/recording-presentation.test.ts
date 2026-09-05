import { describe, expect, it } from "vitest"
import { formatRecordingQuality } from "../src/recording-presentation.ts"
import type { RecordingQuality } from "../src/relay-schema.ts"

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
