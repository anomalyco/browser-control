import type { PageStatus } from "../../src/protocol.ts"
import { pageStatusView } from "./page-status.ts"

const hostId = "__browser_control_page_status__"
let currentStatus: PageStatus | undefined
let observer: MutationObserver | undefined

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
        pointer-events: auto !important;
        user-select: text !important;
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
        min-width: min(320px, calc(100vw - 20px));
        padding: 10px;
        border-radius: 12px;
        opacity: 1;
        white-space: normal;
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
      }
      button:hover { background: #1d4ed8; }
      button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
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
      void chrome.runtime.sendMessage({ action: "handoff.complete", handoffId: completion.handoffId }).catch(() => {})
    })
    statusElement.append(button)
  }
  if (!host.isConnected) {
    document.documentElement.append(host)
  }
  observeHost()
}

function clearStatus(): void {
  currentStatus = undefined
  observer?.disconnect()
  observer = undefined
  document.getElementById(hostId)?.remove()
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
