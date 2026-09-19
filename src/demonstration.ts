import type { Frame, Page } from "playwright-core"

export type DemonstrationStep =
  | { readonly kind: "click"; readonly selector: string; readonly role?: string; readonly name?: string }
  | { readonly kind: "fill"; readonly selector: string; readonly value: string; readonly redacted?: boolean }
  | { readonly kind: "check"; readonly selector: string; readonly checked: boolean }
  | { readonly kind: "select"; readonly selector: string; readonly value: string }
  | { readonly kind: "navigation"; readonly url: string }

export type DemonstrationResult = {
  readonly startedUrl: string
  readonly endedUrl: string
  readonly steps: readonly DemonstrationStep[]
  readonly code: string
}

type PageRecorderState = {
  readonly bindingName: string
  active?: { readonly id: string; readonly startedUrl: string; readonly steps: DemonstrationStep[] }
}

const pageRecorders = new WeakMap<Page, PageRecorderState>()
let nextRecorder = 0

export async function startDemonstrationRecorder(page: Page): Promise<{ readonly stop: () => Promise<DemonstrationResult> }> {
  const state = await recorderState(page)
  if (state.active) throw new Error("A human demonstration is already being recorded on this page")
  const id = `demo-${++nextRecorder}`
  const active = { id, startedUrl: page.url(), steps: [] as DemonstrationStep[] }
  state.active = active
  const pendingInstalls = new Set<Promise<void>>()
  const install = (frame: Frame): Promise<void> => {
    const pending = frame.evaluate(installDemonstrationListeners, { bindingName: state.bindingName, recorderId: id })
      .then(() => {}, () => {})
      .finally(() => pendingInstalls.delete(pending))
    pendingInstalls.add(pending)
    return pending
  }
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) appendStep(active.steps, { kind: "navigation", url: frame.url() })
    void install(frame)
  }
  page.on("framenavigated", onFrameNavigated)
  await Promise.all(page.frames().map(install))
  let stopped = false
  return {
    stop: async () => {
      if (stopped) throw new Error("Human demonstration recording has already stopped")
      stopped = true
      page.off("framenavigated", onFrameNavigated)
      await Promise.all([...pendingInstalls])
      await Promise.all(page.frames().map((frame) => frame.evaluate(removeDemonstrationListeners, { recorderId: id }).catch(() => {})))
      if (state.active?.id === id) delete state.active
      const steps = [...active.steps]
      const endedUrl = page.isClosed() ? active.startedUrl : page.url()
      return {
        startedUrl: active.startedUrl,
        endedUrl,
        steps,
        code: formatDemonstrationCode({ startedUrl: active.startedUrl, steps }),
      }
    },
  }
}

export function formatDemonstrationCode(options: {
  readonly startedUrl: string
  readonly steps: readonly DemonstrationStep[]
}): string {
  const lines = [`// Recorded from ${options.startedUrl}`]
  for (const step of options.steps) {
    if (step.kind === "navigation") {
      lines.push(`// Navigated to ${step.url}`)
    } else if (step.kind === "click") {
      const description = step.role && step.name ? ` // ${step.role} ${JSON.stringify(step.name)}` : ""
      lines.push(`await page.locator(${JSON.stringify(step.selector)}).click()${description}`)
    } else if (step.kind === "fill") {
      if (step.redacted) lines.push(`// Fill ${JSON.stringify(step.selector)} from an approved secret source.`)
      else lines.push(`await page.locator(${JSON.stringify(step.selector)}).fill(${JSON.stringify(step.value)})`)
    } else if (step.kind === "check") {
      lines.push(`await page.locator(${JSON.stringify(step.selector)}).${step.checked ? "check" : "uncheck"}()`)
    } else {
      lines.push(`await page.locator(${JSON.stringify(step.selector)}).selectOption(${JSON.stringify(step.value)})`)
    }
  }
  lines.push("return { url: page.url(), title: await page.title() }")
  return lines.join("\n")
}

async function recorderState(page: Page): Promise<PageRecorderState> {
  const existing = pageRecorders.get(page)
  if (existing) return existing
  const bindingName = `__browserControlDemonstration${++nextRecorder}`
  const state: PageRecorderState = { bindingName }
  pageRecorders.set(page, state)
  await page.exposeBinding(bindingName, (_source, value: unknown) => {
    const active = state.active
    if (!active || !isDemonstrationStep(value)) return
    appendStep(active.steps, value)
  })
  return state
}

function appendStep(steps: DemonstrationStep[], next: DemonstrationStep): void {
  const previous = steps.at(-1)
  if (next.kind === "fill" && previous?.kind === "fill" && previous.selector === next.selector) {
    steps[steps.length - 1] = next
    return
  }
  if (next.kind === "navigation" && previous?.kind === "navigation" && previous.url === next.url) return
  steps.push(next)
}

function isDemonstrationStep(value: unknown): value is DemonstrationStep {
  if (!value || typeof value !== "object" || !("kind" in value)) return false
  const step = value as Record<string, unknown>
  if (step.kind === "navigation") return typeof step.url === "string"
  if (typeof step.selector !== "string") return false
  if (step.kind === "click") return true
  if (step.kind === "fill") return typeof step.value === "string"
  if (step.kind === "check") return typeof step.checked === "boolean"
  return step.kind === "select" && typeof step.value === "string"
}

function installDemonstrationListeners(options: { readonly bindingName: string; readonly recorderId: string }): void {
  type BrowserState = { readonly id: string; readonly cleanup: () => void }
  const key = "__browserControlDemonstrationListeners__"
  const browserWindow = window as unknown as Record<string, BrowserState | undefined>
  browserWindow[key]?.cleanup()
  const send = (step: DemonstrationStep) => {
    const binding = (window as unknown as Record<string, unknown>)[options.bindingName]
    if (typeof binding === "function") void Promise.resolve(binding(step)).catch(() => {})
  }
  const cssPath = (element: Element): string => {
    const id = element.getAttribute("id")
    if (id) return `#${CSS.escape(id)}`
    for (const attribute of ["data-testid", "data-test", "name", "aria-label"]) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      const candidate = `[${attribute}="${CSS.escape(value)}"]`
      if (document.querySelectorAll(candidate).length === 1) return candidate
    }
    const parent = element.parentElement
    const tag = element.tagName.toLowerCase()
    if (!parent) return tag
    const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === element.tagName)
    return `${cssPath(parent)} > ${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
  }
  const nameFor = (element: Element): string | undefined => {
    const ariaLabel = element.getAttribute("aria-label")?.trim()
    if (ariaLabel) return ariaLabel
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim()
      if (text) return text
    }
    const text = element.textContent?.replace(/\s+/g, " ").trim()
    return text ? text.slice(0, 120) : undefined
  }
  const roleFor = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role")
    if (explicit) return explicit
    if (element instanceof HTMLButtonElement) return "button"
    if (element instanceof HTMLAnchorElement) return "link"
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox"
      if (element.type === "radio") return "radio"
      return "textbox"
    }
    if (element instanceof HTMLSelectElement) return "combobox"
    if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)) return "textbox"
    return undefined
  }
  const onClick = (event: Event) => {
    const target = event.composedPath().find((candidate) => candidate instanceof Element) as Element | undefined
    const actionable = target?.closest("button, a[href], summary, [role='button'], [role='link'], [role='tab'], [role='menuitem']")
    if (!actionable) return
    const role = roleFor(actionable)
    const name = nameFor(actionable)
    send({ kind: "click", selector: cssPath(actionable), ...(role === undefined ? {} : { role }), ...(name === undefined ? {} : { name }) })
  }
  const onInput = (event: Event) => {
    const element = event.target
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio", "file", "button", "submit", "reset"].includes(element.type)) return
      send({ kind: "fill", selector: cssPath(element), value: element.type === "password" ? "" : element.value, ...(element.type === "password" ? { redacted: true } : {}) })
    } else if (element instanceof HTMLTextAreaElement) {
      send({ kind: "fill", selector: cssPath(element), value: element.value })
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      send({ kind: "fill", selector: cssPath(element), value: element.innerText })
    }
  }
  const onChange = (event: Event) => {
    const element = event.target
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      send({ kind: "check", selector: cssPath(element), checked: element.checked })
    } else if (element instanceof HTMLSelectElement) {
      send({ kind: "select", selector: cssPath(element), value: element.value })
    } else {
      onInput(event)
    }
  }
  document.addEventListener("click", onClick, true)
  document.addEventListener("input", onInput, true)
  document.addEventListener("change", onChange, true)
  const cleanup = () => {
    document.removeEventListener("click", onClick, true)
    document.removeEventListener("input", onInput, true)
    document.removeEventListener("change", onChange, true)
    if (browserWindow[key]?.id === options.recorderId) delete browserWindow[key]
  }
  browserWindow[key] = { id: options.recorderId, cleanup }
}

function removeDemonstrationListeners(options: { readonly recorderId: string }): void {
  const key = "__browserControlDemonstrationListeners__"
  const browserWindow = window as unknown as Record<string, { readonly id: string; readonly cleanup: () => void } | undefined>
  if (browserWindow[key]?.id === options.recorderId) browserWindow[key]?.cleanup()
}
