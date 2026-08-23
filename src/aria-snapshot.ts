import { selectors, type BrowserContext, type Locator, type Page } from "playwright-core"

const redactionCleanupErrorMessage = "Browser Control could not confirm ARIA snapshot value-redaction cleanup"
// Keep the engine as source text so bundlers cannot inject Node-only helpers into the browser function.
const redactionSelectorSource = `({
  query(root, body) {
    const separator = body.indexOf("_")
    const action = body.slice(0, separator)
    const token = body.slice(separator + 1)
    const stateKey = "__browserControlAriaRedactionState__"
    let state = globalThis[stateKey]

    if (action === "on") {
      if (!state) {
        state = {
          tokens: new Set(),
          nonTextInputTypes: new Set(["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"]),
          valueAttributes: new Set(["aria-valuenow", "aria-valuetext", "value"]),
          inputValue: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
          textareaValue: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
          nodeValue: Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue"),
          textContent: Object.getOwnPropertyDescriptor(Node.prototype, "textContent"),
          innerText: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText"),
          getAttribute: Object.getOwnPropertyDescriptor(Element.prototype, "getAttribute"),
        }
        globalThis[stateKey] = state
        const isRedactedControl = (element) => element instanceof HTMLTextAreaElement
          || (element instanceof HTMLInputElement && !state.nonTextInputTypes.has(element.type))
          || (element instanceof HTMLElement && element.isContentEditable)
        Object.defineProperty(HTMLInputElement.prototype, "value", {
          ...state.inputValue,
          get() {
            return isRedactedControl(this) ? "" : state.inputValue.get.call(this)
          },
        })
        Object.defineProperty(HTMLTextAreaElement.prototype, "value", { ...state.textareaValue, get() { return "" } })
        Object.defineProperty(Node.prototype, "nodeValue", {
          ...state.nodeValue,
          get() {
            const parent = this.parentElement
            return parent && isRedactedControl(parent)
              ? ""
              : state.nodeValue.get.call(this)
          },
        })
        Object.defineProperty(Node.prototype, "textContent", {
          ...state.textContent,
          get() {
            const parent = this.parentElement
            return isRedactedControl(this) || (this.nodeType === Node.TEXT_NODE && parent && isRedactedControl(parent))
              ? ""
              : state.textContent.get.call(this)
          },
        })
        Object.defineProperty(HTMLElement.prototype, "innerText", {
          ...state.innerText,
          get() {
            return isRedactedControl(this) ? "" : state.innerText.get.call(this)
          },
        })
        Object.defineProperty(Element.prototype, "getAttribute", {
          ...state.getAttribute,
          value(name) {
            const rawAttribute = String(name)
            const attribute = state.valueAttributes.has(rawAttribute) ? rawAttribute : rawAttribute.toLowerCase()
            if (!state.valueAttributes.has(attribute)) return state.getAttribute.value.call(this, name)
            return isRedactedControl(this) ? null : state.getAttribute.value.call(this, name)
          },
        })
      }
      state.tokens.add(token)
    } else if (action === "off" && state) {
      state.tokens.delete(token)
      if (state.tokens.size === 0) {
        Object.defineProperty(HTMLInputElement.prototype, "value", state.inputValue)
        Object.defineProperty(HTMLTextAreaElement.prototype, "value", state.textareaValue)
        Object.defineProperty(Node.prototype, "nodeValue", state.nodeValue)
        Object.defineProperty(Node.prototype, "textContent", state.textContent)
        Object.defineProperty(HTMLElement.prototype, "innerText", state.innerText)
        Object.defineProperty(Element.prototype, "getAttribute", state.getAttribute)
        delete globalThis[stateKey]
      }
    }

    return root instanceof Element ? root : document.documentElement
  },
  queryAll(root, body) {
    return [this.query(root, body)]
  },
})`

let nextRedactionSelector = 0
let nextRedactionToken = 0
const contextSelectors = new WeakMap<BrowserContext, Promise<string>>()
const pageCleanup = new WeakMap<Page, {
  readonly pendingTokens: Set<string>
  queue: Promise<void>
}>()

export async function ariaSnapshotWithoutTextControlValues(
  locator: Locator,
  options: { readonly timeout: number },
): Promise<string> {
  const page = locator.page()
  const redactionSelectorName = await selectorForContext(page.context())
  const token = String(++nextRedactionToken)
  let snapshot: string | undefined
  let captureFailed = false
  let captureError: unknown
  try {
    snapshot = await locator
      .locator(`${redactionSelectorName}=on_${token}`)
      .ariaSnapshot(options)
  } catch (error) {
    captureFailed = true
    captureError = error
  }

  try {
    await cleanupRedaction(page, redactionSelectorName, token)
  } catch (cleanupError) {
    if (captureFailed) {
      const cleanupReasons = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
      throw new AggregateError([captureError, ...cleanupReasons], redactionCleanupErrorMessage)
    }
    throw cleanupError
  }

  if (captureFailed) throw captureError
  return snapshot!
}

export async function registerAriaSnapshotSelector(context: BrowserContext): Promise<void> {
  await selectorForContext(context)
}

async function selectorForContext(context: BrowserContext): Promise<string> {
  const existing = contextSelectors.get(context)
  if (existing) return existing

  const name = `bcariaredact${++nextRedactionSelector}`
  const registration = selectors.register(
    name,
    { content: redactionSelectorSource },
    { contentScript: true },
  ).then(() => name, (error) => {
    contextSelectors.delete(context)
    throw error
  })
  contextSelectors.set(context, registration)
  return registration
}

async function cleanupRedaction(page: Page, redactionSelectorName: string, token: string): Promise<void> {
  let state = pageCleanup.get(page)
  if (!state) {
    state = { pendingTokens: new Set(), queue: Promise.resolve() }
    pageCleanup.set(page, state)
  }
  state.pendingTokens.add(token)

  const cleanup = state.queue.then(async () => {
    const tokens = [...state.pendingTokens]
    const results = await Promise.allSettled(page.frames().flatMap((frame) => tokens.map(async (pendingToken) => {
      await frame.locator(`${redactionSelectorName}=off_${pendingToken}`).waitFor({ state: "attached", timeout: 1_000 })
    })))
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, redactionCleanupErrorMessage)
    for (const pendingToken of tokens) state.pendingTokens.delete(pendingToken)
  })
  state.queue = cleanup.catch(() => {})
  await cleanup
}
