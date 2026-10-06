export type Point = { readonly x: number; readonly y: number }

export type RawPointerSample = {
  readonly x: number
  readonly y: number
  readonly t: number
}

export type RecordedReach = {
  readonly from: Point
  readonly to: Point
  readonly targetCenter: Point
  readonly targetWidth: number
  readonly targetHeight: number
  readonly durationMs: number
  readonly settleMs: number
  readonly holdMs: number
  readonly releaseSlip?: { readonly dx: number; readonly dy: number }
  readonly samples: readonly RawPointerSample[]
  readonly stage?: string
}

export type RecordedScrollBurst = {
  readonly totalDeltaX: number
  readonly totalDeltaY: number
  readonly durationMs: number
  readonly frameCount: number
  readonly frames: readonly { readonly dx: number; readonly dy: number; readonly dt: number }[]
  readonly pointerDriftPx?: number
}

export type RecordedKeystroke = {
  readonly key: string
  readonly holdMs: number
  readonly ikiMs: number
  readonly rolloverMs?: number
}

export type ObstacleRunPayload = {
  readonly id?: string
  readonly handle: string
  readonly device: "mouse" | "trackpad" | "unknown"
  readonly sampleRateHz: number
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number }
  readonly createdAt?: number
  readonly courseTimeMs: number
  readonly reaches: readonly RecordedReach[]
  readonly scrolls: readonly RecordedScrollBurst[]
  readonly keys: readonly RecordedKeystroke[]
}

export type HumanModelProfile = {
  readonly version: 1
  readonly source: string
  readonly updatedAt: number
  readonly sampleCount: {
    readonly runs: number
    readonly reaches: number
    readonly scrolls: number
    readonly keys: number
  }
  readonly reach: {
    readonly baseMs: number
    readonly sqrtScale: number
    readonly fittsAMs: number
    readonly fittsBMsPerBit: number
    readonly throughputBps: number
    readonly minDurationMs: number
    readonly maxDurationMs: number
    readonly durationJitter: number
    readonly ballisticExponent: number
    readonly peakVelocityU: number
    readonly wristBias: number
    readonly bowMinRatio: number
    readonly bowMaxRatio: number
    readonly pathRatioMedian: number
    readonly c1TangentialMin: number
    readonly c1TangentialMax: number
    readonly c2TangentialMin: number
    readonly c2TangentialMax: number
    readonly c2NormalRatio: number
  }
  readonly submovements: {
    readonly overshootRate: number
    readonly undershootRate: number
    readonly overshootMinPx: number
    readonly overshootMaxPx: number
    readonly undershootMinPx: number
    readonly undershootMaxPx: number
    readonly lateralSpreadPx: number
    readonly overshootSplitMin: number
    readonly overshootSplitMax: number
    readonly undershootSplitMin: number
    readonly undershootSplitMax: number
  }
  readonly tremor: {
    readonly waveAmpPerPx: number
    readonly waveAmpMinPx: number
    readonly waveAmpMaxPx: number
    readonly freq1MinHz: number
    readonly freq1MaxHz: number
    readonly freq2MinHz: number
    readonly freq2MaxHz: number
    readonly noiseScalePx: number
  }
  readonly click: {
    readonly aimBiasX: number
    readonly aimBiasY: number
    readonly aimSigmaX: number
    readonly aimSigmaY: number
    readonly aimMaxX: number
    readonly aimMaxY: number
    readonly settleMinMs: number
    readonly settleMaxMs: number
    readonly holdMinMs: number
    readonly holdMaxMs: number
  }
  readonly scroll: {
    readonly baseDurationMs: number
    readonly durationPerPx: number
    readonly easePower: number
    readonly minFrames: number
    readonly maxFrames: number
    readonly frameGapMinMs: number
    readonly frameGapMaxMs: number
  }
  readonly keyboard: {
    readonly gapMinMs: number
    readonly gapMaxMs: number
    readonly holdMedianMs: number
    readonly rolloverRate: number
  }
  readonly velocityCurve: readonly number[]
}

export type ReachAnalysis = {
  readonly distance: number
  readonly durationMs: number
  readonly indexOfDifficulty: number
  readonly throughputBps: number
  readonly pathRatio: number
  readonly bowRatio: number
  readonly signedBowRatio: number
  readonly wristBiasSample?: number
  readonly peakVelocityU: number
  readonly mode: "overshoot" | "undershoot" | "direct"
  readonly overshootPx: number
  readonly undershootPx: number
  readonly splitU: number
  readonly tremorRmsPx: number
  readonly tremorFreqHz: number
  readonly aimDx: number
  readonly aimDy: number
  readonly settleMs: number
  readonly holdMs: number
  readonly velocityBins: readonly number[]
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const pos = clamp(q, 0, 1) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const frac = pos - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((acc, v) => acc + v, 0) / values.length
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function blend(empirical: number, prior: number, count: number, priorWeight = 6): number {
  if (!Number.isFinite(empirical) || count <= 0) return prior
  const w = count / (count + priorWeight)
  return empirical * w + prior * (1 - w)
}

export const DEFAULT_HUMAN_MODEL_PROFILE: HumanModelProfile = {
  version: 1,
  source: "baseline-biomechanical-v1",
  updatedAt: 0,
  sampleCount: { runs: 0, reaches: 0, scrolls: 0, keys: 0 },
  reach: {
    baseMs: 110,
    sqrtScale: 5.4,
    fittsAMs: 95,
    fittsBMsPerBit: 82,
    throughputBps: 5.4,
    minDurationMs: 110,
    maxDurationMs: 290,
    durationJitter: 0.08,
    ballisticExponent: 0.74,
    peakVelocityU: 0.39,
    wristBias: 0.045,
    bowMinRatio: 0.035,
    bowMaxRatio: 0.13,
    pathRatioMedian: 1.038,
    c1TangentialMin: 0.22,
    c1TangentialMax: 0.34,
    c2TangentialMin: 0.64,
    c2TangentialMax: 0.78,
    c2NormalRatio: 0.52,
  },
  submovements: {
    overshootRate: 0.28,
    undershootRate: 0.22,
    overshootMinPx: 3.5,
    overshootMaxPx: 8.5,
    undershootMinPx: 6.0,
    undershootMaxPx: 12.5,
    lateralSpreadPx: 3.0,
    overshootSplitMin: 0.76,
    overshootSplitMax: 0.83,
    undershootSplitMin: 0.72,
    undershootSplitMax: 0.79,
  },
  tremor: {
    waveAmpPerPx: 0.012,
    waveAmpMinPx: 0.45,
    waveAmpMaxPx: 2.1,
    freq1MinHz: 1.4,
    freq1MaxHz: 2.6,
    freq2MinHz: 3.2,
    freq2MaxHz: 5.1,
    noiseScalePx: 0.42,
  },
  click: {
    aimBiasX: 0,
    aimBiasY: 0,
    aimSigmaX: 1.8,
    aimSigmaY: 1.4,
    aimMaxX: 2.5,
    aimMaxY: 2.0,
    settleMinMs: 18,
    settleMaxMs: 45,
    holdMinMs: 35,
    holdMaxMs: 72,
  },
  scroll: {
    baseDurationMs: 90,
    durationPerPx: 0.18,
    easePower: 3,
    minFrames: 4,
    maxFrames: 12,
    frameGapMinMs: 14,
    frameGapMaxMs: 16.5,
  },
  keyboard: {
    gapMinMs: 18,
    gapMaxMs: 52,
    holdMedianMs: 68,
    rolloverRate: 0.24,
  },
  velocityCurve: [
    0.12, 0.44, 0.88, 1.32, 1.68, 1.89, 1.94, 1.84, 1.64, 1.4,
    1.16, 0.94, 0.74, 0.57, 0.42, 0.3, 0.21, 0.14, 0.08, 0.03,
  ],
}

export function analyzeReach(reach: RecordedReach): ReachAnalysis | undefined {
  const dx = reach.to.x - reach.from.x
  const dy = reach.to.y - reach.from.y
  const distance = Math.hypot(dx, dy)
  if (!Number.isFinite(distance) || distance < 18 || reach.samples.length < 4) {
    return undefined
  }
  const t0 = reach.samples[0]!.t
  const tEnd = reach.samples[reach.samples.length - 1]!.t
  const rawDuration = reach.durationMs > 0 ? reach.durationMs : tEnd - t0
  const durationMs = clamp(rawDuration, 35, 2500)
  const targetWidth = Math.max(8, reach.targetWidth || 36)
  const indexOfDifficulty = Math.log2(distance / targetWidth + 1)
  const throughputBps = indexOfDifficulty / (durationMs / 1000)

  const tangent = { x: dx / distance, y: dy / distance }
  const normal = { x: -tangent.y, y: tangent.x }

  let pathLen = 0
  let maxAbsPerp = 0
  let signedBow = 0
  let maxTangential = 0
  let maxTangentialU = 1
  const projections: { readonly u: number; readonly par: number; readonly perp: number }[] = []

  for (let i = 0; i < reach.samples.length; i += 1) {
    const sample = reach.samples[i]!
    if (i > 0) {
      const prev = reach.samples[i - 1]!
      pathLen += Math.hypot(sample.x - prev.x, sample.y - prev.y)
    }
    const u = clamp((sample.t - t0) / Math.max(1, tEnd - t0), 0, 1)
    const relX = sample.x - reach.from.x
    const relY = sample.y - reach.from.y
    const par = relX * tangent.x + relY * tangent.y
    const perp = relX * normal.x + relY * normal.y
    projections.push({ u, par, perp })
    if (u >= 0.12 && u <= 0.88 && Math.abs(perp) > maxAbsPerp) {
      maxAbsPerp = Math.abs(perp)
      signedBow = perp
    }
    if (par > maxTangential) {
      maxTangential = par
      maxTangentialU = u
    }
  }

  const pathRatio = clamp(pathLen / distance, 1, 2.4)
  const bowRatio = clamp(maxAbsPerp / distance, 0.005, 0.38)
  const signedBowRatio = clamp(signedBow / distance, -0.38, 0.38)
  const wristBiasSample =
    Math.abs(tangent.x) >= 0.38
      ? clamp(-signedBow / (tangent.x * distance), -0.2, 0.25)
      : undefined

  // Compute 20-bin normalized velocity curve v(u) / v_mean
  const binCount = 20
  const rawBins = new Array<number>(binCount).fill(0)
  for (let b = 0; b < binCount; b += 1) {
    const u0 = b / binCount
    const u1 = (b + 1) / binCount
    const p0 = interpolateProjection(projections, u0, distance)
    const p1 = interpolateProjection(projections, u1, distance)
    const segDist = Math.hypot(p1.par - p0.par, p1.perp - p0.perp)
    rawBins[b] = (segDist / distance) * binCount
  }
  const velocityBins = rawBins.map((v, i) => {
    const prev = rawBins[Math.max(0, i - 1)]!
    const next = rawBins[Math.min(binCount - 1, i + 1)]!
    return round(0.25 * prev + 0.5 * v + 0.25 * next, 3)
  })

  let peakBin = 6
  let peakVal = -1
  for (let b = 1; b < binCount - 2; b += 1) {
    if (velocityBins[b]! > peakVal) {
      peakVal = velocityBins[b]!
      peakBin = b
    }
  }
  const peakVelocityU = clamp((peakBin + 0.5) / binCount, 0.22, 0.62)

  // Submovement classification (Meyer's model)
  let mode: "overshoot" | "undershoot" | "direct" = "direct"
  let overshootPx = 0
  let undershootPx = 0
  let splitU = 1

  if (distance >= 110) {
    // Also detect reversal hooks at the end of the reach (where tangential progress peaks and pulls back >= 2.2px)
    const pullBackAmount = maxTangential - distance
    if (pullBackAmount >= 2.2 && maxTangentialU >= 0.55 && maxTangentialU <= 0.97) {
      mode = "overshoot"
      overshootPx = clamp(pullBackAmount, 2.2, 24)
      splitU = clamp(maxTangentialU, 0.68, 0.92)
    } else {
      for (let b = Math.max(peakBin + 2, 7); b <= 16; b += 1) {
        const vDip = velocityBins[b]!
        const vAfter = Math.max(velocityBins[b + 1] ?? 0, velocityBins[b + 2] ?? 0, velocityBins[b + 3] ?? 0)
        const uDip = (b + 0.5) / binCount
        const projDip = interpolateProjection(projections, uDip, distance)
        const remaining = distance - projDip.par
        if (vDip < peakVal * 0.35 && vAfter > vDip * 1.12 && remaining >= 3.5 && remaining <= Math.min(75, distance * 0.38)) {
          mode = "undershoot"
          undershootPx = clamp(remaining, 3.5, 42)
          splitU = clamp(uDip, 0.45, 0.86)
          break
        }
      }
    }
  }

  // Tremor residual: subtract smooth quadratic/sine arch from perpendicular projection
  let residualSqSum = 0
  let zeroCrossings = 0
  let prevResidual = 0
  for (let i = 0; i < projections.length; i += 1) {
    const pt = projections[i]!
    const smoothArch = signedBow * Math.sin(Math.PI * pt.u)
    const residual = pt.perp - smoothArch
    residualSqSum += residual * residual
    if (i > 1 && ((residual >= 0 && prevResidual < 0) || (residual < 0 && prevResidual >= 0))) {
      zeroCrossings += 1
    }
    prevResidual = residual
  }
  const tremorRmsPx = clamp(Math.sqrt(residualSqSum / Math.max(1, projections.length)), 0.15, 4.5)
  const tremorFreqHz = clamp((zeroCrossings / 2) / (durationMs / 1000), 1.0, 14.0)

  const scaleX = clamp(40 / Math.max(16, reach.targetWidth || 40), 0.5, 1.6)
  const scaleY = clamp(32 / Math.max(16, reach.targetHeight || 32), 0.5, 1.6)
  const aimDx = clamp((reach.to.x - reach.targetCenter.x) * scaleX, -8, 8)
  const aimDy = clamp((reach.to.y - reach.targetCenter.y) * scaleY, -6, 6)

  return {
    distance: round(distance, 1),
    durationMs: round(durationMs, 1),
    indexOfDifficulty: round(indexOfDifficulty, 3),
    throughputBps: round(throughputBps, 2),
    pathRatio: round(pathRatio, 4),
    bowRatio: round(bowRatio, 4),
    signedBowRatio: round(signedBowRatio, 4),
    ...(wristBiasSample !== undefined ? { wristBiasSample: round(wristBiasSample, 4) } : {}),
    peakVelocityU: round(peakVelocityU, 3),
    mode,
    overshootPx: round(overshootPx, 2),
    undershootPx: round(undershootPx, 2),
    splitU: round(splitU, 3),
    tremorRmsPx: round(tremorRmsPx, 3),
    tremorFreqHz: round(tremorFreqHz, 2),
    aimDx: round(aimDx, 2),
    aimDy: round(aimDy, 2),
    settleMs: clamp(reach.settleMs, 4, 260),
    holdMs: clamp(reach.holdMs, 16, 260),
    velocityBins,
  }
}

function interpolateProjection(
  projections: readonly { readonly u: number; readonly par: number; readonly perp: number }[],
  u: number,
  distance: number,
): { readonly par: number; readonly perp: number } {
  if (projections.length === 0) return { par: u * distance, perp: 0 }
  if (u <= projections[0]!.u) return { par: projections[0]!.par, perp: projections[0]!.perp }
  const last = projections[projections.length - 1]!
  if (u >= last.u) return { par: last.par, perp: last.perp }
  for (let i = 1; i < projections.length; i += 1) {
    const prev = projections[i - 1]!
    const curr = projections[i]!
    if (u <= curr.u) {
      const span = Math.max(1e-6, curr.u - prev.u)
      const t = (u - prev.u) / span
      return {
        par: prev.par + (curr.par - prev.par) * t,
        perp: prev.perp + (curr.perp - prev.perp) * t,
      }
    }
  }
  return { par: last.par, perp: last.perp }
}

function fitLinearRegression(xs: readonly number[], ys: readonly number[]): { readonly intercept: number; readonly slope: number } | undefined {
  if (xs.length < 3 || xs.length !== ys.length) return undefined
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx
    num += dx * (ys[i]! - my)
    den += dx * dx
  }
  if (den < 1e-6) return undefined
  const slope = num / den
  const intercept = my - slope * mx
  return { intercept, slope }
}

export function fitHumanModel(
  runs: readonly ObstacleRunPayload[],
  sourceLabel = "team-calibrated",
): HumanModelProfile {
  const prior = DEFAULT_HUMAN_MODEL_PROFILE
  const reachAnalyses: ReachAnalysis[] = []
  const allScrolls: RecordedScrollBurst[] = []
  const allKeys: RecordedKeystroke[] = []

  for (const run of runs) {
    for (const r of run.reaches) {
      const analyzed = analyzeReach(r)
      if (analyzed) reachAnalyses.push(analyzed)
    }
    for (const s of run.scrolls) {
      if (s.durationMs > 10 && Math.hypot(s.totalDeltaX, s.totalDeltaY) >= 24) {
        allScrolls.push(s)
      }
    }
    for (const k of run.keys) {
      if (k.holdMs > 5 && k.holdMs < 400) {
        allKeys.push(k)
      }
    }
  }

  const nReaches = reachAnalyses.length
  if (nReaches === 0 && allScrolls.length === 0 && allKeys.length === 0) {
    return {
      ...prior,
      source: sourceLabel,
      updatedAt: Date.now(),
    }
  }

  // 1. Fit Fitts's Law & fast runtime execution budget
  const fittsFit = fitLinearRegression(
    reachAnalyses.map((r) => r.indexOfDifficulty),
    reachAnalyses.map((r) => r.durationMs),
  )
  const sqrtFit = fitLinearRegression(
    reachAnalyses.map((r) => Math.sqrt(r.distance)),
    reachAnalyses.map((r) => r.durationMs),
  )

  const rawFittsA = clamp(fittsFit?.intercept ?? prior.reach.fittsAMs, 45, 240)
  const rawFittsB = clamp(fittsFit?.slope ?? prior.reach.fittsBMsPerBit, 35, 190)
  const throughputBps = round(
    blend(quantile(reachAnalyses.map((r) => r.throughputBps), 0.5), prior.reach.throughputBps, nReaches),
    2,
  )

  // Scale runtime trajectory duration so it preserves the user's relative speed while staying
  // inside Browser Control's responsive 105–295ms execution budget.
  const rawSqrtBase = clamp((sqrtFit?.intercept ?? 110) * 0.52, 88, 145)
  const rawSqrtSlope = clamp((sqrtFit?.slope ?? 5.4) * 0.48, 3.8, 7.6)
  const baseMs = round(blend(rawSqrtBase, prior.reach.baseMs, nReaches), 1)
  const sqrtScale = round(blend(rawSqrtSlope, prior.reach.sqrtScale, nReaches), 2)

  // 2. Peak velocity timing & Woodworth/Meyer ballistic exponent
  const medianPeakU = clamp(
    blend(quantile(reachAnalyses.map((r) => r.peakVelocityU), 0.5), prior.reach.peakVelocityU, nReaches),
    0.28,
    0.52,
  )
  const empiricalExponent = clamp(Math.log(0.5) / Math.log(medianPeakU), 0.58, 0.94)
  const ballisticExponent = round(blend(empiricalExponent, prior.reach.ballisticExponent, nReaches), 3)

  // 3. Curvature, path ratio, and wrist-pivot bias
  const bows = reachAnalyses.map((r) => r.bowRatio)
  const bowMinRatio = round(clamp(blend(quantile(bows, 0.25), prior.reach.bowMinRatio, nReaches), 0.018, 0.08), 3)
  const bowMaxRatio = round(
    clamp(blend(quantile(bows, 0.82), prior.reach.bowMaxRatio, nReaches), bowMinRatio + 0.025, 0.22),
    3,
  )
  const pathRatioMedian = round(
    clamp(blend(quantile(reachAnalyses.map((r) => r.pathRatio), 0.5), prior.reach.pathRatioMedian, nReaches), 1.01, 1.18),
    4,
  )
  const wristSamples = reachAnalyses
    .map((r) => r.wristBiasSample)
    .filter((v): v is number => v !== undefined)
  const wristBias = round(
    clamp(blend(quantile(wristSamples, 0.5), prior.reach.wristBias, wristSamples.length, 4), 0.01, 0.095),
    3,
  )

  // 4. Submovement rates & amplitudes on long reaches
  const longReaches = reachAnalyses.filter((r) => r.distance >= 120)
  const nLong = longReaches.length
  const overshoots = longReaches.filter((r) => r.mode === "overshoot")
  const undershoots = longReaches.filter((r) => r.mode === "undershoot")
  const overshootRate = round(
    clamp(blend(nLong > 0 ? overshoots.length / nLong : prior.submovements.overshootRate, prior.submovements.overshootRate, nLong, 5), 0.08, 0.55),
    3,
  )
  const undershootRate = round(
    clamp(
      blend(nLong > 0 ? undershoots.length / nLong : prior.submovements.undershootRate, prior.submovements.undershootRate, nLong, 5),
      0.06,
      Math.max(0.08, 0.75 - overshootRate),
    ),
    3,
  )
  const overshootMinPx = round(
    clamp(blend(quantile(overshoots.map((r) => r.overshootPx), 0.25), prior.submovements.overshootMinPx, overshoots.length, 3), 2.2, 7.0),
    2,
  )
  const overshootMaxPx = round(
    clamp(blend(quantile(overshoots.map((r) => r.overshootPx), 0.8), prior.submovements.overshootMaxPx, overshoots.length, 3), overshootMinPx + 1.5, 14.0),
    2,
  )
  const undershootMinPx = round(
    clamp(blend(quantile(undershoots.map((r) => r.undershootPx), 0.25), prior.submovements.undershootMinPx, undershoots.length, 3), 3.5, 9.0),
    2,
  )
  const undershootMaxPx = round(
    clamp(blend(quantile(undershoots.map((r) => r.undershootPx), 0.8), prior.submovements.undershootMaxPx, undershoots.length, 3), undershootMinPx + 2.0, 18.0),
    2,
  )

  // 5. Tremor & hand wave
  const tremorRmsList = reachAnalyses.map((r) => r.tremorRmsPx)
  const tremorFreqList = reachAnalyses.map((r) => r.tremorFreqHz)
  const noiseScalePx = round(
    clamp(blend(quantile(tremorRmsList, 0.5) * 0.48, prior.tremor.noiseScalePx, nReaches), 0.2, 0.85),
    3,
  )
  const freq1MinHz = round(
    clamp(blend(quantile(tremorFreqList, 0.25) * 0.55, prior.tremor.freq1MinHz, nReaches), 1.0, 2.4),
    2,
  )
  const freq1MaxHz = round(
    clamp(blend(quantile(tremorFreqList, 0.65) * 0.65, prior.tremor.freq1MaxHz, nReaches), freq1MinHz + 0.5, 3.8),
    2,
  )

  // 6. Click aim offset, settle & hold duration
  const aimDxs = reachAnalyses.map((r) => r.aimDx)
  const aimDys = reachAnalyses.map((r) => r.aimDy)
  const aimBiasX = round(clamp(blend(mean(aimDxs), prior.click.aimBiasX, nReaches, 8), -1.8, 1.8), 2)
  const aimBiasY = round(clamp(blend(mean(aimDys), prior.click.aimBiasY, nReaches, 8), -1.5, 1.5), 2)
  const aimSigmaX = round(clamp(blend(stdDev(aimDxs), prior.click.aimSigmaX, nReaches), 0.9, 2.8), 2)
  const aimSigmaY = round(clamp(blend(stdDev(aimDys), prior.click.aimSigmaY, nReaches), 0.8, 2.4), 2)

  const settles = reachAnalyses.map((r) => r.settleMs)
  const holds = reachAnalyses.map((r) => r.holdMs)
  const settleMinMs = Math.round(clamp(blend(quantile(settles, 0.2), prior.click.settleMinMs, nReaches), 10, 40))
  const settleMaxMs = Math.round(clamp(blend(quantile(settles, 0.75), prior.click.settleMaxMs, nReaches), settleMinMs + 10, 75))
  const holdMinMs = Math.round(clamp(blend(quantile(holds, 0.2), prior.click.holdMinMs, nReaches), 24, 65))
  const holdMaxMs = Math.round(clamp(blend(quantile(holds, 0.8), prior.click.holdMaxMs, nReaches), holdMinMs + 14, 115))

  // 7. Scroll kinematics
  const nScrolls = allScrolls.length
  const scrollFrameCounts = allScrolls.map((s) => s.frameCount)
  const minFrames = Math.round(clamp(blend(quantile(scrollFrameCounts, 0.2), prior.scroll.minFrames, nScrolls, 4), 4, 8))
  const maxFrames = Math.round(clamp(blend(quantile(scrollFrameCounts, 0.85), prior.scroll.maxFrames, nScrolls, 4), minFrames + 3, 16))

  // 8. Keyboard cadence
  const ikis = allKeys.map((k) => k.ikiMs).filter((v) => v > 12 && v < 450)
  const keyHolds = allKeys.map((k) => k.holdMs)
  const rollovers = allKeys.filter((k) => (k.rolloverMs ?? 0) > 0)
  const gapMinMs = Math.round(clamp(blend(quantile(ikis, 0.2) * 0.35, prior.keyboard.gapMinMs, ikis.length, 8), 14, 38))
  const gapMaxMs = Math.round(clamp(blend(quantile(ikis, 0.75) * 0.42, prior.keyboard.gapMaxMs, ikis.length, 8), gapMinMs + 12, 85))
  const holdMedianMs = Math.round(clamp(blend(quantile(keyHolds, 0.5), prior.keyboard.holdMedianMs, keyHolds.length, 8), 35, 130))
  const rolloverRate = round(
    clamp(
      blend(allKeys.length > 0 ? rollovers.length / allKeys.length : prior.keyboard.rolloverRate, prior.keyboard.rolloverRate, allKeys.length, 8),
      0.05,
      0.75,
    ),
    2,
  )

  // 9. Aggregate 20-bin velocity curve
  const velocityCurve = prior.velocityCurve.map((priorBin, binIdx) => {
    const binSamples = reachAnalyses.map((r) => r.velocityBins[binIdx] ?? priorBin)
    return round(blend(quantile(binSamples, 0.5), priorBin, nReaches), 3)
  })

  return {
    version: 1,
    source: sourceLabel,
    updatedAt: Date.now(),
    sampleCount: {
      runs: runs.length,
      reaches: nReaches,
      scrolls: nScrolls,
      keys: allKeys.length,
    },
    reach: {
      baseMs,
      sqrtScale,
      fittsAMs: round(blend(rawFittsA, prior.reach.fittsAMs, nReaches), 1),
      fittsBMsPerBit: round(blend(rawFittsB, prior.reach.fittsBMsPerBit, nReaches), 1),
      throughputBps,
      minDurationMs: Math.round(clamp(baseMs - 8, 95, 135)),
      maxDurationMs: Math.round(clamp(baseMs + sqrtScale * 32, 240, 310)),
      durationJitter: prior.reach.durationJitter,
      ballisticExponent,
      peakVelocityU: round(medianPeakU, 3),
      wristBias,
      bowMinRatio,
      bowMaxRatio,
      pathRatioMedian,
      c1TangentialMin: prior.reach.c1TangentialMin,
      c1TangentialMax: prior.reach.c1TangentialMax,
      c2TangentialMin: prior.reach.c2TangentialMin,
      c2TangentialMax: prior.reach.c2TangentialMax,
      c2NormalRatio: prior.reach.c2NormalRatio,
    },
    submovements: {
      overshootRate,
      undershootRate,
      overshootMinPx,
      overshootMaxPx,
      undershootMinPx,
      undershootMaxPx,
      lateralSpreadPx: prior.submovements.lateralSpreadPx,
      overshootSplitMin: prior.submovements.overshootSplitMin,
      overshootSplitMax: prior.submovements.overshootSplitMax,
      undershootSplitMin: prior.submovements.undershootSplitMin,
      undershootSplitMax: prior.submovements.undershootSplitMax,
    },
    tremor: {
      waveAmpPerPx: prior.tremor.waveAmpPerPx,
      waveAmpMinPx: prior.tremor.waveAmpMinPx,
      waveAmpMaxPx: prior.tremor.waveAmpMaxPx,
      freq1MinHz,
      freq1MaxHz,
      freq2MinHz: prior.tremor.freq2MinHz,
      freq2MaxHz: prior.tremor.freq2MaxHz,
      noiseScalePx,
    },
    click: {
      aimBiasX,
      aimBiasY,
      aimSigmaX,
      aimSigmaY,
      aimMaxX: round(Math.max(2.0, aimSigmaX * 1.45), 2),
      aimMaxY: round(Math.max(1.6, aimSigmaY * 1.45), 2),
      settleMinMs,
      settleMaxMs,
      holdMinMs,
      holdMaxMs,
    },
    scroll: {
      baseDurationMs: prior.scroll.baseDurationMs,
      durationPerPx: prior.scroll.durationPerPx,
      easePower: prior.scroll.easePower,
      minFrames,
      maxFrames,
      frameGapMinMs: prior.scroll.frameGapMinMs,
      frameGapMaxMs: prior.scroll.frameGapMaxMs,
    },
    keyboard: {
      gapMinMs,
      gapMaxMs,
      holdMedianMs,
      rolloverRate,
    },
    velocityCurve,
  }
}
