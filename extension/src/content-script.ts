import type { PageStatus } from "../../src/protocol.ts"
import { DynamicIslandRig, ISLAND_CANVAS_H, ISLAND_CANVAS_W, springCss } from "./dynamic-island-gpu.ts"
import { pageStatusFromJson, pageStatusView } from "./page-status.ts"

const hostId = "__browser_control_page_status__"
let currentStatus: PageStatus | undefined
let pendingTabRequest: { readonly requestId: string; readonly sessionId?: string; readonly message: string } | undefined
let observer: MutationObserver | undefined
let completingHandoffId: string | undefined
let attendedCursor: HTMLElement | undefined
let cursorAnimation: Animation | undefined
let cursorFill: string | null | undefined
let cursorFilter: string | undefined
let islandRig: DynamicIslandRig | undefined
let idleHideTimer: ReturnType<typeof setTimeout> | undefined
let collapseCleanupTimer: ReturnType<typeof setTimeout> | undefined

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return
  }
  const incoming = message as { readonly action?: unknown; readonly status?: unknown; readonly requestId?: unknown; readonly sessionId?: unknown; readonly message?: unknown }
  if (incoming.action === "evict-extension-frames") {
    const removed = evictForeignExtensionFrames()
    sendResponse({ removed })
    return
  }
  if (incoming.action === "tab-request.prompt" && typeof incoming.requestId === "string") {
    pendingTabRequest = {
      requestId: incoming.requestId,
      ...(typeof incoming.sessionId === "string" && incoming.sessionId ? { sessionId: incoming.sessionId } : {}),
      message: typeof incoming.message === "string" && incoming.message ? incoming.message : "Allow Browser Control to use this tab?",
    }
    currentStatus = {
      state: "waiting",
      owner: "user",
      ...(pendingTabRequest.sessionId ? { sessionId: pendingTabRequest.sessionId } : {}),
      message: pendingTabRequest.message,
      handoffId: `tab-request:${pendingTabRequest.requestId}`,
    }
    renderStatus()
    sendResponse({ shown: true })
    return
  }
  if (incoming.action === "page-status.clear") {
    pendingTabRequest = undefined
    clearStatus()
    return
  }
  const status = pageStatusFromJson(incoming.status)
  if (incoming.action === "page-status.set" && status) {
    pendingTabRequest = undefined
    currentStatus = status
    completingHandoffId = undefined
    if (status.state !== "waiting") {
      evictForeignExtensionFrames()
    }
    renderStatus()
  }
})

const foreignExtensionSelector = [
  "com-1password-notification",
  "com-1password-menu",
  "com-1password-button",
  "[data-onepassword-extension]",
  "[data-lastpass-root]",
  "[id^='bitwarden-']",
  "iframe[src^='chrome-extension://']",
  "frame[src^='chrome-extension://']",
  "object[data^='chrome-extension://']",
  "embed[src^='chrome-extension://']",
].join(",")

function evictForeignExtensionNodesIn(
  root: Document | ShadowRoot | Element,
  pierceShadows = false,
): number {
  let removed = 0
  const ownOrigin = `chrome-extension://${chrome.runtime.id}`
  const isForeignFrameElement = (el: Element): boolean => {
    if (el.id === hostId || el.id === "__browser_control_ghost_cursor__") return false
    const rawSrc = el.getAttribute("src") ?? el.getAttribute("data") ?? (el as HTMLIFrameElement).src
    const src = typeof rawSrc === "string" ? rawSrc : ""
    if (src.startsWith(ownOrigin)) return false
    if (src.startsWith("chrome-extension://")) return true
    if (el.matches(foreignExtensionSelector)) return true
    if (el instanceof HTMLIFrameElement || el.tagName === "FRAME") {
      try {
        const href = (el as HTMLIFrameElement).contentWindow?.location?.href ?? ""
        if (href.startsWith("chrome-extension://") && !href.startsWith(ownOrigin)) return true
      } catch {
        // Cross-origin frame; child content-script ("all_frames": true) handles its own DOM
      }
    }
    return false
  }
  if (root instanceof Element && isForeignFrameElement(root)) {
    root.remove()
    return 1
  }
  for (const el of root.querySelectorAll(`iframe, frame, ${foreignExtensionSelector}`)) {
    if (isForeignFrameElement(el)) {
      el.remove()
      removed += 1
    }
  }
  if (pierceShadows) {
    if (root instanceof Element && root.id !== hostId && root.shadowRoot) {
      removed += evictForeignExtensionNodesIn(root.shadowRoot, true)
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.id !== hostId && el.shadowRoot) {
        removed += evictForeignExtensionNodesIn(el.shadowRoot, true)
      }
    }
  }
  return removed
}

function evictForeignExtensionFrames(): number {
  return document.documentElement ? evictForeignExtensionNodesIn(document, true) : 0
}

chrome.runtime.sendMessage({ action: "page-status.ready" }).catch(() => {})
window.addEventListener("keydown", (event) => {
  if (pendingTabRequest && event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    decideTabRequest(pendingTabRequest.requestId, false)
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && currentStatus?.state === "waiting" && currentStatus.handoffId) {
    event.preventDefault()
    event.stopPropagation()
    if (pendingTabRequest) {
      decideTabRequest(pendingTabRequest.requestId, true)
    } else {
      completeHandoff(currentStatus.handoffId)
    }
  }
}, true)
document.addEventListener("DOMContentLoaded", () => {
  if (currentStatus) {
    if (currentStatus.state !== "waiting") evictForeignExtensionFrames()
    renderStatus()
  }
}, { once: true })

function renderStatus(): void {
  if (!currentStatus || !document.documentElement) {
    return
  }
  if (window !== window.top) {
    observeHost()
    return
  }
  let host = document.getElementById(hostId)
  if (!host) {
    host = document.createElement("div")
    host.id = hostId
    const shadow = host.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    style.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        top: 0 !important;
        left: 50% !important;
        width: ${ISLAND_CANVAS_W}px !important;
        height: ${ISLAND_CANVAS_H}px !important;
        transform: translateX(-50%) !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        user-select: none !important;
        contain: layout style !important;
      }
      :host([data-interactive="true"]) {
        user-select: text !important;
      }
      #__browser_control_island_canvas__ {
        position: absolute;
        left: 0;
        top: 0;
        width: ${ISLAND_CANVAS_W}px;
        height: ${ISLAND_CANVAS_H}px;
        pointer-events: none;
      }
      #__browser_control_status__ {
        position: absolute;
        box-sizing: border-box;
        overflow: hidden;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        color: rgba(248, 248, 250, 0.96);
        font: 540 12.5px/1.28 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
        letter-spacing: -0.012em;
        pointer-events: none;
        opacity: 0;
      }
      #__browser_control_prompt__, #__browser_control_actions__ {
        opacity: 0;
        transform-origin: 50% 0%;
        will-change: transform, opacity;
      }
      #__browser_control_prompt__ {
        margin: 0;
        color: #f4f3ef;
        font: 560 12.5px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        letter-spacing: -0.012em;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #__browser_control_actions__ {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      button {
        box-sizing: border-box;
        flex: 1;
        padding: 5.5px 12px;
        border: 0;
        border-radius: 999px;
        background: #f4f3ef;
        box-shadow: inset 0 0.5px 0 #ffffff, 0 1px 2px rgba(0, 0, 0, 0.32);
        color: #09090b;
        cursor: pointer;
        font: 600 11.5px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        letter-spacing: -0.01em;
        pointer-events: auto;
        transition: transform ${springCss({ visualDuration: 0.3, bounce: 0.3 })}, opacity 120ms ease;
      }
      button:hover { opacity: 0.92; }
      button:active { transform: scale(0.96); transition-duration: 90ms; transition-timing-function: ease-out; }
      button:disabled { cursor: default; opacity: 0.65; }
      button:focus-visible { outline: 2px solid #f4f3ef; outline-offset: 2px; }
    `
    const canvas = document.createElement("canvas")
    canvas.id = "__browser_control_island_canvas__"
    const status = document.createElement("div")
    status.id = "__browser_control_status__"
    shadow.append(style, canvas, status)
    islandRig?.destroy()
    islandRig = new DynamicIslandRig(canvas, status)
  }

  const statusElement = host.shadowRoot?.getElementById("__browser_control_status__")
  if (!statusElement) {
    return
  }
  const view = pageStatusView(currentStatus)
  if (collapseCleanupTimer !== undefined) {
    clearTimeout(collapseCleanupTimer)
    collapseCleanupTimer = undefined
  }
  if (view.tone === "waiting") {
    statusElement.replaceChildren()
  } else if (statusElement.children.length > 0) {
    collapseCleanupTimer = setTimeout(() => {
      statusElement.replaceChildren()
      collapseCleanupTimer = undefined
    }, 180)
  }
  statusElement.title = view.title
  statusElement.setAttribute("aria-label", view.title)
  statusElement.dataset.tone = view.tone
  host.setAttribute("aria-hidden", String(view.completion === undefined))
  host.dataset.interactive = String(view.completion !== undefined)
  host.dataset.waiting = String(view.completion !== undefined)
  if (idleHideTimer !== undefined) {
    clearTimeout(idleHideTimer)
    idleHideTimer = undefined
  }
  if (view.tone === "active") {
    idleHideTimer = setTimeout(() => {
      islandRig?.setVisible(false)
    }, 1_800)
  }
  clearGhostCursorAttention()
  if (view.message) {
    const prompt = document.createElement("div")
    prompt.id = "__browser_control_prompt__"
    prompt.textContent = view.message
    statusElement.append(prompt)
  }
  if (view.completion) {
    const completion = view.completion
    const actionsRow = document.createElement("div")
    actionsRow.id = "__browser_control_actions__"
    const button = document.createElement("button")
    button.type = "button"
    if (pendingTabRequest) {
      const requestId = pendingTabRequest.requestId
      button.textContent = "Allow · ⌘↵"
      button.addEventListener("click", () => {
        button.disabled = true
        button.textContent = "Attaching…"
        decideTabRequest(requestId, true)
      })
      const decline = document.createElement("button")
      decline.type = "button"
      decline.textContent = "Not now"
      decline.style.background = "rgba(255, 255, 255, 0.10)"
      decline.style.boxShadow = "inset 0 0.5px 0 rgba(255, 255, 255, 0.14)"
      decline.style.color = "#d4d4d8"
      decline.addEventListener("click", () => {
        decideTabRequest(requestId, false)
      })
      actionsRow.append(button, decline)
    } else {
      button.textContent = `${completion.label} · ⌘↵`
      button.addEventListener("click", () => {
        button.disabled = true
        button.textContent = "Continuing…"
        completeHandoff(completion.handoffId)
      })
      actionsRow.append(button)
    }
    statusElement.append(actionsRow)
    const cursor = document.getElementById("__browser_control_ghost_cursor__")
    if (cursor) highlightGhostCursor(cursor)
  }
  if (!host.isConnected) {
    document.documentElement.append(host)
  }
  islandRig?.configure(view.tone)
  observeHost()
}

function highlightGhostCursor(cursor: HTMLElement): void {
  attendedCursor = cursor
  cursorFilter = cursor.style.filter
  const baseFilter = cursorFilter || "drop-shadow(0 2px 4px rgba(0,0,0,0.3))"
  cursorAnimation = cursor.animate(
    [
      { filter: `${baseFilter} drop-shadow(0 0 3px rgba(244,243,239,0.25))` },
      { filter: `${baseFilter} drop-shadow(0 0 10px rgba(244,243,239,0.65))` },
      { filter: `${baseFilter} drop-shadow(0 0 3px rgba(244,243,239,0.25))` },
    ],
    { duration: 1600, iterations: Infinity, easing: "ease-in-out" },
  )
}

function clearGhostCursorAttention(): void {
  cursorAnimation?.cancel()
  const path = attendedCursor?.querySelector("svg path")
  if (path && cursorFill !== undefined) {
    if (cursorFill === null) path.removeAttribute("fill")
    else path.setAttribute("fill", cursorFill)
  }
  if (attendedCursor && cursorFilter !== undefined) attendedCursor.style.filter = cursorFilter
  attendedCursor = undefined
  cursorAnimation = undefined
  cursorFill = undefined
  cursorFilter = undefined
}

function clearStatus(): void {
  currentStatus = undefined
  completingHandoffId = undefined
  if (idleHideTimer !== undefined) {
    clearTimeout(idleHideTimer)
    idleHideTimer = undefined
  }
  if (collapseCleanupTimer !== undefined) {
    clearTimeout(collapseCleanupTimer)
    collapseCleanupTimer = undefined
  }
  clearGhostCursorAttention()
  observer?.disconnect()
  observer = undefined
  const host = document.getElementById(hostId)
  const rig = islandRig
  islandRig = undefined
  if (!host) {
    rig?.destroy()
    return
  }
  // Release the id so a new status can mount immediately while this island animates out.
  host.removeAttribute("id")
  host.inert = true
  const remove = () => {
    rig?.destroy()
    host.remove()
  }
  if (!rig) return remove()
  void Promise.race([rig.exit(), new Promise((resolve) => setTimeout(resolve, 700))]).then(remove)
}

function decideTabRequest(requestId: string, approved: boolean): void {
  pendingTabRequest = undefined
  clearStatus()
  void chrome.runtime.sendMessage({ action: "tab-request.decision", requestId, approved }).catch(() => {})
}

function completeHandoff(handoffId: string): void {
  if (completingHandoffId === handoffId) {
    return
  }
  completingHandoffId = handoffId
  void chrome.runtime.sendMessage({ action: "handoff.complete", handoffId }).catch(() => {
    completingHandoffId = undefined
  })
}

function observeHost(): void {
  if (observer || !document.documentElement) {
    return
  }
  observer = new MutationObserver((records) => {
    if (!currentStatus) {
      return
    }
    if (currentStatus.state !== "waiting") {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) {
          evictForeignExtensionNodesIn(record.target, false)
          continue
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            evictForeignExtensionNodesIn(node, true)
          }
        }
      }
    }
    if (window === window.top && !document.getElementById(hostId)) {
      renderStatus()
    }
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data"],
  })
}
