import type { PageStatus } from "../../src/protocol.ts"
import { pageStatusView } from "./page-status.ts"

const hostId = "__browser_control_page_status__"
let currentStatus: PageStatus | undefined
let observer: MutationObserver | undefined
let completingHandoffId: string | undefined
let attendedCursor: HTMLElement | undefined
let cursorAnimation: Animation | undefined
let cursorFill: string | null | undefined
let cursorFilter: string | undefined

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return
  }
  const incoming = message as { readonly action?: unknown; readonly status?: unknown }
  if (incoming.action === "page-status.clear") {
    clearStatus()
    return
  }
  if (incoming.action === "page-status.set" && isPageStatus(incoming.status)) {
    currentStatus = incoming.status
    completingHandoffId = undefined
    renderStatus()
  }
})

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
      #status {
        box-sizing: border-box;
        max-width: min(360px, calc(100vw - 20px));
        overflow: hidden;
        padding: 4px 7px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        background: rgba(24, 24, 27, 0.76);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
        color: rgba(255, 255, 255, 0.86);
        font: 650 9px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        letter-spacing: 0.06em;
        text-overflow: ellipsis;
        white-space: nowrap;
        backdrop-filter: blur(8px);
        opacity: 0.58;
      }
      #status::before {
        display: inline-block;
        width: 5px;
        height: 5px;
        margin-right: 5px;
        border-radius: 50%;
        background: #8b5cf6;
        content: "";
        vertical-align: 1px;
      }
      #status[data-tone="running"]::before { background: #f59e0b; }
      #status[data-tone="waiting"]::before { background: #3b82f6; }
      #status[data-tone="running"] { opacity: 0.92; }
      #status[data-tone="waiting"] {
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
      :host([data-anchor="cursor"]) #status[data-tone="waiting"] {
        right: auto;
        bottom: auto;
        left: var(--bc-prompt-left);
        top: var(--bc-prompt-top);
        transform-origin: 18px 0;
      }
      #vignette {
        position: fixed;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(ellipse at center, transparent 64%, rgba(37, 99, 235, 0.055) 100%);
        box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.1), inset 0 0 64px rgba(37, 99, 235, 0.07);
        animation: handoff-pulse 2600ms ease-in-out infinite;
      }
      #prompt {
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
        #status[data-tone="waiting"], #vignette { animation: none; }
      }
    `
    const status = document.createElement("div")
    status.id = "status"
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    shadow.append(style, status)
  }

  const statusElement = host.shadowRoot?.getElementById("status")
  if (!statusElement) {
    return
  }
  const view = pageStatusView(currentStatus)
  statusElement.replaceChildren(document.createTextNode(view.label))
  statusElement.title = view.title
  statusElement.setAttribute("aria-label", view.title)
  statusElement.dataset.tone = view.tone
  host.dataset.interactive = String(view.completion !== undefined)
  host.dataset.waiting = String(view.completion !== undefined)
  host.shadowRoot?.getElementById("vignette")?.remove()
  clearGhostCursorAttention()
  if (view.message) {
    const prompt = document.createElement("div")
    prompt.id = "prompt"
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
    vignette.id = "vignette"
    host.shadowRoot?.insertBefore(vignette, statusElement)
    positionWaitingStatus(host, statusElement)
  }
  if (!host.isConnected) {
    document.documentElement.append(host)
  }
  observeHost()
}

function positionWaitingStatus(host: HTMLElement, statusElement: HTMLElement): void {
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
    if (currentStatus && !document.getElementById(hostId)) {
      renderStatus()
    }
  })
  observer.observe(document.documentElement, { childList: true })
}

function isPageStatus(value: unknown): value is PageStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const candidate = value as { readonly state?: unknown; readonly owner?: unknown; readonly message?: unknown; readonly handoffId?: unknown }
  const validState = candidate.state === "attached" || candidate.state === "running" || candidate.state === "waiting"
  const validOwner = candidate.owner === "session" || candidate.owner === "user"
  const validHandoff = candidate.state !== "waiting" || (typeof candidate.message === "string" && typeof candidate.handoffId === "string")
  return validState && validOwner && validHandoff
}
