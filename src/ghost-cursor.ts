import type { Page } from "playwright-core"
import type { JsonObject } from "./protocol.ts"

export type GhostCursorClientOptions = {
  readonly color?: string
  readonly size?: number
  readonly zIndex?: number
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

type GhostCursorBrowserApi = {
  readonly show: (options?: GhostCursorClientOptions) => void
  readonly hide: () => void
  readonly restore: (position: { readonly x: number; readonly y: number }) => void
  readonly applyMouseEvent: (action: GhostCursorMouseAction) => void
  readonly isVisible: () => boolean
}

export const ghostCursorElementId = "__browser_control_ghost_cursor__"

export const ghostCursorClientSource = `(() => {
  if (window !== window.top) {
    return;
  }
  if (globalThis.__browserControlGhostCursor?.version === 3) {
    return;
  }
  const cursorId = "${ghostCursorElementId}";
  const positionStorageKey = "__browser_control_ghost_cursor_position__";
  const defaults = { color: "#7c3aed", size: 22, zIndex: 2147483646 };
  const spring = { stiffness: 220, damping: 24, mass: 1 };
  const svgNamespace = "http://www.w3.org/2000/svg";
  const cursorPathData =
    "M0.92 2.18C0.61 1.37 1.42 0.58 2.23 0.9L14.39 5.68C15.23 6.01 15.23 7.2 14.39 7.54L9.86 9.37C9.61 9.47 9.41 9.67 9.31 9.92L7.44 14.42C7.09 15.25 5.9 15.23 5.58 14.39L0.92 2.18Z";
  const state = {
    element: null,
    targetX: Math.round(window.innerWidth / 2),
    targetY: Math.round(window.innerHeight / 2),
    renderedX: Math.round(window.innerWidth / 2),
    renderedY: Math.round(window.innerHeight / 2),
    velocityX: 0,
    velocityY: 0,
    animationFrame: undefined,
    previousFrameTime: undefined,
    mode: "auto",
    options: defaults,
    fadeTimer: undefined,
    removeTimer: undefined,
  };
  const mergeOptions = (options) => ({
    color: typeof options?.color === "string" ? options.color : defaults.color,
    size: typeof options?.size === "number" && Number.isFinite(options.size) ? options.size : defaults.size,
    zIndex: typeof options?.zIndex === "number" && Number.isFinite(options.zIndex) ? options.zIndex : defaults.zIndex,
  });
  const applyPosition = () => {
    if (!state.element) {
      return;
    }
    state.element.style.transform = "translate3d(" + state.renderedX.toFixed(2) + "px, " + state.renderedY.toFixed(2) + "px, 0)";
  };
  const springStep = (timestamp) => {
    if (!state.element) {
      state.animationFrame = undefined;
      state.previousFrameTime = undefined;
      return;
    }
    const elapsed = state.previousFrameTime === undefined ? 1 / 60 : Math.min((timestamp - state.previousFrameTime) / 1000, 0.064);
    state.previousFrameTime = timestamp;
    let remaining = elapsed;
    while (remaining > 0) {
      const delta = Math.min(remaining, 1 / 120);
      const accelerationX = (spring.stiffness * (state.targetX - state.renderedX) - spring.damping * state.velocityX) / spring.mass;
      const accelerationY = (spring.stiffness * (state.targetY - state.renderedY) - spring.damping * state.velocityY) / spring.mass;
      state.velocityX += accelerationX * delta;
      state.velocityY += accelerationY * delta;
      state.renderedX += state.velocityX * delta;
      state.renderedY += state.velocityY * delta;
      remaining -= delta;
    }
    const settled =
      Math.abs(state.targetX - state.renderedX) < 0.05 &&
      Math.abs(state.targetY - state.renderedY) < 0.05 &&
      Math.abs(state.velocityX) < 1 &&
      Math.abs(state.velocityY) < 1;
    if (settled) {
      state.renderedX = state.targetX;
      state.renderedY = state.targetY;
      state.velocityX = 0;
      state.velocityY = 0;
      state.animationFrame = undefined;
      state.previousFrameTime = undefined;
      applyPosition();
      return;
    }
    applyPosition();
    state.animationFrame = window.requestAnimationFrame(springStep);
  };
  const startSpring = () => {
    if (state.animationFrame === undefined) {
      state.animationFrame = window.requestAnimationFrame(springStep);
    }
  };
  const snapToTarget = () => {
    if (state.animationFrame !== undefined) window.cancelAnimationFrame(state.animationFrame);
    state.animationFrame = undefined;
    state.previousFrameTime = undefined;
    state.renderedX = state.targetX;
    state.renderedY = state.targetY;
    state.velocityX = 0;
    state.velocityY = 0;
    applyPosition();
  };
  const applyVisualOptions = () => {
    if (!state.element) {
      return;
    }
    state.element.style.width = state.options.size + "px";
    state.element.style.height = state.options.size + "px";
    state.element.style.zIndex = String(state.options.zIndex);
    state.element.style.filter = "drop-shadow(0 2px 4px rgba(0,0,0,0.3))";
    const arrow = state.element.children[0];
    const ripple = state.element.children[1];
    if (arrow instanceof SVGSVGElement && arrow.firstElementChild) {
      arrow.firstElementChild.setAttribute("fill", state.options.color);
    }
    if (ripple instanceof HTMLDivElement) ripple.style.borderColor = state.options.color;
  };
  const ensureElement = () => {
    const existing = document.getElementById(cursorId);
    if (existing instanceof HTMLDivElement) {
      state.element = existing;
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
    element.style.transition = "opacity 180ms ease-out, scale 90ms ease-out";
    element.style.transformOrigin = "0 0";
    element.style.willChange = "transform, opacity, scale";
    element.style.opacity = "0";
    element.dataset.motion = "spring";
    const arrow = document.createElementNS(svgNamespace, "svg");
    arrow.setAttribute("viewBox", "0 0 16 16");
    arrow.style.display = "block";
    arrow.style.width = "100%";
    arrow.style.height = "100%";
    arrow.style.overflow = "visible";
    const arrowPath = document.createElementNS(svgNamespace, "path");
    arrowPath.setAttribute("d", cursorPathData);
    arrowPath.setAttribute("stroke", "#ffffff");
    arrowPath.setAttribute("stroke-width", "1.5");
    arrowPath.setAttribute("stroke-linejoin", "round");
    arrowPath.setAttribute("paint-order", "stroke");
    arrow.appendChild(arrowPath);
    const ripple = document.createElement("div");
    ripple.style.position = "absolute";
    ripple.style.left = "-9px";
    ripple.style.top = "-9px";
    ripple.style.width = "18px";
    ripple.style.height = "18px";
    ripple.style.border = "2px solid";
    ripple.style.borderRadius = "999px";
    ripple.style.boxSizing = "border-box";
    ripple.style.opacity = "0";
    element.append(arrow, ripple);
    document.documentElement.appendChild(element);
    state.element = element;
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
    state.mode = "disabled";
    state.element?.remove();
    state.element = null;
  };
  const restore = (position) => {
    if (typeof position?.x !== "number" || typeof position?.y !== "number") return;
    clearIdleTimers();
    state.mode = "persistent";
    state.targetX = position.x;
    state.targetY = position.y;
    state.renderedX = position.x;
    state.renderedY = position.y;
    state.velocityX = 0;
    state.velocityY = 0;
    const element = ensureElement();
    applyVisualOptions();
    element.dataset.targetX = String(position.x);
    element.dataset.targetY = String(position.y);
    element.dataset.pressed = "false";
    element.style.opacity = "1";
    applyPosition();
  };
  const applyMouseEvent = (action) => {
    if (state.mode === "disabled" || typeof action?.x !== "number" || typeof action?.y !== "number") {
      return;
    }
    const element = ensureElement();
    applyVisualOptions();
    state.targetX = action.x;
    state.targetY = action.y;
    try { window.sessionStorage.setItem(positionStorageKey, JSON.stringify({ x: action.x, y: action.y })); } catch {}
    element.dataset.targetX = String(action.x);
    element.dataset.targetY = String(action.y);
    element.style.opacity = "1";
    if (action.type === "down") {
      snapToTarget();
      element.style.scale = "0.88";
      element.dataset.pressed = "true";
    } else if (action.type === "up") {
      element.style.scale = "1";
      element.dataset.pressed = "false";
      const ripple = element.children[1];
      if (ripple instanceof HTMLDivElement) {
        ripple.animate(
          [
            { opacity: 0.75, transform: "scale(0.35)" },
            { opacity: 0, transform: "scale(1.8)" },
          ],
          { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    } else {
      startSpring();
    }
    scheduleIdleFade();
  };
  globalThis.__browserControlGhostCursor = { version: 3, show, hide, restore, applyMouseEvent, isVisible: () => state.mode !== "disabled" && Boolean(state.element) };
  try {
    const savedPosition = JSON.parse(window.sessionStorage.getItem(positionStorageKey) || "null");
    if (typeof savedPosition?.x === "number" && typeof savedPosition?.y === "number") {
      if (document.documentElement) {
        restore(savedPosition);
      } else {
        const observer = new MutationObserver(() => {
          if (!document.documentElement) return;
          observer.disconnect();
          restore(savedPosition);
        });
        observer.observe(document, { childList: true });
      }
    }
  } catch {}
})();`

export function inputDispatchMouseEventToGhostCursorAction(params: JsonObject | undefined): GhostCursorMouseAction | undefined {
  if (!params) {
    return undefined
  }
  const type = params.type
  if (type !== "mouseMoved" && type !== "mousePressed" && type !== "mouseReleased") {
    return undefined
  }
  if (typeof params.x !== "number" || typeof params.y !== "number") {
    return undefined
  }
  const button = parseButton(params.button)
  return {
    type: type === "mousePressed" ? "down" : type === "mouseReleased" ? "up" : "move",
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
  await ensureGhostCursorInjected(options.page)
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

async function ensureGhostCursorInjected(page: Page): Promise<void> {
  const hasGhostCursor = await page.evaluate(() => {
    return Boolean((globalThis as { __browserControlGhostCursor?: unknown }).__browserControlGhostCursor)
  })
  if (hasGhostCursor) {
    return
  }
  await page.evaluate(ghostCursorClientSource)
}

function parseButton(value: JsonObject[string] | undefined): GhostCursorMouseAction["button"] {
  if (value === "left" || value === "right" || value === "middle" || value === "none") {
    return value
  }
  return "none"
}
