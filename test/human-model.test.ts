import { describe, expect, it } from "vitest"
import { getHumanModelProfile, setHumanModelProfile, trajectory } from "../src/human-input.ts"
import {
  DEFAULT_HUMAN_MODEL_PROFILE,
  analyzeReach,
  fitHumanModel,
  type ObstacleRunPayload,
  type RecordedReach,
} from "../src/human-model.ts"

function makeSyntheticReach(options: {
  readonly from: { readonly x: number; readonly y: number }
  readonly to: { readonly x: number; readonly y: number }
  readonly durationMs: number
  readonly bowRatio: number
  readonly overshootPx?: number
}): RecordedReach {
  const { from, to, durationMs, bowRatio, overshootPx = 0 } = options
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  const tx = dx / dist
  const ty = dy / dist
  const nx = -ty
  const ny = tx
  const samples = Array.from({ length: 24 }, (_, idx) => {
    const u = idx / 23
    const t = u * durationMs
    let par: number
    if (overshootPx > 0) {
      const split = 0.8
      if (u <= split) {
        const localU = Math.pow(u / split, 0.72)
        const jerk = localU * localU * localU * (10 - 15 * localU + 6 * localU * localU)
        par = (dist + overshootPx) * jerk
      } else {
        const localU = (u - split) / (1 - split)
        const jerk = localU * localU * localU * (10 - 15 * localU + 6 * localU * localU)
        par = dist + overshootPx - overshootPx * jerk
      }
    } else {
      const s = Math.pow(u, 0.72)
      const jerk = s * s * s * (10 - 15 * s + 6 * s * s)
      par = dist * jerk
    }
    const perp = bowRatio * dist * Math.sin(Math.PI * u) + Math.sin(u * Math.PI * 5) * 0.9
    return {
      x: from.x + tx * par + nx * perp,
      y: from.y + ty * par + ny * perp,
      t,
    }
  })
  return {
    from,
    to,
    targetCenter: { x: to.x - 1.4, y: to.y + 0.9 },
    targetWidth: 42,
    targetHeight: 36,
    durationMs,
    settleMs: 28,
    holdMs: 62,
    samples,
  }
}

describe("human-model fitting and calibration", () => {
  it("analyzes reach curvature, velocity peak, and overshoot submovements", () => {
    const direct = analyzeReach(
      makeSyntheticReach({
        from: { x: 100, y: 200 },
        to: { x: 520, y: 240 },
        durationMs: 240,
        bowRatio: -0.075,
      }),
    )
    expect(direct).toBeDefined()
    expect(direct!.distance).toBeGreaterThan(400)
    expect(direct!.pathRatio).toBeGreaterThan(1.01)
    expect(direct!.bowRatio).toBeGreaterThan(0.05)
    expect(direct!.peakVelocityU).toBeLessThan(0.48)
    expect(direct!.mode).toBe("direct")

    const overshot = analyzeReach(
      makeSyntheticReach({
        from: { x: 80, y: 120 },
        to: { x: 560, y: 310 },
        durationMs: 260,
        bowRatio: 0.06,
        overshootPx: 7.5,
      }),
    )
    expect(overshot?.mode).toBe("overshoot")
    expect(overshot?.overshootPx).toBeGreaterThan(4)
  })

  it("fits a computational model from team obstacle course runs and drives trajectory()", () => {
    const run: ObstacleRunPayload = {
      handle: "kit",
      device: "mouse",
      sampleRateHz: 120,
      viewport: { width: 1440, height: 900, dpr: 2 },
      courseTimeMs: 38_400,
      reaches: [
        makeSyntheticReach({ from: { x: 100, y: 120 }, to: { x: 460, y: 180 }, durationMs: 210, bowRatio: -0.06 }),
        makeSyntheticReach({ from: { x: 460, y: 180 }, to: { x: 180, y: 420 }, durationMs: 245, bowRatio: 0.08, overshootPx: 6.2 }),
        makeSyntheticReach({ from: { x: 180, y: 420 }, to: { x: 740, y: 360 }, durationMs: 270, bowRatio: -0.07 }),
        makeSyntheticReach({ from: { x: 740, y: 360 }, to: { x: 640, y: 280 }, durationMs: 165, bowRatio: 0.05 }),
      ],
      scrolls: [
        {
          totalDeltaX: 0,
          totalDeltaY: 680,
          durationMs: 150,
          frameCount: 9,
          frames: Array.from({ length: 9 }, () => ({ dx: 0, dy: 75, dt: 16 })),
        },
      ],
      keys: [
        { key: "s", holdMs: 64, ikiMs: 88, rolloverMs: 12 },
        { key: "h", holdMs: 58, ikiMs: 76, rolloverMs: 8 },
        { key: "i", holdMs: 61, ikiMs: 82, rolloverMs: -4 },
        { key: "p", holdMs: 70, ikiMs: 95, rolloverMs: 0 },
      ],
    }

    const fitted = fitHumanModel([run], "team-kit")
    expect(fitted.sampleCount.runs).toBe(1)
    expect(fitted.sampleCount.reaches).toBe(4)
    expect(fitted.reach.ballisticExponent).toBeGreaterThan(0.58)
    expect(fitted.reach.ballisticExponent).toBeLessThan(0.92)
    expect(fitted.velocityCurve).toHaveLength(20)

    setHumanModelProfile(fitted)
    expect(getHumanModelProfile().source).toBe("team-kit")
    const steps = trajectory({ x: 80, y: 90 }, { x: 540, y: 320 })
    expect(steps.length).toBeGreaterThan(5)
    setHumanModelProfile(DEFAULT_HUMAN_MODEL_PROFILE)
  })
})
