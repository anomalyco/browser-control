import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { GhostCursorMouseAction } from "./ghost-cursor.ts"
import { DEFAULT_HUMAN_MODEL_PROFILE, type HumanModelProfile, type Point } from "./human-model.ts"
import type { JsonObject } from "./protocol.ts"

export type { Point }
export type TrajectoryStep = {
  readonly point: Point
  readonly delay: number
  readonly u: number
}

let cachedProfile: HumanModelProfile | undefined
let cachedProfileCheckedAt = 0

export function setHumanModelProfile(profile: HumanModelProfile | undefined): void {
  cachedProfile = profile
  cachedProfileCheckedAt = Date.now()
}

export function getHumanModelProfile(): HumanModelProfile {
  const now = Date.now()
  if (cachedProfile && now - cachedProfileCheckedAt < 15_000) {
    return cachedProfile
  }
  cachedProfileCheckedAt = now
  if (process.env.VITEST === "true" && !process.env.BROWSER_CONTROL_HUMAN_MODEL_PATH) {
    cachedProfile = DEFAULT_HUMAN_MODEL_PROFILE
    return cachedProfile
  }
  const customPath =
    process.env.BROWSER_CONTROL_HUMAN_MODEL_PATH ??
    path.join(os.homedir(), ".browser-control", "human-model.json")
  try {
    if (fs.existsSync(customPath)) {
      const parsed = JSON.parse(fs.readFileSync(customPath, "utf8")) as {
        readonly profile?: HumanModelProfile
        readonly version?: number
      }
      const candidate = parsed.profile ?? (parsed.version === 1 ? (parsed as unknown as HumanModelProfile) : undefined)
      if (candidate?.version === 1 && candidate.reach && candidate.click) {
        cachedProfile = candidate
        return candidate
      }
    }
  } catch {
    // Fall back to baseline profile if file is absent or malformed
  }
  cachedProfile = DEFAULT_HUMAN_MODEL_PROFILE
  return cachedProfile
}

type Send = (method: string, params: JsonObject) => Promise<unknown>

type TabState = {
  pointer?: Point
  aim?: Point & { readonly dx: number; readonly dy: number }
  arrivedAt: number
  pressedAt?: number
  lastKeyAt: number
  lastMove?: {
    readonly toX: number
    readonly toY: number
    readonly durationMs: number
    readonly waypoints: readonly { readonly x: number; readonly y: number; readonly u: number }[]
    readonly pending?: boolean
  }
  queue: Promise<void>
}

const tabs = new Map<number, TabState>()

function isHumanInputEnabled(): boolean {
  const raw = process.env.BROWSER_CONTROL_HUMAN_INPUT
  if (raw !== undefined) {
    return !/^(0|false|off|no)$/i.test(raw)
  }
  return process.env.VITEST !== "true"
}

function state(tabId: number): TabState {
  let value = tabs.get(tabId)
  if (!value) {
    value = { arrivedAt: 0, lastKeyAt: 0, queue: Promise.resolve() }
    tabs.set(tabId, value)
  }
  return value
}

export function forgetTab(tabId: number): void {
  tabs.delete(tabId)
}

const sleep = (ms: number): Promise<void> =>
  ms > 1 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const random = (min: number, max: number): number =>
  min + Math.random() * (max - min)

const noise = (scale: number): number =>
  (Math.random() + Math.random() + Math.random() - 1.5) * scale

const round1 = (value: number): number => Math.round(value * 10) / 10
const round2 = (value: number): number => Math.round(value * 100) / 100

/** Minimum-jerk position profile: slow start, fast middle, soft arrival. */
const minimumJerk = (t: number): number => {
  const u = clamp(t, 0, 1)
  return u * u * u * (10 - 15 * u + 6 * u * u)
}

/**
 * Asymmetric Woodworth/Meyer ballistic reach profile: peak velocity occurs
 * around u ≈ 0.36, followed by a longer visual closed-loop homing phase.
 */
const ballisticProgress = (u: number, exponent = 0.74): number =>
  minimumJerk(Math.pow(clamp(u, 0, 1), exponent))

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

/**
 * Generates a realistic biomechanical trajectory from `from` to `to` (~115–285ms):
 * - Wrist-pivot arc with natural upward sweep on horizontal reaches
 * - Asymmetric ballistic acceleration (peak at ~36% of duration) + visual homing tail
 * - Band-limited 8–12 Hz neuromuscular hand wave + micro-tremor that damps on arrival
 * - Meyer secondary corrective submovement (overshoot hook or undershoot micro-glide)
 */
export function trajectory(
  from: Point,
  to: Point,
  profile: HumanModelProfile = getHumanModelProfile(),
): TrajectoryStep[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 4) return []

  const { reach, submovements, tremor } = profile
  const jitter = clamp(reach.durationJitter, 0.02, 0.25)
  const duration = clamp(
    (reach.baseMs + Math.sqrt(distance) * reach.sqrtScale) * random(1 - jitter, 1 + jitter),
    reach.minDurationMs,
    reach.maxDurationMs,
  )
  const tangent = { x: dx / distance, y: dy / distance }
  const normal = { x: -tangent.y, y: tangent.x }

  // Wrist-pivot bias: horizontal sweeps naturally arc slightly upward (-y).
  const wristBias = -tangent.x * reach.wristBias * distance
  const bowSign = Math.random() < 0.5 ? -1 : 1
  const bow = bowSign * random(reach.bowMinRatio, reach.bowMaxRatio) * distance + wristBias

  // Submovement classification (Meyer's optimized submovement model):
  const roll = distance > 135 ? Math.random() : 1
  const mode: "overshoot" | "undershoot" | "direct" =
    roll < submovements.overshootRate
      ? "overshoot"
      : roll < submovements.overshootRate + submovements.undershootRate
        ? "undershoot"
        : "direct"

  const submovementSplit =
    mode === "overshoot"
      ? random(submovements.overshootSplitMin, submovements.overshootSplitMax)
      : mode === "undershoot"
        ? random(submovements.undershootSplitMin, submovements.undershootSplitMax)
        : 1
  const spread = submovements.lateralSpreadPx
  const primaryEnd: Point =
    mode === "overshoot"
      ? {
          x: to.x + tangent.x * random(submovements.overshootMinPx, submovements.overshootMaxPx) + normal.x * random(-spread, spread),
          y: to.y + tangent.y * random(submovements.overshootMinPx, submovements.overshootMaxPx) + normal.y * random(-spread, spread),
        }
      : mode === "undershoot"
        ? {
            x: to.x - tangent.x * random(submovements.undershootMinPx, submovements.undershootMaxPx) + normal.x * random(-spread * 0.9, spread * 0.9),
            y: to.y - tangent.y * random(submovements.undershootMinPx, submovements.undershootMaxPx) + normal.y * random(-spread * 0.9, spread * 0.9),
          }
        : to

  const c1 = {
    x: from.x + (primaryEnd.x - from.x) * random(reach.c1TangentialMin, reach.c1TangentialMax) + normal.x * bow,
    y: from.y + (primaryEnd.y - from.y) * random(reach.c1TangentialMin, reach.c1TangentialMax) + normal.y * bow,
  }
  const c2 = {
    x: from.x + (primaryEnd.x - from.x) * random(reach.c2TangentialMin, reach.c2TangentialMax) + normal.x * bow * reach.c2NormalRatio,
    y: from.y + (primaryEnd.y - from.y) * random(reach.c2TangentialMin, reach.c2TangentialMax) + normal.y * bow * reach.c2NormalRatio,
  }

  // Band-limited physiological hand wave (2 oscillations + harmonic)
  const phase1 = random(0, Math.PI * 2)
  const phase2 = random(0, Math.PI * 2)
  const freq1 = random(tremor.freq1MinHz, tremor.freq1MaxHz) * Math.PI * 2
  const freq2 = random(tremor.freq2MinHz, tremor.freq2MaxHz) * Math.PI * 2
  const waveAmp = clamp(distance * tremor.waveAmpPerPx, tremor.waveAmpMinPx, tremor.waveAmpMaxPx)

  const steps: TrajectoryStep[] = []
  let elapsed = 0
  while (elapsed < duration) {
    const delay = random(12.5, 16.8)
    elapsed = Math.min(duration, elapsed + delay)
    const u = elapsed / duration

    let base: Point
    if (mode === "direct" || u <= submovementSplit) {
      const localU = mode === "direct" ? u : u / submovementSplit
      const s = ballisticProgress(localU, reach.ballisticExponent)
      base = bezier(from, c1, c2, primaryEnd, s)
    } else {
      const localU = (u - submovementSplit) / (1 - submovementSplit)
      const s = minimumJerk(localU)
      base = {
        x: primaryEnd.x + (to.x - primaryEnd.x) * s,
        y: primaryEnd.y + (to.y - primaryEnd.y) * s,
      }
    }

    // Envelope is 0 at u=0 and u=1 so endpoints are exact, peaking in mid-flight.
    const envelope = Math.sin(Math.PI * u) * Math.pow(1 - u, 0.45)
    const perpWave =
      (Math.sin(u * freq1 + phase1) * 0.68 + Math.sin(u * freq2 + phase2) * 0.32) * waveAmp * envelope +
      noise(tremor.noiseScalePx * envelope)
    const tangWave = Math.cos(u * freq1 + phase2) * (waveAmp * 0.35) * envelope

    const point: Point =
      u >= 0.999
        ? to
        : {
            x: round1(base.x + normal.x * perpWave + tangent.x * tangWave),
            y: round1(base.y + normal.y * perpWave + tangent.y * tangWave),
          }

    steps.push({ point, delay, u: round2(u) })
  }

  // Drop the final sample since the caller's own command dispatches at `to`.
  steps.pop()
  return steps
}

/**
 * Applies a consistent off-center aim offset per target and precomputes the
 * shared biomechanical trajectory so GhostCursor and CDP Input.dispatchMouseEvent
 * follow the exact same path and land on the exact same pixel.
 */
export function prepareMouseParams(tabId: number, method: string, params: JsonObject): void {
  if (!isHumanInputEnabled() || method !== "Input.dispatchMouseEvent") return
  const type = params.type
  if (type !== "mouseMoved" && type !== "mousePressed" && type !== "mouseReleased") return
  if (typeof params.x !== "number" || typeof params.y !== "number") return
  const profile = getHumanModelProfile()
  const { click } = profile
  const tab = state(tabId)
  if (!tab.aim || Math.hypot(tab.aim.x - params.x, tab.aim.y - params.y) >= 1) {
    tab.aim = {
      x: params.x,
      y: params.y,
      dx: clamp(click.aimBiasX + noise(click.aimSigmaX), -click.aimMaxX, click.aimMaxX),
      dy: clamp(click.aimBiasY + noise(click.aimSigmaY), -click.aimMaxY, click.aimMaxY),
    }
  }
  const target = params as Record<string, unknown>
  const x = round1(params.x + tab.aim.dx)
  const y = round1(params.y + tab.aim.dy)
  target.x = x
  target.y = y

  const needsTravel = !tab.pointer || Math.hypot(tab.pointer.x - x, tab.pointer.y - y) >= 4

  if (needsTravel) {
    const from = tab.pointer ?? { x: round1(x + random(-220, 220)), y: round1(y + random(-140, 140)) }
    const steps = trajectory(from, { x, y }, profile)
    const durationMs = Math.round(steps.reduce((sum, step) => sum + step.delay, 0) + 16)
    const waypoints = [
      { x: from.x, y: from.y, u: 0 },
      ...steps.map((step) => ({ x: step.point.x, y: step.point.y, u: step.u })),
      { x, y, u: 1 },
    ]
    tab.lastMove = { toX: x, toY: y, durationMs, waypoints, pending: true }
  }
  tab.pointer = { x, y }
}

export function decorateGhostCursorAction(
  tabId: number,
  action: GhostCursorMouseAction,
): GhostCursorMouseAction {
  const lastMove = tabs.get(tabId)?.lastMove
  if (
    action.type === "move" &&
    lastMove &&
    lastMove.waypoints.length > 2 &&
    Math.hypot(lastMove.toX - action.x, lastMove.toY - action.y) < 1
  ) {
    return {
      ...action,
      durationMs: lastMove.durationMs,
      path: lastMove.waypoints,
    }
  }
  return action
}

const pacedMethods = new Set([
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "DOM.scrollIntoViewIfNeeded",
])

export function beforeInput(
  tabId: number,
  method: string,
  params: JsonObject,
  root: boolean,
  send: Send,
): Promise<void> {
  if (!isHumanInputEnabled() || !pacedMethods.has(method) || (method === "DOM.scrollIntoViewIfNeeded" && !root)) {
    return Promise.resolve()
  }
  const tab = state(tabId)
  const run = tab.queue.then(() => {
    if (method === "Input.dispatchKeyEvent") return paceKey(tab, params)
    if (method === "DOM.scrollIntoViewIfNeeded") return scrollToward(tab, params, send)
    return paceMouse(tab, params, send)
  })
  tab.queue = run.catch(() => undefined)
  return run
}

async function paceMouse(tab: TabState, params: JsonObject, send: Send): Promise<void> {
  const type = params.type
  if (typeof params.x !== "number" || typeof params.y !== "number") return
  const target = params as Record<string, unknown>
  if (type === "mouseWheel") {
    const frames = glide(Number(params.deltaX ?? 0), Number(params.deltaY ?? 0))
    const last = frames.pop()
    const driftX = round1(params.x + noise(1.4))
    const driftY = round1(params.y + noise(1.4))
    void send("Runtime.evaluate", {
      expression: `globalThis.__browserControlGhostCursor?.applyMouseEvent(${JSON.stringify({ type: "move", x: driftX, y: driftY, button: "none", durationMs: 110 })})`,
      awaitPromise: false,
    }).catch(() => undefined)
    await sendFrames(frames, (frame) =>
      send("Input.dispatchMouseEvent", { ...params, deltaX: frame.x, deltaY: frame.y }),
    )
    if (last) {
      target.deltaX = last.x
      target.deltaY = last.y
    }
    return
  }
  const x = params.x
  const y = params.y
  const { click } = getHumanModelProfile()
  if (tab.lastMove?.pending && Math.hypot(tab.lastMove.toX - x, tab.lastMove.toY - y) < 1) {
    tab.lastMove = { ...tab.lastMove, pending: false }
    await travel(tab, { x, y }, params, send)
  }
  if (type === "mousePressed") {
    await sleep(random(click.settleMinMs, click.settleMaxMs) - (Date.now() - tab.arrivedAt))
    tab.pressedAt = Date.now()
  }
  if (type === "mouseReleased" && tab.pressedAt !== undefined) {
    await sleep(random(click.holdMinMs, click.holdMaxMs) - (Date.now() - tab.pressedAt))
    delete tab.pressedAt
  }
}

async function travel(tab: TabState, to: Point, params: JsonObject, send: Send): Promise<void> {
  const precomputed = tab.lastMove
  const rawSteps =
    precomputed && Math.hypot(precomputed.toX - to.x, precomputed.toY - to.y) < 1 && precomputed.waypoints.length > 2
      ? precomputed.waypoints.slice(1, -1).map((wp, _idx, arr) => ({
          point: { x: wp.x, y: wp.y },
          delay: precomputed.durationMs / Math.max(1, arr.length + 1),
          u: wp.u,
        }))
      : trajectory(tab.pointer ?? { x: to.x + random(-220, 220), y: to.y + random(-140, 140) }, to)

  // Subsample to at most 8 CDP mouseMoved events so Chrome's main-thread hit-test
  // queue never backs up while GhostCursor renders the full 60fps path in-page.
  const stride = Math.max(1, Math.ceil(rawSteps.length / 8))
  const steps = rawSteps.filter((_, index) => index % stride === 0 || index === rawSteps.length - 1)
  const totalBudgetMs = clamp(precomputed?.durationMs ?? 210, 110, 280)
  const stepDelayMs = totalBudgetMs / Math.max(1, steps.length + 1)
  const startedAt = Date.now()

  for (const { point } of steps) {
    if (Date.now() - startedAt >= totalBudgetMs) break
    const stepStarted = Date.now()
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      ...(typeof params.button === "string" && params.type === "mouseMoved" ? { button: params.button } : {}),
      ...(typeof params.buttons === "number" ? { buttons: params.buttons } : {}),
      ...(typeof params.modifiers === "number" ? { modifiers: params.modifiers } : {}),
    }).catch(() => undefined)
    if (Date.now() - startedAt >= totalBudgetMs) break
    await sleep(stepDelayMs - (Date.now() - stepStarted))
  }
  tab.arrivedAt = Date.now()
}

async function scrollToward(tab: TabState, params: JsonObject, send: Send): Promise<void> {
  const node = {
    ...(params.objectId === undefined ? {} : { objectId: params.objectId }),
    ...(params.nodeId === undefined ? {} : { nodeId: params.nodeId }),
    ...(params.backendNodeId === undefined ? {} : { backendNodeId: params.backendNodeId }),
  }
  const measure = async (): Promise<{
    readonly clientWidth: number
    readonly clientHeight: number
    readonly delta: number
  } | undefined> => {
    const timed = await Promise.race([
      Promise.all([
        send("Page.getLayoutMetrics", {}).catch(() => undefined),
        send("DOM.getContentQuads", node).catch(() => undefined),
      ]),
      sleep(120).then(() => undefined),
    ])
    if (!timed) return undefined
    const [layoutRaw, quadRaw] = timed as [
      { cssVisualViewport?: { clientWidth: number; clientHeight: number; pageY?: number } } | undefined,
      { quads?: number[][] } | undefined,
    ]
    const viewport = layoutRaw?.cssVisualViewport
    const quad = quadRaw?.quads?.[0]
    if (!viewport || !quad || quad.length < 8) return undefined
    const pageY = viewport.pageY ?? 0
    const ys = [quad[1]! - pageY, quad[3]! - pageY, quad[5]! - pageY, quad[7]! - pageY]
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const delta =
      minY >= 16 && maxY <= viewport.clientHeight - 16
        ? 0
        : (minY + maxY) / 2 - viewport.clientHeight * random(0.38, 0.5)
    return { clientWidth: viewport.clientWidth, clientHeight: viewport.clientHeight, delta }
  }
  const first = await measure()
  if (!first || Math.abs(first.delta) < 24) return
  const pointer = tab.pointer ?? {
    x: round1(first.clientWidth * random(0.38, 0.62)),
    y: round1(first.clientHeight * random(0.38, 0.62)),
  }
  tab.pointer = pointer
  let remaining = first.delta
  for (let flick = 0; flick < 3 && Math.abs(remaining) > 12; flick += 1) {
    const amount = Math.sign(remaining) * Math.min(Math.abs(remaining), random(550, 1100))
    const driftX = round1(pointer.x + noise(1.6))
    const driftY = round1(pointer.y + noise(1.6))
    void send("Runtime.evaluate", {
      expression: `globalThis.__browserControlGhostCursor?.applyMouseEvent(${JSON.stringify({ type: "move", x: driftX, y: driftY, button: "none", durationMs: 120 })})`,
      awaitPromise: false,
    }).catch(() => undefined)
    await sendFrames(glide(0, amount), (frame) =>
      send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: pointer.x,
        y: pointer.y,
        deltaX: frame.x,
        deltaY: frame.y,
      }),
    )
    const next = await measure()
    if (!next || Math.abs(next.delta - remaining) < 2) break
    remaining = next.delta
    if (Math.abs(remaining) > 12) await sleep(random(24, 48))
  }
}

export function glide(dx: number, dy: number, profile: HumanModelProfile = getHumanModelProfile()): Point[] {
  const distance = Math.hypot(dx, dy)
  if (distance < 40) return [{ x: round2(dx), y: round2(dy) }]
  const { scroll, scrollCurve } = profile
  const frames = clamp(
    Math.round(((scroll.baseDurationMs + distance * scroll.durationPerPx) * random(0.9, 1.1)) / 16.7),
    scroll.minFrames,
    scroll.maxFrames,
  )
  const curve =
    scrollCurve && scrollCurve.length >= 4
      ? scrollCurve
      : [0.38, 0.92, 1.48, 1.82, 1.74, 1.46, 1.16, 0.88, 0.64, 0.44, 0.28, 0.14]
  const rawWeights = Array.from({ length: frames }, (_, index) => {
    const pos = ((index + 0.5) / frames) * (curve.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    const frac = pos - lo
    return Math.max(0.05, curve[lo]! * (1 - frac) + curve[hi]! * frac)
  })
  const totalWeight = rawWeights.reduce((acc, w) => acc + w, 0)
  return rawWeights.map((w) => {
    const delta = w / totalWeight
    return { x: round2(dx * delta), y: round2(dy * delta) }
  })
}

async function sendFrames(frames: readonly Point[], send: (frame: Point) => Promise<unknown>): Promise<void> {
  const { scroll } = getHumanModelProfile()
  const startedAt = Date.now()
  for (const frame of frames) {
    if (Date.now() - startedAt >= 260) break
    const stepStarted = Date.now()
    await send(frame).catch(() => undefined)
    await sleep(random(scroll.frameGapMinMs, scroll.frameGapMaxMs) - (Date.now() - stepStarted))
  }
}

async function paceKey(tab: TabState, params: JsonObject): Promise<void> {
  if (params.type !== "keyDown" && params.type !== "rawKeyDown") return
  const { keyboard } = getHumanModelProfile()
  const elapsed = Date.now() - tab.lastKeyAt
  const gap = random(keyboard.gapMinMs, keyboard.gapMaxMs) - elapsed
  if (gap > 0 && tab.lastKeyAt > 0 && elapsed < 800) await sleep(gap)
  tab.lastKeyAt = Date.now()
}
