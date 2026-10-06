import type { JsonObject } from "./protocol.ts"

export type Point = { readonly x: number; readonly y: number }
type Send = (method: string, params: JsonObject) => Promise<unknown>

type TabState = {
  pointer?: Point
  aim?: Point & { readonly dx: number; readonly dy: number }
  arrivedAt: number
  pressedAt?: number
  lastKeyAt: number
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
const minimumJerk = (t: number): number => t * t * t * (10 - 15 * t + 6 * t * t)

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

/**
 * Generates a curved ~60Hz trajectory from `from` to `to` timed to finish in
 * lockstep with the on-page Ghost Cursor glide (~95–260ms).
 */
export function trajectory(from: Point, to: Point): { readonly point: Point; readonly delay: number }[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 4) return []
  const duration = clamp((95 + Math.sqrt(distance) * 5.2) * random(0.9, 1.08), 95, 275)
  const normal = { x: -dy / distance, y: dx / distance }
  const bow = (Math.random() < 0.5 ? -1 : 1) * random(0.04, 0.16) * distance
  const c1 = {
    x: from.x + dx * random(0.22, 0.35) + normal.x * bow,
    y: from.y + dy * random(0.22, 0.35) + normal.y * bow,
  }
  const c2 = {
    x: from.x + dx * random(0.66, 0.8) + normal.x * bow * 0.55,
    y: from.y + dy * random(0.66, 0.8) + normal.y * bow * 0.55,
  }
  const overshoot = distance > 280 && Math.random() < 0.22
  const end = overshoot
    ? { x: to.x + (dx / distance) * random(3, 8), y: to.y + (dy / distance) * random(3, 8) }
    : to
  const points: { point: Point; delay: number }[] = []
  let elapsed = 0
  while (elapsed < duration) {
    const step = random(13, 18)
    elapsed = Math.min(duration, elapsed + step)
    const s = minimumJerk(elapsed / duration)
    const p = bezier(from, c1, c2, end, s)
    const tremor = (1 - s) * 0.75
    points.push({
      point: { x: round1(p.x + noise(tremor)), y: round1(p.y + noise(tremor)) },
      delay: step,
    })
  }
  if (overshoot) {
    const back = 3
    for (let i = 1; i <= back; i += 1) {
      const s = minimumJerk(i / back)
      points.push({
        point: {
          x: round1(end.x + (to.x - end.x) * s),
          y: round1(end.y + (to.y - end.y) * s),
        },
        delay: random(11, 16),
      })
    }
  }
  points.pop()
  return points
}

/**
 * Applies a consistent small off-center aim offset per target before both
 * Ghost Cursor and CDP Input.dispatchMouseEvent run, so the visible cursor tip
 * and the DOM mouse event land on the exact same pixel.
 */
export function prepareMouseParams(tabId: number, method: string, params: JsonObject): void {
  if (!isHumanInputEnabled() || method !== "Input.dispatchMouseEvent") return
  const type = params.type
  if (type !== "mouseMoved" && type !== "mousePressed" && type !== "mouseReleased") return
  if (typeof params.x !== "number" || typeof params.y !== "number") return
  const tab = state(tabId)
  if (!tab.aim || Math.hypot(tab.aim.x - params.x, tab.aim.y - params.y) >= 1) {
    tab.aim = {
      x: params.x,
      y: params.y,
      dx: clamp(noise(1.8), -2.5, 2.5),
      dy: clamp(noise(1.4), -2.0, 2.0),
    }
  }
  const target = params as Record<string, unknown>
  target.x = round1(params.x + tab.aim.dx)
  target.y = round1(params.y + tab.aim.dy)
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
  if (
    type === "mouseMoved" ||
    ((type === "mousePressed" || type === "mouseReleased") &&
      tab.pointer &&
      Math.hypot(tab.pointer.x - x, tab.pointer.y - y) >= 2)
  ) {
    await travel(tab, { x, y }, params, send)
  }
  if (type === "mousePressed") {
    await sleep(random(18, 45) - (Date.now() - tab.arrivedAt))
    tab.pressedAt = Date.now()
  }
  if (type === "mouseReleased" && tab.pressedAt !== undefined) {
    await sleep(random(35, 72) - (Date.now() - tab.pressedAt))
    delete tab.pressedAt
  }
  tab.pointer = { x, y }
}

async function travel(tab: TabState, to: Point, params: JsonObject, send: Send): Promise<void> {
  const from = tab.pointer ?? { x: to.x + random(-220, 220), y: to.y + random(-140, 140) }
  const path = trajectory(from, to)
  for (const { point, delay } of path) {
    const sent = Date.now()
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      ...(typeof params.button === "string" && params.type === "mouseMoved" ? { button: params.button } : {}),
      ...(typeof params.buttons === "number" ? { buttons: params.buttons } : {}),
      ...(typeof params.modifiers === "number" ? { modifiers: params.modifiers } : {}),
    }).catch(() => undefined)
    await sleep(delay - (Date.now() - sent))
  }
  tab.arrivedAt = Date.now()
}

async function scrollToward(tab: TabState, params: JsonObject, send: Send): Promise<void> {
  const node = {
    ...(params.objectId === undefined ? {} : { objectId: params.objectId }),
    ...(params.nodeId === undefined ? {} : { nodeId: params.nodeId }),
    ...(params.backendNodeId === undefined ? {} : { backendNodeId: params.backendNodeId }),
  }
  const metrics = (await send("Page.getLayoutMetrics", {}).catch(() => undefined)) as
    | { cssVisualViewport?: { clientWidth: number; clientHeight: number } }
    | undefined
  const viewport = metrics?.cssVisualViewport
  if (!viewport) return
  const offset = async (): Promise<number | undefined> => {
    const result = (await send("DOM.getContentQuads", node).catch(() => undefined)) as { quads?: number[][] } | undefined
    const quad = result?.quads?.[0]
    if (!quad || quad.length < 8) return undefined
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    if (minY >= 0 && maxY <= viewport.clientHeight) return 0
    return (minY + maxY) / 2 - viewport.clientHeight * random(0.38, 0.5)
  }
  const first = await offset()
  if (!first || Math.abs(first) < 24) return
  const pointer = tab.pointer ?? {
    x: round1(viewport.clientWidth * random(0.38, 0.62)),
    y: round1(viewport.clientHeight * random(0.38, 0.62)),
  }
  tab.pointer = pointer
  let remaining = first
  for (let flick = 0; flick < 3 && Math.abs(remaining) > 12; flick += 1) {
    const amount = Math.sign(remaining) * Math.min(Math.abs(remaining), random(550, 1100))
    await sendFrames(glide(0, amount), (frame) =>
      send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: pointer.x,
        y: pointer.y,
        deltaX: frame.x,
        deltaY: frame.y,
      }),
    )
    const next = await offset()
    if (next === undefined || Math.abs(next - remaining) < 2) break
    remaining = next
    if (Math.abs(remaining) > 12) await sleep(random(24, 48))
  }
}

export function glide(dx: number, dy: number): Point[] {
  const distance = Math.hypot(dx, dy)
  if (distance < 40) return [{ x: round2(dx), y: round2(dy) }]
  const frames = clamp(Math.round(((90 + distance * 0.18) * random(0.9, 1.1)) / 16.7), 4, 12)
  const ease = (t: number) => 1 - (1 - t) ** 3
  return Array.from({ length: frames }, (_, index) => {
    const delta = ease((index + 1) / frames) - ease(index / frames)
    return { x: round2(dx * delta), y: round2(dy * delta) }
  })
}

async function sendFrames(frames: readonly Point[], send: (frame: Point) => Promise<unknown>): Promise<void> {
  for (const frame of frames) {
    const sent = Date.now()
    await send(frame).catch(() => undefined)
    await sleep(random(14, 17) - (Date.now() - sent))
  }
}

async function paceKey(tab: TabState, params: JsonObject): Promise<void> {
  if (params.type !== "keyDown" && params.type !== "rawKeyDown") return
  const elapsed = Date.now() - tab.lastKeyAt
  const gap = random(18, 52) - elapsed
  if (gap > 0 && tab.lastKeyAt > 0 && elapsed < 800) await sleep(gap)
  tab.lastKeyAt = Date.now()
}
