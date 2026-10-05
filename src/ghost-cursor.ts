import { Match, Predicate } from "effect"
import type { Locator, Page } from "playwright-core"
import type { JsonObject } from "./protocol.ts"

export type GhostCursorClientOptions = {
  readonly color?: string
  readonly size?: number
  readonly zIndex?: number
}

type GhostCursorTone = "neutral" | "accent" | "success" | "warn"

export type GhostCursorCaptionOptions = {
  readonly subtitle?: string
  readonly step?: string
  readonly tone?: GhostCursorTone
}

export type GhostCursorCalloutOptions = {
  readonly detail?: string
  readonly tone?: GhostCursorTone
}

export type GhostCursorMouseAction = {
  readonly type: "move" | "down" | "up"
  readonly x: number
  readonly y: number
  readonly button: "left" | "right" | "middle" | "none"
}

type GhostCursorEvaluatePayload = {
  readonly cursorOptions?: GhostCursorClientOptions
}

type GhostCursorCaptionPayload = {
  readonly title: string
  readonly options?: GhostCursorCaptionOptions
}

type GhostCursorCalloutPayload = {
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly label: string
  readonly options?: GhostCursorCalloutOptions
}

type GhostCursorBrowserApi = {
  readonly show: (options?: GhostCursorClientOptions) => void
  readonly hide: () => void
  readonly restore: (position: { readonly x: number; readonly y: number }) => void
  readonly applyMouseEvent: (action: GhostCursorMouseAction) => Promise<void>
  readonly setCaption: (payload: GhostCursorCaptionPayload | null) => void
  readonly showCallout: (payload: GhostCursorCalloutPayload) => void
  readonly clearCallouts: () => void
  readonly isVisible: () => boolean
}

const ghostCursorElementId = "__browser_control_ghost_cursor__"

export const ghostCursorClientSource = `(() => {
  if (window !== window.top) {
    return;
  }
  if (globalThis.__browserControlGhostCursor?.version === 5) {
    return;
  }
  globalThis.__browserControlGhostCursor?.hide?.();
  const cursorId = "${ghostCursorElementId}";
  const stageId = "__browser_control_ghost_stage__";
  const captionId = "__browser_control_ghost_caption__";
  const positionStorageKey = "__browser_control_ghost_cursor_position__";
  const captionStorageKey = "__browser_control_ghost_cursor_caption__";
  const defaults = { color: "#1c1c1f", size: 23, zIndex: 2147483646 };
  const svgNamespace = "http://www.w3.org/2000/svg";
  // Original symmetrical diagonal dart with nose at (1.4, 1.4) pointing at -135 deg (-3*PI/4).
  const cursorPathData =
    "M0.92 2.18C0.61 1.37 1.42 0.58 2.23 0.9L14.39 5.68C15.23 6.01 15.23 7.2 14.39 7.54L9.86 9.37C9.61 9.47 9.41 9.67 9.31 9.92L7.44 14.42C7.09 15.25 5.9 15.23 5.58 14.39L0.92 2.18Z";
  const NOSE_HEADING = -3 * Math.PI / 4;
  const TAU = Math.PI * 2;
  const PEAK_SPEED = 920;
  const MIN_START_SPEED = 310;
  const MIN_END_SPEED = 210;
  const SPRING_K = 400;
  const SPRING_C = 17;
  const SPRING_OVERSHOOT = 0.72;
  const tones = {
    neutral: "#e0b35a",
    accent: "#93c5fd",
    success: "#a8ba96",
    warn: "#f59e0b",
  };
  const state = {
    element: null,
    arrow: null,
    stage: null,
    targetX: Math.round(window.innerWidth / 2),
    targetY: Math.round(window.innerHeight / 2),
    renderedX: Math.round(window.innerWidth / 2),
    renderedY: Math.round(window.innerHeight / 2),
    heading: NOSE_HEADING,
    arcSign: 1,
    path: null,
    dist: 0,
    spring: null,
    springTarget: null,
    flightResolvers: [],
    actionQueue: Promise.resolve(),
    animationFrame: undefined,
    previousFrameTime: undefined,
    mode: "auto",
    options: defaults,
    fadeTimer: undefined,
    removeTimer: undefined,
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mod2pi = (x) => {
    const r = x - TAU * Math.floor(x / TAU);
    return r < 0 ? r + TAU : r;
  };
  const wrapPi = (x) => {
    let r = (x + Math.PI) % TAU;
    if (r < 0) r += TAU;
    return r - Math.PI;
  };
  const mergeOptions = (options) => ({
    color: typeof options?.color === "string" ? options.color : defaults.color,
    size: typeof options?.size === "number" && Number.isFinite(options.size) ? options.size : defaults.size,
    zIndex: typeof options?.zIndex === "number" && Number.isFinite(options.zIndex) ? options.zIndex : defaults.zIndex,
  });
  const formatCoord = (value) => String(Number(value.toFixed(2)));
  const applyPosition = () => {
    if (!state.element) {
      return;
    }
    state.element.style.transform = "translate3d(" + formatCoord(state.renderedX) + "px, " + formatCoord(state.renderedY) + "px, 0)";
    if (state.arrow) {
      const scale = state.element.dataset.pressed === "true" ? 0.85 : 1;
      const deg = ((state.heading - NOSE_HEADING) * 180) / Math.PI;
      state.arrow.style.transform = "rotate(" + formatCoord(deg) + "deg) scale(" + scale + ")";
    }
  };

  // ── Dubins Airplane Path Planner (ported from cua-driver path_planner.rs) ──
  const dubinsLSL = (d, a, b) => {
    const tmp0 = d + Math.sin(a) - Math.sin(b);
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b));
    if (p2 < 0) return null;
    const tmp1 = Math.atan2(Math.cos(b) - Math.cos(a), tmp0);
    return { t: mod2pi(-a + tmp1), p: Math.sqrt(p2), q: mod2pi(b - tmp1), types: ["L", "S", "L"] };
  };
  const dubinsRSR = (d, a, b) => {
    const tmp0 = d - Math.sin(a) + Math.sin(b);
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a));
    if (p2 < 0) return null;
    const tmp1 = Math.atan2(Math.cos(a) - Math.cos(b), tmp0);
    return { t: mod2pi(a - tmp1), p: Math.sqrt(p2), q: mod2pi(-b + tmp1), types: ["R", "S", "R"] };
  };
  const dubinsLSR = (d, a, b) => {
    const p2 = -2 + d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) + Math.sin(b));
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const tmp1 = Math.atan2(-(Math.cos(a) + Math.cos(b)), d + Math.sin(a) + Math.sin(b)) - Math.atan2(-2, p);
    return { t: mod2pi(-a + tmp1), p, q: mod2pi(-mod2pi(b) + tmp1), types: ["L", "S", "R"] };
  };
  const dubinsRSL = (d, a, b) => {
    const p2 = d * d - 2 + 2 * Math.cos(a - b) - 2 * d * (Math.sin(a) + Math.sin(b));
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const tmp1 = Math.atan2(Math.cos(a) + Math.cos(b), d - Math.sin(a) - Math.sin(b)) - Math.atan2(2, p);
    return { t: mod2pi(a - tmp1), p, q: mod2pi(b - tmp1), types: ["R", "S", "L"] };
  };
  const planDubinsPath = (x0, y0, th0, x1, y1, th1, r) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dDist = Math.hypot(dx, dy);
    if (dDist < 2) return null;
    const d = dDist / r;
    const theta = mod2pi(Math.atan2(dy, dx));
    const a = mod2pi(th0 - theta);
    const b = mod2pi(th1 - theta);
    let best = null;
    let bestLen = Infinity;
    for (const solver of [dubinsLSL, dubinsRSR, dubinsLSR, dubinsRSL]) {
      const sol = solver(d, a, b);
      if (!sol) continue;
      // Avoid full loop-the-loops on tight turns; keep arcs crisp and physical.
      if (sol.t > Math.PI * 0.95 || sol.q > Math.PI * 0.95) continue;
      const len = sol.t + sol.p + sol.q;
      if (Number.isFinite(len) && len >= 0 && len < bestLen) {
        bestLen = len;
        best = sol;
      }
    }
    if (!best) {
      return {
        kind: "linear",
        length: Math.max(1, dDist),
        x0, y0, th0, x1, y1, th1,
      };
    }
    return {
      kind: "dubins",
      length: Math.max(1, bestLen * r),
      x0, y0, th0, x1, y1, th1,
      r,
      seg1: best.t,
      seg2: best.p,
      seg3: best.q,
      types: best.types,
    };
  };
  const samplePlannedPath = (plan, sIn) => {
    if (plan.kind === "linear") {
      const u = clamp(sIn / plan.length, 0, 1);
      const diff = wrapPi(plan.th1 - plan.th0);
      return {
        x: plan.x0 + (plan.x1 - plan.x0) * u,
        y: plan.y0 + (plan.y1 - plan.y0) * u,
        heading: plan.th0 + diff * u,
      };
    }
    if (sIn <= 0) return { x: plan.x0, y: plan.y0, heading: plan.th0 };
    const r = plan.r;
    const l1 = plan.seg1 * r;
    const l2 = plan.seg2 * r;
    const l3 = plan.seg3 * r;
    const s = Math.min(sIn, l1 + l2 + l3);
    let x = plan.x0;
    let y = plan.y0;
    let th = plan.th0;
    const advance = (len, seg) => {
      if (seg === "S") {
        x += Math.cos(th) * len;
        y += Math.sin(th) * len;
      } else {
        const dir = seg === "L" ? 1 : -1;
        const dth = (len / r) * dir;
        const perp = dir * (Math.PI / 2);
        const cx = x + Math.cos(th + perp) * r;
        const cy = y + Math.sin(th + perp) * r;
        const ang = Math.atan2(y - cy, x - cx);
        x = cx + Math.cos(ang + dth) * r;
        y = cy + Math.sin(ang + dth) * r;
        th += dth;
      }
    };
    if (s <= l1) {
      advance(s, plan.types[0]);
      return { x, y, heading: th };
    }
    advance(l1, plan.types[0]);
    if (s <= l1 + l2) {
      advance(s - l1, plan.types[1]);
      return { x, y, heading: th };
    }
    advance(l2, plan.types[1]);
    advance(s - l1 - l2, plan.types[2]);
    return { x, y, heading: th };
  };

  const ensureStage = () => {
    const existing = document.getElementById(stageId);
    if (existing instanceof HTMLDivElement) {
      state.stage = existing;
      return existing;
    }
    const stage = document.createElement("div");
    stage.id = stageId;
    stage.setAttribute("aria-hidden", "true");
    stage.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:" + (state.options.zIndex - 1) + ";overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Inter','SF Pro Text',sans-serif;";
    document.documentElement.appendChild(stage);
    state.stage = stage;
    return stage;
  };
  const spawnClickPulse = (x, y, phase) => {
    const stage = ensureStage();
    if (phase === "down") {
      const flash = document.createElement("div");
      flash.style.cssText = [
        "position:fixed",
        "left:" + formatCoord(x - 5) + "px",
        "top:" + formatCoord(y - 5) + "px",
        "width:10px",
        "height:10px",
        "border-radius:999px",
        "background:rgba(250,250,249,0.9)",
        "box-shadow:0 0 0 1.5px rgba(24,24,27,0.45)",
        "pointer-events:none",
      ].join(";");
      stage.appendChild(flash);
      flash.animate(
        [
          { opacity: 0.9, transform: "scale(0.4)" },
          { opacity: 0, transform: "scale(1.35)" },
        ],
        { duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      ).onfinish = () => flash.remove();
      return;
    }
    const ring = document.createElement("div");
    ring.style.cssText = [
      "position:fixed",
      "left:" + formatCoord(x - 15) + "px",
      "top:" + formatCoord(y - 15) + "px",
      "width:30px",
      "height:30px",
      "border-radius:999px",
      "border:2px solid rgba(250,250,249,0.92)",
      "box-shadow:0 0 0 1.5px rgba(24,24,27,0.45), 0 2px 10px rgba(0,0,0,0.2)",
      "box-sizing:border-box",
      "pointer-events:none",
    ].join(";");
    const halo = document.createElement("div");
    halo.style.cssText = [
      "position:fixed",
      "left:" + formatCoord(x - 19) + "px",
      "top:" + formatCoord(y - 19) + "px",
      "width:38px",
      "height:38px",
      "border-radius:999px",
      "border:1.25px solid rgba(228,228,231,0.6)",
      "box-sizing:border-box",
      "pointer-events:none",
    ].join(";");
    stage.append(ring, halo);
    ring.animate(
      [
        { opacity: 0.92, transform: "scale(0.3)" },
        { opacity: 0, transform: "scale(1.75)" },
      ],
      { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    ).onfinish = () => ring.remove();
    halo.animate(
      [
        { opacity: 0.6, transform: "scale(0.35)" },
        { opacity: 0, transform: "scale(2.3)" },
      ],
      { duration: 450, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    ).onfinish = () => halo.remove();
  };
  const flushFlightResolvers = () => {
    const list = state.flightResolvers.splice(0);
    for (const resolve of list) {
      try { resolve(); } catch {}
    }
  };
  // Advance motion using Cua Driver's tick_swift_constants (smootherstep + Dubins + spring settle).
  const stepMotion = (dt) => {
    if (state.path) {
      const p = state.path;
      const pathLen = Math.max(1, p.length);
      const u = Math.min(1, state.dist / pathLen);
      const profile = (30 * u * u * (1 - u) * (1 - u)) / 1.875;
      const floorSpeed = u < 0.5 ? MIN_START_SPEED : MIN_END_SPEED;
      const currentSpeed = floorSpeed + (PEAK_SPEED - floorSpeed) * profile;
      state.dist += currentSpeed * dt;

      if (state.dist >= pathLen) {
        const end = samplePlannedPath(p, pathLen);
        const vh = end.heading;
        state.spring = {
          ox: 0,
          oy: 0,
          vx: currentSpeed * SPRING_OVERSHOOT * Math.cos(vh),
          vy: currentSpeed * SPRING_OVERSHOOT * Math.sin(vh),
        };
        state.springTarget = { x: p.x1, y: p.y1, heading: vh };
        state.renderedX = p.x1;
        state.renderedY = p.y1;
        state.heading = vh;
        state.path = null;
        state.dist = 0;
        flushFlightResolvers();
      } else {
        const s = samplePlannedPath(p, state.dist);
        state.renderedX = s.x;
        state.renderedY = s.y;
        state.heading = s.heading;
      }
      return true;
    }

    if (state.spring && state.springTarget) {
      const s = state.spring;
      const tgt = state.springTarget;
      const substeps = 4;
      const sdt = dt / substeps;
      for (let i = 0; i < substeps; i++) {
        s.vx += (-SPRING_K * s.ox - SPRING_C * s.vx) * sdt;
        s.vy += (-SPRING_K * s.oy - SPRING_C * s.vy) * sdt;
        s.ox += s.vx * sdt;
        s.oy += s.vy * sdt;
      }
      state.renderedX = tgt.x + s.ox;
      state.renderedY = tgt.y + s.oy;
      state.heading = tgt.heading;
      if (Math.hypot(s.ox, s.oy) < 0.25 && Math.hypot(s.vx, s.vy) < 1.5) {
        state.renderedX = tgt.x;
        state.renderedY = tgt.y;
        state.spring = null;
        state.springTarget = null;
        return false;
      }
      return true;
    }
    return false;
  };
  const onAnimationFrame = (timestamp) => {
    if (!state.element) {
      state.animationFrame = undefined;
      state.previousFrameTime = undefined;
      flushFlightResolvers();
      return;
    }
    const dt = state.previousFrameTime === undefined
      ? 1 / 60
      : clamp((timestamp - state.previousFrameTime) / 1000, 1 / 240, 0.05);
    state.previousFrameTime = timestamp;
    const active = stepMotion(dt);
    applyPosition();
    if (active) {
      state.animationFrame = window.requestAnimationFrame(onAnimationFrame);
    } else {
      state.animationFrame = undefined;
      state.previousFrameTime = undefined;
    }
  };
  const startLoop = () => {
    if (state.animationFrame === undefined) {
      state.animationFrame = window.requestAnimationFrame(onAnimationFrame);
    }
  };
  const applyVisualOptions = () => {
    if (!state.element) {
      return;
    }
    state.element.style.width = state.options.size + "px";
    state.element.style.height = state.options.size + "px";
    state.element.style.zIndex = String(state.options.zIndex);
    const arrow = state.arrow;
    if (arrow instanceof SVGSVGElement && arrow.firstElementChild) {
      arrow.firstElementChild.setAttribute("fill", state.options.color);
    }
  };
  const ensureElement = () => {
    const existing = document.getElementById(cursorId);
    if (existing instanceof HTMLDivElement) {
      state.element = existing;
      state.arrow = existing.querySelector("svg");
      return existing;
    }
    const element = document.createElement("div");
    element.id = cursorId;
    element.setAttribute("aria-hidden", "true");
    element.style.position = "fixed";
    element.style.left = "0";
    element.style.top = "0";
    element.style.pointerEvents = "none";
    element.style.boxSizing = "border-box";
    element.style.transition = "opacity 180ms ease-out";
    element.style.transformOrigin = "0 0";
    element.style.willChange = "transform, opacity";
    element.style.opacity = "0";
    element.dataset.motion = "spring";
    const arrow = document.createElementNS(svgNamespace, "svg");
    arrow.setAttribute("viewBox", "0 0 16 16");
    arrow.style.display = "block";
    arrow.style.width = "100%";
    arrow.style.height = "100%";
    arrow.style.overflow = "visible";
    // Pivot around the dart's nose tip at (1.4px, 1.4px) in viewBox 16x16.
    arrow.style.transformOrigin = "8.75% 8.75%";
    arrow.style.filter = "drop-shadow(0 2.5px 5px rgba(0,0,0,0.34)) drop-shadow(0 0.5px 1.5px rgba(0,0,0,0.22))";
    const arrowPath = document.createElementNS(svgNamespace, "path");
    arrowPath.setAttribute("d", cursorPathData);
    arrowPath.setAttribute("fill", state.options.color);
    arrowPath.setAttribute("stroke", "#fafafa");
    arrowPath.setAttribute("stroke-width", "1.5");
    arrowPath.setAttribute("stroke-linejoin", "round");
    arrowPath.setAttribute("paint-order", "stroke");
    arrow.appendChild(arrowPath);
    element.appendChild(arrow);
    document.documentElement.appendChild(element);
    state.element = element;
    state.arrow = arrow;
    return element;
  };
  const clearIdleTimers = () => {
    if (state.fadeTimer !== undefined) window.clearTimeout(state.fadeTimer);
    if (state.removeTimer !== undefined) window.clearTimeout(state.removeTimer);
    state.fadeTimer = undefined;
    state.removeTimer = undefined;
  };
  const scheduleIdleFade = () => {
    if (state.mode !== "auto") return;
    clearIdleTimers();
    state.fadeTimer = window.setTimeout(() => {
      if (state.element) state.element.style.opacity = "0";
      state.removeTimer = window.setTimeout(() => {
        state.element?.remove();
        state.element = null;
        state.arrow = null;
        state.removeTimer = undefined;
      }, 180);
      state.fadeTimer = undefined;
    }, 650);
  };
  const show = (options) => {
    clearIdleTimers();
    state.options = mergeOptions(options);
    state.mode = "persistent";
    const element = ensureElement();
    applyVisualOptions();
    applyPosition();
    element.style.opacity = "1";
    element.dataset.pressed = "false";
  };
  const hide = () => {
    clearIdleTimers();
    if (state.animationFrame !== undefined) window.cancelAnimationFrame(state.animationFrame);
    state.animationFrame = undefined;
    state.previousFrameTime = undefined;
    flushFlightResolvers();
    state.path = null;
    state.spring = null;
    state.springTarget = null;
    state.mode = "disabled";
    state.element?.remove();
    state.element = null;
    state.arrow = null;
    document.getElementById(stageId)?.remove();
    state.stage = null;
  };
  const restore = (position) => {
    if (typeof position?.x !== "number" || typeof position?.y !== "number") return;
    clearIdleTimers();
    state.mode = "persistent";
    state.targetX = position.x;
    state.targetY = position.y;
    state.renderedX = position.x;
    state.renderedY = position.y;
    state.heading = typeof position?.heading === "number" ? position.heading : NOSE_HEADING;
    state.path = null;
    state.spring = null;
    state.springTarget = null;
    const element = ensureElement();
    applyVisualOptions();
    element.dataset.targetX = String(position.x);
    element.dataset.targetY = String(position.y);
    element.dataset.pressed = "false";
    element.style.opacity = "1";
    applyPosition();
  };
  const waitMs = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const runSingleMouseAction = (action) => {
    if (state.mode === "disabled" || typeof action?.x !== "number" || typeof action?.y !== "number") {
      return Promise.resolve();
    }
    const element = ensureElement();
    applyVisualOptions();
    state.targetX = action.x;
    state.targetY = action.y;
    try {
      window.sessionStorage.setItem(positionStorageKey, JSON.stringify({ x: action.x, y: action.y, heading: state.heading }));
    } catch {}
    element.dataset.targetX = String(action.x);
    element.dataset.targetY = String(action.y);
    element.style.opacity = "1";

    if (action.type === "down") {
      element.dataset.pressed = "true";
      applyPosition();
      spawnClickPulse(action.x, action.y, "down");
      scheduleIdleFade();
      return waitMs(45);
    }
    if (action.type === "up") {
      element.dataset.pressed = "false";
      applyPosition();
      spawnClickPulse(action.x, action.y, "up");
      scheduleIdleFade();
      return waitMs(65);
    }

    const dx = action.x - state.renderedX;
    const dy = action.y - state.renderedY;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) {
      state.renderedX = action.x;
      state.renderedY = action.y;
      applyPosition();
      scheduleIdleFade();
      return Promise.resolve();
    }

    const directHeading = Math.atan2(dy, dx);
    state.arcSign *= -1;
    const turnRadius = clamp(dist * 0.28, 18, 76);
    const th0 = state.path || state.spring ? state.heading : directHeading + state.arcSign * 0.48;
    const th1 = directHeading - state.arcSign * 0.24;
    state.path = planDubinsPath(state.renderedX, state.renderedY, th0, action.x, action.y, th1, turnRadius);
    state.dist = 0;
    state.spring = null;
    state.springTarget = null;
    startLoop();
    scheduleIdleFade();

    const estimatedMs = clamp((state.path.length / 540) * 1000, 140, 480);
    return new Promise((resolve) => {
      const safetyTimer = window.setTimeout(() => {
        if (state.path) {
          state.renderedX = action.x;
          state.renderedY = action.y;
          state.heading = th1;
          state.path = null;
          state.dist = 0;
          applyPosition();
        }
        resolve();
      }, estimatedMs + 140);
      state.flightResolvers.push(() => {
        window.clearTimeout(safetyTimer);
        resolve();
      });
    });
  };
  // Serialize move -> down -> up so Playwright's concurrent Promise.all([move, down, up])
  // inside locator.click() always flies the full Dubins path before pressing!
  const applyMouseEvent = (action) => {
    const next = state.actionQueue.then(() => runSingleMouseAction(action), () => runSingleMouseAction(action));
    state.actionQueue = next;
    return next;
  };

  const setCaption = (payload) => {
    const stage = ensureStage();
    const existing = document.getElementById(captionId);
    if (!payload || !payload.title) {
      try { window.sessionStorage.removeItem(captionStorageKey); } catch {}
      if (existing) {
        existing.animate([{ opacity: 1, transform: "translate3d(-50%, 0, 0)" }, { opacity: 0, transform: "translate3d(-50%, 8px, 0)" }], { duration: 180, easing: "ease-out" }).onfinish = () => existing.remove();
      }
      return;
    }
    try { window.sessionStorage.setItem(captionStorageKey, JSON.stringify(payload)); } catch {}
    if (existing) existing.remove();
    const wrap = document.createElement("div");
    wrap.id = captionId;
    wrap.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:24px",
      "transform:translate3d(-50%, 0, 0)",
      "display:flex",
      "align-items:stretch",
      "gap:12px",
      "padding:10px 16px 10px 12px",
      "background:rgba(14, 14, 13, 0.88)",
      "backdrop-filter:blur(14px)",
      "-webkit-backdrop-filter:blur(14px)",
      "border:1px solid rgba(255, 255, 255, 0.12)",
      "border-radius:10px",
      "box-shadow:0 12px 32px rgba(0, 0, 0, 0.35)",
      "color:#e2dfd9",
      "pointer-events:none",
      "max-width:min(680px, 88vw)",
    ].join(";");
    const barColor = tones[payload.options?.tone] || tones.neutral;
    const bar = document.createElement("div");
    bar.style.cssText = "width:3.5px;border-radius:999px;background:" + barColor + ";transform-origin:bottom;";
    const textCol = document.createElement("div");
    textCol.style.cssText = "display:flex;flex-direction:column;justify-content:center;gap:2px;overflow:hidden;";
    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;letter-spacing:-0.01em;color:#f4f3ef;white-space:nowrap;";
    if (payload.options?.step) {
      const stepBadge = document.createElement("span");
      stepBadge.textContent = payload.options.step;
      stepBadge.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.09);color:" + barColor + ";";
      titleRow.appendChild(stepBadge);
    }
    const titleSpan = document.createElement("span");
    titleSpan.textContent = payload.title;
    titleRow.appendChild(titleSpan);
    textCol.appendChild(titleRow);
    if (payload.options?.subtitle) {
      const sub = document.createElement("div");
      sub.textContent = payload.options.subtitle;
      sub.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      textCol.appendChild(sub);
    }
    wrap.append(bar, textCol);
    stage.appendChild(wrap);
    bar.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    textCol.animate([{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  };
  const clearCallouts = () => {
    const stage = document.getElementById(stageId);
    if (!stage) return;
    for (const node of Array.from(stage.querySelectorAll("[data-bc-callout='true']"))) {
      node.remove();
    }
  };
  const showCallout = (payload) => {
    if (!payload?.rect) return;
    clearCallouts();
    const stage = ensureStage();
    const toneColor = tones[payload.options?.tone] || tones.neutral;
    const { x, y, width, height } = payload.rect;
    const container = document.createElement("div");
    container.dataset.bcCallout = "true";
    container.style.cssText = "position:fixed;inset:0;pointer-events:none;";

    const ring = document.createElement("div");
    ring.style.cssText = [
      "position:fixed",
      "left:" + formatCoord(x - 4) + "px",
      "top:" + formatCoord(y - 4) + "px",
      "width:" + formatCoord(width + 8) + "px",
      "height:" + formatCoord(height + 8) + "px",
      "border-radius:8px",
      "border:1.75px solid " + toneColor,
      "box-shadow:0 0 0 1px rgba(14,14,13,0.5), 0 0 20px rgba(224,179,90,0.22)",
      "box-sizing:border-box",
    ].join(";");

    const placeAbove = y > 68;
    const chipTop = placeAbove ? Math.max(12, y - 42) : Math.min(window.innerHeight - 48, y + height + 12);
    const chipLeft = clamp(x, 16, Math.max(16, window.innerWidth - 320));
    const chip = document.createElement("div");
    chip.style.cssText = [
      "position:fixed",
      "left:" + formatCoord(chipLeft) + "px",
      "top:" + formatCoord(chipTop) + "px",
      "display:inline-flex",
      "align-items:center",
      "gap:8px",
      "padding:5px 11px",
      "background:rgba(14, 14, 13, 0.92)",
      "backdrop-filter:blur(12px)",
      "border:1px solid rgba(255,255,255,0.15)",
      "border-radius:999px",
      "box-shadow:0 8px 20px rgba(0,0,0,0.32)",
      "font-size:12px",
      "font-weight:600",
      "color:#f4f3ef",
      "white-space:nowrap",
    ].join(";");
    const dot = document.createElement("span");
    dot.style.cssText = "width:7px;height:7px;border-radius:999px;background:" + toneColor + ";flex-shrink:0;";
    const text = document.createElement("span");
    text.textContent = payload.label;
    chip.append(dot, text);
    if (payload.options?.detail) {
      const detail = document.createElement("span");
      detail.textContent = payload.options.detail;
      detail.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:500;color:#9ca3af;";
      chip.appendChild(detail);
    }
    container.append(ring, chip);
    stage.appendChild(container);
    ring.animate([{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "scale(1)" }], { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    chip.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  };
  globalThis.__browserControlGhostCursor = {
    version: 5,
    show,
    hide,
    restore,
    applyMouseEvent,
    setCaption,
    showCallout,
    clearCallouts,
    isVisible: () => state.mode !== "disabled" && Boolean(state.element),
  };
  const restoreSavedState = () => {
    try {
      const savedPosition = JSON.parse(window.sessionStorage.getItem(positionStorageKey) || "null");
      if (typeof savedPosition?.x === "number" && typeof savedPosition?.y === "number") {
        restore(savedPosition);
      }
      const savedCaption = JSON.parse(window.sessionStorage.getItem(captionStorageKey) || "null");
      if (savedCaption?.title) {
        setCaption(savedCaption);
      }
    } catch {}
  };
  if (document.documentElement) {
    restoreSavedState();
  } else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      restoreSavedState();
    });
    observer.observe(document, { childList: true });
  }
})();`

export function inputDispatchMouseEventToGhostCursorAction(params: JsonObject | undefined): GhostCursorMouseAction | undefined {
  if (!params) {
    return undefined
  }
  const type = params.type
  if (type !== "mouseMoved" && type !== "mousePressed" && type !== "mouseReleased") {
    return undefined
  }
  if (!Predicate.isNumber(params.x) || !Predicate.isNumber(params.y)) {
    return undefined
  }
  const button = parseButton(params.button)
  return {
    type: Match.value(type).pipe(
      Match.when("mousePressed", () => "down" as const),
      Match.when("mouseReleased", () => "up" as const),
      Match.when("mouseMoved", () => "move" as const),
      Match.exhaustive,
    ),
    x: params.x,
    y: params.y,
    button,
  }
}

export function ghostCursorMouseActionExpression(action: GhostCursorMouseAction): string {
  return `globalThis.__browserControlGhostCursor?.applyMouseEvent(${JSON.stringify(action)})`
}

export function ghostCursorRestoreExpression(position: { readonly x: number; readonly y: number }): string {
  return `globalThis.__browserControlGhostCursor?.restore(${JSON.stringify(position)})`
}

export async function showGhostCursor(options: { readonly page: Page; readonly cursorOptions?: GhostCursorClientOptions }): Promise<void> {
  await options.page.evaluate(ghostCursorClientSource)
  const payload: GhostCursorEvaluatePayload = options.cursorOptions ? { cursorOptions: options.cursorOptions } : {}
  await options.page.evaluate(
    (payload: GhostCursorEvaluatePayload) => {
      const api = (globalThis as { __browserControlGhostCursor?: GhostCursorBrowserApi }).__browserControlGhostCursor
      api?.show(payload.cursorOptions)
    },
    payload,
  )
}

export async function hideGhostCursor(options: { readonly page: Page }): Promise<void> {
  await options.page.evaluate(() => {
    const api = (globalThis as { __browserControlGhostCursor?: GhostCursorBrowserApi }).__browserControlGhostCursor
    api?.hide()
  })
}

export async function setGhostCursorCaption(options: {
  readonly page: Page
  readonly title: string | null
  readonly captionOptions?: GhostCursorCaptionOptions
}): Promise<void> {
  await options.page.evaluate(ghostCursorClientSource)
  const payload: GhostCursorCaptionPayload | null = options.title
    ? { title: options.title, ...(options.captionOptions ? { options: options.captionOptions } : {}) }
    : null
  await options.page.evaluate((captionPayload: GhostCursorCaptionPayload | null) => {
    const api = (globalThis as { __browserControlGhostCursor?: GhostCursorBrowserApi }).__browserControlGhostCursor
    api?.setCaption(captionPayload)
  }, payload)
}

export async function showGhostCursorCallout(options: {
  readonly page: Page
  readonly target: Locator | string
  readonly label: string
  readonly calloutOptions?: GhostCursorCalloutOptions
}): Promise<void> {
  await options.page.evaluate(ghostCursorClientSource)
  const locator = Predicate.isString(options.target) ? options.page.locator(options.target) : options.target
  const box = await locator.first().boundingBox()
  if (!box) return
  const payload: GhostCursorCalloutPayload = {
    rect: box,
    label: options.label,
    ...(options.calloutOptions ? { options: options.calloutOptions } : {}),
  }
  await options.page.evaluate((calloutPayload: GhostCursorCalloutPayload) => {
    const api = (globalThis as { __browserControlGhostCursor?: GhostCursorBrowserApi }).__browserControlGhostCursor
    api?.showCallout(calloutPayload)
  }, payload)
}

export async function clearGhostCursorCallouts(options: { readonly page: Page }): Promise<void> {
  await options.page.evaluate(() => {
    const api = (globalThis as { __browserControlGhostCursor?: GhostCursorBrowserApi }).__browserControlGhostCursor
    api?.clearCallouts()
  })
}

function parseButton(value: JsonObject[string] | undefined): GhostCursorMouseAction["button"] {
  if (value === "left" || value === "right" || value === "middle" || value === "none") {
    return value
  }
  return "none"
}
