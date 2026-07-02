import { Effect, Scope } from "effect"
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Frame, type Locator, type Page } from "playwright-core"
import * as acorn from "acorn"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import url from "node:url"
import util from "node:util"
import events from "node:events"
import stream from "node:stream"
import buffer from "node:buffer"
import http from "node:http"
import https from "node:https"
import zlib from "node:zlib"
import { hideGhostCursor as hideGhostCursorOnPage, showGhostCursor as showGhostCursorOnPage, type GhostCursorClientOptions } from "./ghost-cursor.ts"
import type { ExecuteAftermath } from "./relay-schema.ts"

const nodeModules = { fs, path, os, crypto, url, util, events, stream, buffer, http, https, zlib }

type SandboxGlobals = {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly state: Record<string, unknown>
  readonly modules: typeof nodeModules
  readonly fillInput: (target: InputTarget, value: string) => Promise<void>
  readonly fillInputs: (page: Page, fields: ReadonlyArray<InputField>) => Promise<void>
  readonly screenshotWithLabels: (options: ScreenshotWithLabelsOptions) => Promise<ScreenshotWithLabelsResult>
  readonly showGhostCursor: (options?: ShowGhostCursorOptions) => Promise<void>
  readonly hideGhostCursor: (options?: HideGhostCursorOptions) => Promise<void>
  readonly ghostCursor: {
    readonly show: (options?: ShowGhostCursorOptions) => Promise<void>
    readonly hide: (options?: HideGhostCursorOptions) => Promise<void>
  }
  readonly handoff: (message?: string, options?: HandoffCallOptions) => Promise<void>
  readonly handoffTracker: { count: number }
}

type HandoffCallOptions = {
  readonly timeoutMs?: number
  readonly page?: Page
}

export type HandoffOutcome = "resolved" | "timeout"

export type RequestHandoff = (options: { readonly message: string; readonly timeoutMs: number }) => Promise<HandoffOutcome>

const defaultHandoffTimeoutMs = 10 * 60 * 1_000

const defaultHandoffMessage = "Waiting for you — click the Browser Control toolbar button to continue."

type InputTarget = Locator | string

type InputField = {
  readonly selector: string
  readonly value: string
}

type ShowGhostCursorOptions = GhostCursorClientOptions & {
  readonly page?: Page
}

type HideGhostCursorOptions = {
  readonly page?: Page
}

type ScreenshotWithLabelsOptions = {
  readonly page: Page
  readonly path: string
}

type ScreenshotWithLabelsResult = {
  readonly path: string
  readonly size: number
  readonly labelCount: number
  readonly labels: readonly ScreenshotLabel[]
  readonly refs: Record<string, ScreenshotLabelRef>
}

type ScreenshotLabel = {
  readonly ref: string
  readonly selector: string
  readonly role: string
  readonly text: string
  readonly tagName: string
  readonly rect: ScreenshotLabelRect
}

type ScreenshotLabelRef = Omit<ScreenshotLabel, "ref">

type ScreenshotLabelRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type ExecuteTargetSelection = {
  readonly urlIncludes?: string
  readonly index?: number
}

type ExecuteSandboxOptions = {
  readonly endpointUrl: string
  readonly sessionId?: string
  readonly requestHandoff?: RequestHandoff
}

export type ExecuteResult = {
  readonly text: string
  readonly isError: boolean
  readonly logs: readonly ExecuteLogEntry[]
  readonly warnings: readonly string[]
  readonly aftermath?: ExecuteAftermath
}

class ExecuteCodeError extends Error {
  constructor(
    readonly originalError: Error,
    readonly logs: readonly ExecuteLogEntry[],
    readonly aftermath?: ExecuteAftermath,
  ) {
    super(originalError.message, { cause: originalError })
    this.name = originalError.name
    if (originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export type ExecuteLogEntry = {
  readonly source: "script" | "page"
  readonly type: string
  readonly text: string
  readonly location?: {
    readonly url: string
    readonly lineNumber: number
    readonly columnNumber: number
  }
}

export type ExecuteOptions = {
  readonly targetSelection?: ExecuteTargetSelection
}

export class ExecuteSandbox {
  private browser: Browser | undefined
  private page: Page | undefined
  private ownsPage = false
  private readonly state: Record<string, unknown> = {}
  private pendingWarnings: string[] = []

  constructor(readonly options: ExecuteSandboxOptions) {}

  static scoped(options: ExecuteSandboxOptions): Effect.Effect<ExecuteSandbox, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new ExecuteSandbox(options)),
      (sandbox) => sandbox.close().pipe(Effect.ignore),
    )
  }

  execute(code: string, options: ExecuteOptions = {}): Effect.Effect<ExecuteResult> {
    return Effect.tryPromise({
      try: async () => {
        const globals = await this.getGlobals(options)
        const { result, logs, aftermath } = await runUserCode({ code, globals })
        return { text: stringifyResult(result), isError: false, logs, warnings: this.drainWarnings(), aftermath }
      },
      catch: (cause) => {
        if (cause instanceof ExecuteCodeError) {
          return cause
        }
        return cause instanceof Error ? cause : new Error("execute sandbox code", { cause })
      },
    }).pipe(
      Effect.match({
        onFailure: (error): ExecuteResult => {
          return {
            text: error.stack ?? error.message,
            isError: true,
            logs: error instanceof ExecuteCodeError ? error.logs : [],
            warnings: this.drainWarnings(),
            ...(error instanceof ExecuteCodeError && error.aftermath ? { aftermath: error.aftermath } : {}),
          }
        },
        onSuccess: (result) => {
          return result
        },
      }),
    )
  }

  private drainWarnings(): string[] {
    const warnings = this.pendingWarnings
    this.pendingWarnings = []
    return warnings
  }

  close(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: async () => {
        if (this.page && this.ownsPage && !this.page.isClosed()) {
          await this.page.close().catch(() => {})
        }
        await this.browser?.close()
        this.browser = undefined
        this.page = undefined
        this.ownsPage = false
      },
      catch: (cause) => {
        return new Error("close sandbox browser", { cause })
      },
    })
  }

  private async getGlobals(options: ExecuteOptions): Promise<SandboxGlobals> {
    if (!this.browser?.isConnected()) {
      const hadBrowser = this.browser !== undefined
      await this.browser?.close().catch(() => {})
      this.browser = await chromium.connectOverCDP(this.options.endpointUrl, {
        ...(this.options.sessionId ? { headers: { "Browser-Control-Session-Id": this.options.sessionId } } : {}),
      })
      this.page = undefined
      this.ownsPage = false
      if (hadBrowser) {
        this.pendingWarnings.push("Relay connection was lost and re-established; the session default page was re-resolved.")
      }
    }
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext())
    const targetSelection = options.targetSelection
    const page = await this.getSessionPage({ context, ...(targetSelection ? { targetSelection } : {}) })
    const showGhostCursor = async (options?: ShowGhostCursorOptions) => {
      const cursorOptions = ghostCursorOptions(options)
      await showGhostCursorOnPage({ page: options?.page ?? page, ...(cursorOptions ? { cursorOptions } : {}) })
    }
    const hideGhostCursor = async (options?: HideGhostCursorOptions) => {
      await hideGhostCursorOnPage({ page: options?.page ?? page })
    }
    const handoffTracker = { count: 0 }
    const requestHandoff = this.options.requestHandoff
    const handoff = async (message?: string, options?: HandoffCallOptions) => {
      if (!requestHandoff) {
        throw new Error("handoff is not available in this sandbox; it requires a relay-backed Browser Control session")
      }
      const handoffMessage = message?.trim() || defaultHandoffMessage
      const timeoutMs = options?.timeoutMs ?? defaultHandoffTimeoutMs
      const bannerPage = options?.page ?? page
      await showHandoffBanner(bannerPage, handoffMessage).catch(() => {})
      try {
        const outcome = await requestHandoff({ message: handoffMessage, timeoutMs })
        if (outcome === "timeout") {
          throw new Error(`Handoff timed out after ${timeoutMs}ms waiting for the user: ${handoffMessage}`)
        }
        handoffTracker.count += 1
      } finally {
        await hideHandoffBanner(bannerPage).catch(() => {})
      }
    }
    return {
      browser: this.browser,
      context,
      page,
      state: this.state,
      modules: nodeModules,
      fillInput: (target, value) => fillInput({ page, target, value }),
      fillInputs,
      screenshotWithLabels,
      showGhostCursor,
      hideGhostCursor,
      ghostCursor: {
        show: showGhostCursor,
        hide: hideGhostCursor,
      },
      handoff,
      handoffTracker,
    }
  }

  getStatus(): { readonly sessionId?: string; readonly connected: boolean; readonly pageUrl: string | null; readonly stateKeys: string[] } {
    return {
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      connected: Boolean(this.browser?.isConnected()),
      pageUrl: this.page && !this.page.isClosed() ? this.page.url() : null,
      stateKeys: Object.keys(this.state),
    }
  }

  private async getSessionPage({ context, targetSelection }: { readonly context: BrowserContext; readonly targetSelection?: ExecuteTargetSelection }): Promise<Page> {
    const selection = targetSelection ?? {}
    const hasExplicitSelection = Boolean(selection.urlIncludes) || selection.index !== undefined
    if (hasExplicitSelection) {
      const selected = selectPage({ pages: context.pages(), selection })
      if (!selected) {
        throw new Error("No page matched target selection")
      }
      return selected
    }
    if (this.page && !this.page.isClosed()) {
      return this.page
    }
    if (this.page?.isClosed()) {
      this.pendingWarnings.push("The session default page was closed; created a new page. References to the old page in state are stale.")
    }
    this.page = await context.newPage()
    this.ownsPage = true
    return this.page
  }
}

async function showHandoffBanner(page: Page, message: string): Promise<void> {
  await page.evaluate((bannerMessage) => {
    const bannerId = "__browser_control_handoff__"
    document.getElementById(bannerId)?.remove()
    const banner = document.createElement("div")
    banner.id = bannerId
    banner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "padding:10px 16px",
      "background:#7c3aed",
      "color:#ffffff",
      "font:600 14px/1.4 system-ui,-apple-system,sans-serif",
      "text-align:center",
      "box-shadow:0 2px 8px rgba(17,24,39,0.35)",
      "pointer-events:none",
    ].join(";")
    banner.textContent = `Browser Control: ${bannerMessage} (click the Browser Control toolbar button to continue)`
    document.documentElement.appendChild(banner)
  }, message)
}

async function hideHandoffBanner(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("__browser_control_handoff__")?.remove()
  })
}

function selectPage({ pages, selection }: { readonly pages: readonly Page[]; readonly selection: ExecuteTargetSelection }): Page | undefined {
  if (selection.urlIncludes && selection.index !== undefined) {
    throw new Error("Use only one target selector: --target-url or --target-index")
  }
  if (selection.urlIncludes) {
    const matches = pages.filter((candidate) => {
      return candidate.url().includes(selection.urlIncludes ?? "")
    })
    if (matches.length === 0) {
      throw new Error(`No attached page URL includes ${selection.urlIncludes}`)
    }
    if (matches.length > 1) {
      throw new Error(`Multiple attached pages (${matches.length}) match URL ${selection.urlIncludes}; use a more specific --target-url or --target-index`)
    }
    return matches[0]
  }
  if (selection.index !== undefined) {
    if (selection.index < 0) {
      throw new Error("Target index must be a non-negative integer")
    }
    const page = pages[selection.index]
    if (!page) {
      throw new Error(`No attached page at index ${selection.index}; ${pages.length} page(s) available`)
    }
    return page
  }
  if (pages.length > 1) {
    throw new Error(`Multiple attached pages (${pages.length}); use --target-url or --target-index to choose one`)
  }
  return pages[0]
}

function ghostCursorOptions(options: ShowGhostCursorOptions | undefined): GhostCursorClientOptions | undefined {
  if (!options) {
    return undefined
  }
  return {
    ...(options.color ? { color: options.color } : {}),
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(options.zIndex !== undefined ? { zIndex: options.zIndex } : {}),
  }
}

async function fillInput(options: { readonly page: Page; readonly target: InputTarget; readonly value: string }): Promise<void> {
  if (typeof options.target === "string") {
    await fillInputs(options.page, [{ selector: options.target, value: options.value }])
    return
  }
  const locator = options.target
  await locator.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
      throw new Error("fillInput expects an input or textarea locator")
    }
    const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    element.focus()
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, nextValue)
    } else {
      element.value = nextValue
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    element.blur()
  }, options.value, { timeout: 30_000 })
}

async function fillInputs(page: Page, fields: ReadonlyArray<InputField>): Promise<void> {
  await page.evaluate((inputFields) => {
    return inputFields.map((field) => {
      const matches = document.querySelectorAll(field.selector)
      if (matches.length !== 1) {
        throw new Error(`fillInputs expects exactly one match for selector: ${field.selector}; got ${matches.length}`)
      }
      const element = matches[0]
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        throw new Error(`fillInputs expects input or textarea selector: ${field.selector}`)
      }
      const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
      const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
      element.focus()
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, field.value)
      } else {
        element.value = field.value
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: field.value }))
      element.dispatchEvent(new Event("change", { bubbles: true }))
      element.blur()
      return field.selector
    })
  }, fields)
}

async function screenshotWithLabels(options: ScreenshotWithLabelsOptions): Promise<ScreenshotWithLabelsResult> {
  if (!path.isAbsolute(options.path)) {
    throw new Error("screenshotWithLabels requires an absolute path")
  }

  const labels = await showScreenshotLabels(options.page)
  try {
    const screenshot = await options.page.screenshot({ path: options.path })
    return {
      path: options.path,
      size: screenshot.byteLength,
      labelCount: labels.length,
      labels,
      refs: Object.fromEntries(labels.map((label) => {
        const { ref, ...metadata } = label
        return [ref, metadata]
      })),
    }
  } finally {
    await hideScreenshotLabels(options.page)
  }
}

async function showScreenshotLabels(page: Page): Promise<readonly ScreenshotLabel[]> {
  return await page.evaluate(() => {
    type BrowserLabel = {
      readonly ref: string
      readonly selector: string
      readonly role: string
      readonly text: string
      readonly tagName: string
      readonly rect: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
    }

    const containerId = "__browser_control_screenshot_labels__"
    const markerClass = "__browser_control_screenshot_label__"
    const browserControlWindow = window as Window & { __browserControlScreenshotLabelsTimer?: number }
    if (browserControlWindow.__browserControlScreenshotLabelsTimer) {
      window.clearTimeout(browserControlWindow.__browserControlScreenshotLabelsTimer)
      delete browserControlWindow.__browserControlScreenshotLabelsTimer
    }
    document.getElementById(containerId)?.remove()

    const selectors = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      "[onclick]",
      "[contenteditable]",
    ]
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter((element, index, elements) => {
        return elements.indexOf(element) === index
      })
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        if (rect.width < 4 || rect.height < 4) {
          return false
        }
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
          return false
        }
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0"
      })
      .slice(0, 80)

    const escapeCss = (value: string): string => {
      return CSS.escape(value)
    }

    const quoteAttribute = (value: string): string => {
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    }

    const selectorForElement = (element: Element): string => {
      const id = element.getAttribute("id")
      if (id) {
        return `#${escapeCss(id)}`
      }
      const testId = element.getAttribute("data-testid")
      if (testId) {
        return `[data-testid="${quoteAttribute(testId)}"]`
      }
      const dataTest = element.getAttribute("data-test")
      if (dataTest) {
        return `[data-test="${quoteAttribute(dataTest)}"]`
      }
      const name = element.getAttribute("name")
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${quoteAttribute(name)}"]`
      }
      const parent = element.parentElement
      if (!parent) {
        return element.tagName.toLowerCase()
      }
      const siblings = Array.from(parent.children).filter((child) => {
        return child.tagName === element.tagName
      })
      const index = siblings.indexOf(element) + 1
      return `${selectorForElement(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`
    }

    const roleForElement = (element: Element): string => {
      const explicitRole = element.getAttribute("role")
      if (explicitRole) {
        return explicitRole
      }
      if (element instanceof HTMLAnchorElement) {
        return "link"
      }
      if (element instanceof HTMLButtonElement) {
        return "button"
      }
      if (element instanceof HTMLInputElement) {
        return element.type || "input"
      }
      if (element instanceof HTMLTextAreaElement) {
        return "textarea"
      }
      if (element instanceof HTMLSelectElement) {
        return "select"
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return "contenteditable"
      }
      return element.getAttribute("onclick") ? "onclick" : element.tagName.toLowerCase()
    }

    const textForElement = (element: Element): string => {
      const ariaLabel = element.getAttribute("aria-label")
      const title = element.getAttribute("title")
      const placeholder = element.getAttribute("placeholder")
      const value = element instanceof HTMLInputElement ? element.value : ""
      return (ariaLabel || placeholder || value || title || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
    }

    const labels: BrowserLabel[] = candidates.map((element, index) => {
      const rect = element.getBoundingClientRect()
      return {
        ref: `e${index + 1}`,
        selector: selectorForElement(element),
        role: roleForElement(element),
        text: textForElement(element),
        tagName: element.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    })

    const container = document.createElement("div")
    container.id = containerId
    container.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"

    const style = document.createElement("style")
    style.textContent = `
      .${markerClass} {
        position: fixed;
        min-width: 18px;
        box-sizing: border-box;
        padding: 1px 4px;
        border: 1px solid #7c3aed;
        border-radius: 4px;
        background: #a78bfa;
        color: #111827;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        box-shadow: 0 1px 3px rgba(17, 24, 39, 0.35);
      }
    `
    container.appendChild(style)

    const markers = labels.map((label) => {
      const marker = document.createElement("div")
      marker.className = markerClass
      marker.textContent = label.ref
      marker.style.left = `${Math.max(0, label.rect.x)}px`
      marker.style.top = `${Math.max(0, label.rect.y - 18)}px`
      return marker
    })
    container.append(...markers)

    document.documentElement.appendChild(container)
    browserControlWindow.__browserControlScreenshotLabelsTimer = window.setTimeout(() => {
      document.getElementById(containerId)?.remove()
      delete browserControlWindow.__browserControlScreenshotLabelsTimer
    }, 30_000)
    return labels
  })
}

async function hideScreenshotLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserControlWindow = window as Window & { __browserControlScreenshotLabelsTimer?: number }
    if (browserControlWindow.__browserControlScreenshotLabelsTimer) {
      window.clearTimeout(browserControlWindow.__browserControlScreenshotLabelsTimer)
      delete browserControlWindow.__browserControlScreenshotLabelsTimer
    }
    document.getElementById("__browser_control_screenshot_labels__")?.remove()
  })
}

const maxTrackedNavigations = 25

async function runUserCode({ code, globals }: { readonly code: string; readonly globals: SandboxGlobals }): Promise<{
  readonly result: unknown
  readonly logs: readonly ExecuteLogEntry[]
  readonly aftermath: ExecuteAftermath
}> {
  const logs: ExecuteLogEntry[] = []
  const navigations: string[] = []
  const onConsole = (message: ConsoleMessage) => {
    logs.push({
      source: "page",
      type: message.type(),
      text: message.text(),
      location: message.location(),
    })
  }
  const onPageError = (error: Error) => {
    logs.push({
      source: "page",
      type: "pageerror",
      text: error.stack ?? error.message,
    })
  }
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== globals.page.mainFrame() || navigations.length >= maxTrackedNavigations) {
      return
    }
    navigations.push(frame.url())
  }
  const sandboxConsole = createSandboxConsole({ logs })
  const startUrl = safePageUrl(globals.page)
  globals.page.on("console", onConsole)
  globals.page.on("pageerror", onPageError)
  globals.page.on("framenavigated", onFrameNavigated)
  const buildAftermath = (): ExecuteAftermath => {
    return {
      startUrl,
      endUrl: safePageUrl(globals.page),
      navigations,
      consoleErrorCount: logs.filter((log) => log.type === "error").length,
      pageErrorCount: logs.filter((log) => log.type === "pageerror").length,
      handoffs: globals.handoffTracker.count,
    }
  }
  const AsyncFunction = async function () {}.constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
  const fn = new AsyncFunction(
    "console",
    "browser",
    "context",
    "page",
    "state",
    "modules",
    "fillInput",
    "fillInputs",
    "screenshotWithLabels",
    "showGhostCursor",
    "hideGhostCursor",
    "ghostCursor",
    "handoff",
    `const { fs, path, os, crypto, url, util, events, stream, buffer, http, https, zlib } = modules;\n${wrapCode(code)}`,
  )
  try {
    const result = await fn(
      sandboxConsole,
      globals.browser,
      globals.context,
      globals.page,
      globals.state,
      globals.modules,
      globals.fillInput,
      globals.fillInputs,
      globals.screenshotWithLabels,
      globals.showGhostCursor,
      globals.hideGhostCursor,
      globals.ghostCursor,
      globals.handoff,
    )
    return { result, logs, aftermath: buildAftermath() }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("execute sandbox code", { cause })
    throw new ExecuteCodeError(error, logs, buildAftermath())
  } finally {
    globals.page.off("console", onConsole)
    globals.page.off("pageerror", onPageError)
    globals.page.off("framenavigated", onFrameNavigated)
  }
}

function safePageUrl(page: Page): string | null {
  try {
    return page.isClosed() ? null : page.url()
  } catch {
    return null
  }
}

function createSandboxConsole(options: { readonly logs: ExecuteLogEntry[] }): Pick<Console, "debug" | "error" | "info" | "log" | "warn"> {
  const capture = (type: ExecuteLogEntry["type"], values: readonly unknown[]) => {
    options.logs.push({
      source: "script",
      type,
      text: values.map(formatLogValue).join(" "),
    })
  }
  return {
    debug: (...values: readonly unknown[]) => {
      capture("debug", values)
    },
    error: (...values: readonly unknown[]) => {
      capture("error", values)
    },
    info: (...values: readonly unknown[]) => {
      capture("info", values)
    },
    log: (...values: readonly unknown[]) => {
      capture("log", values)
    },
    warn: (...values: readonly unknown[]) => {
      capture("warn", values)
    },
  }
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  return util.inspect(value, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000 })
}

export function getAutoReturnExpression(code: string): string | null {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      sourceType: "script",
    })
    if (ast.body.length !== 1) {
      return null
    }
    const statement = ast.body[0]
    if (!statement || statement.type === "ReturnStatement" || statement.type !== "ExpressionStatement") {
      return null
    }
    const expression = statement.expression
    if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") {
      return null
    }
    if (expression.type === "UnaryExpression" && expression.operator === "delete") {
      return null
    }
    if (expression.type === "SequenceExpression" && expression.expressions.some((item) => {
      return item.type === "AssignmentExpression"
    })) {
      return null
    }
    return code.slice(expression.start, expression.end)
  } catch {
    return null
  }
}

export function wrapCode(code: string): string {
  const expression = getAutoReturnExpression(code)
  if (expression) {
    return `return await (${expression})`
  }
  return code
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") {
    return result
  }
  if (result === undefined) {
    return "undefined"
  }
  return util.inspect(result, { depth: 3, colors: false, maxArrayLength: 50, maxStringLength: 4000 })
}
