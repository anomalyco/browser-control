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
  readonly applyMouseEvent: (action: GhostCursorMouseAction) => void
  readonly isVisible: () => boolean
}

export const ghostCursorElementId = "__browser_control_ghost_cursor__"

export const ghostCursorClientSource = `(() => {
  if (window !== window.top) {
    return;
  }
  const cursorId = "${ghostCursorElementId}";
  const defaults = { color: "#7c3aed", size: 18, zIndex: 2147483647 };
  const state = { element: null, x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2), visible: false, options: defaults };
  const mergeOptions = (options) => ({
    color: typeof options?.color === "string" ? options.color : defaults.color,
    size: typeof options?.size === "number" && Number.isFinite(options.size) ? options.size : defaults.size,
    zIndex: typeof options?.zIndex === "number" && Number.isFinite(options.zIndex) ? options.zIndex : defaults.zIndex,
  });
  const applyPosition = () => {
    if (!state.element) {
      return;
    }
    const offset = state.options.size / 2;
    state.element.style.transform = "translate3d(" + Math.round(state.x - offset) + "px, " + Math.round(state.y - offset) + "px, 0)";
  };
  const applyVisualOptions = () => {
    if (!state.element) {
      return;
    }
    state.element.style.width = state.options.size + "px";
    state.element.style.height = state.options.size + "px";
    state.element.style.zIndex = String(state.options.zIndex);
    state.element.style.borderColor = state.options.color;
    state.element.style.boxShadow = "0 0 0 2px rgba(255,255,255,0.9), 0 6px 18px rgba(0,0,0,0.28)";
    state.element.style.background = "rgba(124,58,237,0.2)";
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
    element.style.border = "2px solid";
    element.style.borderRadius = "999px";
    element.style.boxSizing = "border-box";
    element.style.transition = "transform 90ms linear, opacity 120ms ease-out";
    element.style.willChange = "transform";
    element.style.opacity = "0";
    document.documentElement.appendChild(element);
    state.element = element;
    return element;
  };
  const show = (options) => {
    state.options = mergeOptions(options);
    state.visible = true;
    const element = ensureElement();
    applyVisualOptions();
    applyPosition();
    element.style.opacity = "1";
    element.dataset.pressed = "false";
  };
  const hide = () => {
    state.visible = false;
    state.element?.remove();
    state.element = null;
  };
  const applyMouseEvent = (action) => {
    if (!state.visible || typeof action?.x !== "number" || typeof action?.y !== "number") {
      return;
    }
    const element = ensureElement();
    state.x = action.x;
    state.y = action.y;
    applyPosition();
    if (action.type === "down") {
      element.style.opacity = "1";
      element.style.scale = "0.82";
      element.dataset.pressed = "true";
      return;
    }
    if (action.type === "up") {
      element.style.scale = "1";
      element.dataset.pressed = "false";
    }
  };
  globalThis.__browserControlGhostCursor = { show, hide, applyMouseEvent, isVisible: () => state.visible };
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
