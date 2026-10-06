import type { PageStatus } from "../../src/protocol.ts"
import { pageStatusFromJson, pageStatusView } from "./page-status.ts"

const hostId = "__browser_control_page_status__"
let currentStatus: PageStatus | undefined
let observer: MutationObserver | undefined
let completingHandoffId: string | undefined
let attendedCursor: HTMLElement | undefined
let cursorAnimation: Animation | undefined
let cursorFill: string | null | undefined
let cursorFilter: string | undefined

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return
  }
  const incoming = message as { readonly action?: unknown; readonly status?: unknown }
  if (incoming.action === "evict-extension-frames") {
    const removed = evictForeignExtensionFrames()
    sendResponse({ removed })
    return
  }
  if (incoming.action === "page-status.clear") {
    clearStatus()
    return
  }
  const status = pageStatusFromJson(incoming.status)
  if (incoming.action === "page-status.set" && status) {
    currentStatus = status
    completingHandoffId = undefined
    if (status.state !== "waiting") {
      evictForeignExtensionFrames()
    }
    renderStatus()
  }
})

function evictForeignExtensionFrames(): number {
  let removed = 0
  const ownOrigin = `chrome-extension://${chrome.runtime.id}`
  const visitRoot = (root: Document | ShadowRoot) => {
    for (const frame of root.querySelectorAll("iframe, frame, object, embed")) {
      const src = frame.getAttribute("src") ?? (frame as HTMLIFrameElement).src ?? ""
      if (src.startsWith("chrome-extension://") && !src.startsWith(ownOrigin)) {
        frame.remove()
        removed += 1
      }
    }
    for (const el of root.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase()
      if (
        tag.startsWith("com-1password-") ||
        el.hasAttribute("data-onepassword-extension") ||
        el.hasAttribute("data-lastpass-root") ||
        el.id.startsWith("bitwarden-")
      ) {
        el.remove()
        removed += 1
        continue
      }
      if (el.shadowRoot) {
        visitRoot(el.shadowRoot)
      }
    }
  }
  if (document.documentElement) {
    visitRoot(document)
  }
  return removed
}

chrome.runtime.sendMessage({ action: "page-status.ready" }).catch(() => {})

function renderStatus(): void {
  if (!currentStatus || !document.documentElement) {
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
        right: 10px !important;
        bottom: 10px !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        user-select: none !important;
        contain: layout style paint !important;
      }
      :host([data-interactive="true"]) {
        user-select: text !important;
      }
      :host([data-waiting="true"]) {
        inset: 0 !important;
        width: auto !important;
        height: auto !important;
        z-index: 2147483645 !important;
      }
      #__browser_control_status__ {
        box-sizing: border-box;
        max-width: min(360px, calc(100vw - 20px));
        overflow: hidden;
        padding: 5px 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        background: rgba(18, 18, 17, 0.84);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.24);
        color: rgba(244, 243, 239, 0.92);
        font: 550 11px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
        letter-spacing: -0.01em;
        text-overflow: ellipsis;
        white-space: nowrap;
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        opacity: 0.78;
      }
      #__browser_control_status__::before {
        display: inline-block;
        width: 5.5px;
        height: 5.5px;
        margin-right: 6px;
        border-radius: 50%;
        background: #a8ba96;
        content: "";
        vertical-align: 1px;
      }
      #__browser_control_status__[data-tone="running"]::before { background: #e0b35a; }
      #__browser_control_status__[data-tone="waiting"]::before { background: #60a5fa; }
      #__browser_control_status__[data-tone="running"] { opacity: 0.96; }
      #__browser_control_status__[data-tone="waiting"] {
        position: absolute;
        right: 10px;
        bottom: 10px;
        width: min(300px, calc(100vw - 20px));
        padding: 10px;
        border-radius: 12px;
        opacity: 1;
        white-space: normal;
        transform-origin: right bottom;
        animation: handoff-enter 420ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      :host([data-anchor="cursor"]) #__browser_control_status__[data-tone="waiting"] {
        right: auto;
        bottom: auto;
        left: var(--bc-prompt-left);
        top: var(--bc-prompt-top);
        transform-origin: 18px 0;
      }
      #__browser_control_vignette__ {
        position: fixed;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(ellipse at center, transparent 64%, rgba(37, 99, 235, 0.055) 100%);
        box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.1), inset 0 0 64px rgba(37, 99, 235, 0.07);
        animation: handoff-pulse 2600ms ease-in-out infinite;
      }
      #__browser_control_prompt__ {
        margin: 8px 0 10px;
        color: #fff;
        font: 500 13px/1.4 system-ui, -apple-system, sans-serif;
        letter-spacing: normal;
      }
      button {
        box-sizing: border-box;
        width: 100%;
        padding: 7px 10px;
        border: 0;
        border-radius: 7px;
        background: #2563eb;
        color: #fff;
        cursor: pointer;
        font: 600 13px/1.2 system-ui, -apple-system, sans-serif;
        pointer-events: auto;
      }
      button:hover { background: #1d4ed8; }
      button:disabled { cursor: default; opacity: 0.72; }
      button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      @keyframes handoff-enter {
        from { opacity: 0; transform: scale(0.72) translate(8px, 8px); }
        to { opacity: 1; transform: scale(1) translate(0, 0); }
      }
      @keyframes handoff-pulse {
        0%, 100% { opacity: 0.32; }
        50% { opacity: 0.68; }
      }
      @media (prefers-reduced-motion: reduce) {
        #__browser_control_status__[data-tone="waiting"], #__browser_control_vignette__ { animation: none; }
      }
    `
    const status = document.createElement("div")
    status.id = "__browser_control_status__"
    shadow.append(style, status)
  }

  const statusElement = host.shadowRoot?.getElementById("__browser_control_status__")
  if (!statusElement) {
    return
  }
  const view = pageStatusView(currentStatus)
  statusElement.replaceChildren(document.createTextNode(view.label))
  statusElement.title = view.title
  statusElement.setAttribute("aria-label", view.title)
  statusElement.dataset.tone = view.tone
  host.setAttribute("aria-hidden", String(view.completion === undefined))
  host.dataset.interactive = String(view.completion !== undefined)
  host.dataset.waiting = String(view.completion !== undefined)
  host.shadowRoot?.getElementById("__browser_control_vignette__")?.remove()
  clearGhostCursorAttention()
  if (view.message) {
    const prompt = document.createElement("div")
    prompt.id = "__browser_control_prompt__"
    prompt.textContent = view.message
    statusElement.append(prompt)
  }
  if (view.completion) {
    const completion = view.completion
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = completion.label
    button.addEventListener("click", () => {
      button.disabled = true
      button.textContent = "Continuing…"
      completeHandoff(completion.handoffId)
    })
    statusElement.append(button)
    const vignette = document.createElement("div")
    vignette.id = "__browser_control_vignette__"
    host.shadowRoot?.insertBefore(vignette, statusElement)
    positionWaitingStatus(host)
  }
  if (!host.isConnected) {
    document.documentElement.append(host)
  }
  observeHost()
}

function positionWaitingStatus(host: HTMLElement): void {
  const cursor = document.getElementById("__browser_control_ghost_cursor__")
  const x = Number(cursor?.dataset.targetX)
  const y = Number(cursor?.dataset.targetY)
  if (!cursor || !Number.isFinite(x) || !Number.isFinite(y)) {
    host.removeAttribute("data-anchor")
    return
  }
  highlightGhostCursor(cursor)
  const width = 300
  const estimatedHeight = 132
  const left = Math.max(10, Math.min(x + 18, window.innerWidth - width - 10))
  const below = y + 28 + estimatedHeight <= window.innerHeight
  const top = below ? y + 28 : Math.max(10, y - estimatedHeight - 22)
  host.style.setProperty("--bc-prompt-left", `${left}px`)
  host.style.setProperty("--bc-prompt-top", `${top}px`)
  host.dataset.anchor = "cursor"
}

function highlightGhostCursor(cursor: HTMLElement): void {
  attendedCursor = cursor
  cursorFilter = cursor.style.filter
  const path = cursor.querySelector("svg path")
  cursorFill = path?.getAttribute("fill")
  path?.setAttribute("fill", "#2563eb")
  const baseFilter = cursorFilter || "drop-shadow(0 2px 4px rgba(0,0,0,0.3))"
  cursorAnimation = cursor.animate(
    [
      { filter: `${baseFilter} drop-shadow(0 0 2px rgba(37,99,235,0.45))` },
      { filter: `${baseFilter} drop-shadow(0 0 8px rgba(37,99,235,0.95))` },
      { filter: `${baseFilter} drop-shadow(0 0 2px rgba(37,99,235,0.45))` },
    ],
    { duration: 1500, iterations: Infinity, easing: "ease-in-out" },
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
  clearGhostCursorAttention()
  observer?.disconnect()
  observer = undefined
  document.getElementById(hostId)?.remove()
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
  observer = new MutationObserver(() => {
    if (!currentStatus) {
      return
    }
    if (currentStatus.state !== "waiting") {
      evictForeignExtensionFrames()
    }
    if (!document.getElementById(hostId)) {
      renderStatus()
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}
