import { describe, expect, it } from "vitest"
import { decodeRecordingFrame, encodeRecordingFrame, maxRecordingFramePayloadBytes } from "../src/recording-protocol.ts"

describe("recording frame protocol", () => {
  it("encodes a byte-exact big-endian header and round trips data", () => {
    const encoded = encodeRecordingFrame({ tabId: 7, sequence: 3, final: false, payload: Uint8Array.of(0xaa, 0xbb) })
    expect(Array.from(encoded)).toEqual([
      0x42, 0x43, 0x52, 0x44, 1, 0, 0, 20,
      0, 0, 0, 7,
      0, 0, 0, 3,
      0, 0, 0, 2,
      0xaa, 0xbb,
    ])
    expect(decodeRecordingFrame(encoded)).toEqual({
      tabId: 7,
      sequence: 3,
      final: false,
      payload: Uint8Array.of(0xaa, 0xbb),
    })
  })

  it("round trips a final frame", () => {
    expect(decodeRecordingFrame(encodeRecordingFrame({
      tabId: 1,
      sequence: 0xffff_ffff,
      final: true,
      payload: new Uint8Array(),
    }))).toMatchObject({ tabId: 1, sequence: 0xffff_ffff, final: true, payload: new Uint8Array() })
  })

  it.each([
    ["short header", new Uint8Array(19), "shorter than its header"],
    ["wrong magic", Uint8Array.of(0, 0, 0, 0, 1, 1, 0, 20, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0), "magic"],
    ["unknown version", Uint8Array.of(0x42, 0x43, 0x52, 0x44, 2, 1, 0, 20, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0), "version"],
    ["unknown flags", Uint8Array.of(0x42, 0x43, 0x52, 0x44, 1, 2, 0, 20, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0), "flags"],
    ["wrong header length", Uint8Array.of(0x42, 0x43, 0x52, 0x44, 1, 1, 0, 19, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0), "header length"],
    ["zero tab", Uint8Array.of(0x42, 0x43, 0x52, 0x44, 1, 1, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), "tabId"],
  ])("rejects %s", (_label, frame, message) => {
    expect(() => decodeRecordingFrame(frame as Uint8Array)).toThrow(message as string)
  })

  it("rejects mismatched and oversized payload lengths", () => {
    const mismatched = encodeRecordingFrame({ tabId: 1, sequence: 0, final: false, payload: Uint8Array.of(1) })
    new DataView(mismatched.buffer).setUint32(16, 2)
    expect(() => decodeRecordingFrame(mismatched)).toThrow("payload length")

    const oversized = new Uint8Array(20)
    oversized.set([0x42, 0x43, 0x52, 0x44, 1, 0, 0, 20], 0)
    const view = new DataView(oversized.buffer)
    view.setUint32(8, 1)
    view.setUint32(16, maxRecordingFramePayloadBytes + 1)
    expect(() => decodeRecordingFrame(oversized)).toThrow("exceeds")
  })
})
