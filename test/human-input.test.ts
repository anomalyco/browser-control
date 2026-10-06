import { describe, expect, it } from "vitest"
import { forgetTab, glide, prepareMouseParams, trajectory } from "../src/human-input.ts"

describe("human-input", () => {
  it("builds a fast curved trajectory bounded under 300ms", () => {
    const path = trajectory({ x: 100, y: 120 }, { x: 520, y: 380 })
    expect(path.length).toBeGreaterThanOrEqual(5)
    expect(path.length).toBeLessThanOrEqual(22)
    const totalDelay = path.reduce((sum, step) => sum + step.delay, 0)
    expect(totalDelay).toBeGreaterThanOrEqual(70)
    expect(totalDelay).toBeLessThanOrEqual(300)
  })

  it("splits wheel scrolling into an eased burst that sums to the original delta", () => {
    const frames = glide(0, 600)
    expect(frames.length).toBeGreaterThanOrEqual(4)
    expect(frames.length).toBeLessThanOrEqual(12)
    const totalY = frames.reduce((sum, frame) => sum + frame.y, 0)
    expect(totalY).toBeCloseTo(600, 0)
    expect(frames[0]!.y).toBeGreaterThan(frames.at(-1)!.y)
  })

  it("keeps off-center aim consistent across move, press, and release on the same target", () => {
    const previous = process.env.BROWSER_CONTROL_HUMAN_INPUT
    process.env.BROWSER_CONTROL_HUMAN_INPUT = "1"
    try {
      const move = { type: "mouseMoved", x: 240, y: 180 }
      const down = { type: "mousePressed", x: 240, y: 180 }
      const up = { type: "mouseReleased", x: 240, y: 180 }
      prepareMouseParams(42, "Input.dispatchMouseEvent", move)
      prepareMouseParams(42, "Input.dispatchMouseEvent", down)
      prepareMouseParams(42, "Input.dispatchMouseEvent", up)
      expect(down.x).toBe(move.x)
      expect(down.y).toBe(move.y)
      expect(up.x).toBe(move.x)
      expect(up.y).toBe(move.y)
      expect(Math.abs(move.x - 240)).toBeLessThanOrEqual(2.5)
      expect(Math.abs(move.y - 180)).toBeLessThanOrEqual(2.0)
    } finally {
      forgetTab(42)
      if (previous === undefined) delete process.env.BROWSER_CONTROL_HUMAN_INPUT
      else process.env.BROWSER_CONTROL_HUMAN_INPUT = previous
    }
  })
})
