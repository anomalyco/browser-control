import { selectors, type Locator } from "playwright-core"

const redactionSelectorName = "bcariaredact"
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
          inputValue: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
          textareaValue: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
          nodeValue: Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue"),
          textContent: Object.getOwnPropertyDescriptor(Node.prototype, "textContent"),
          innerText: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText"),
          getAttribute: Object.getOwnPropertyDescriptor(Element.prototype, "getAttribute"),
        }
        globalThis[stateKey] = state
        Object.defineProperty(HTMLInputElement.prototype, "value", {
          ...state.inputValue,
          get() {
            return state.nonTextInputTypes.has(this.type)
              ? state.inputValue.get.call(this)
              : ""
          },
        })
        Object.defineProperty(HTMLTextAreaElement.prototype, "value", { ...state.textareaValue, get() { return "" } })
        Object.defineProperty(Node.prototype, "nodeValue", {
          ...state.nodeValue,
          get() {
            const parent = this.parentElement
            return parent && (parent instanceof HTMLTextAreaElement || parent.isContentEditable)
              ? ""
              : state.nodeValue.get.call(this)
          },
        })
        Object.defineProperty(Node.prototype, "textContent", {
          ...state.textContent,
          get() {
            const parent = this.parentElement
            return this instanceof HTMLTextAreaElement
              || (this instanceof HTMLElement && this.isContentEditable)
              || (this.nodeType === Node.TEXT_NODE && parent?.isContentEditable)
              ? ""
              : state.textContent.get.call(this)
          },
        })
        Object.defineProperty(HTMLElement.prototype, "innerText", {
          ...state.innerText,
          get() {
            return this instanceof HTMLTextAreaElement || this.isContentEditable
              ? ""
              : state.innerText.get.call(this)
          },
        })
        Object.defineProperty(Element.prototype, "getAttribute", {
          ...state.getAttribute,
          value(name) {
            const attribute = String(name).toLowerCase()
            const sensitiveInput = this instanceof HTMLInputElement
              && !state.nonTextInputTypes.has(this.type)
            const sensitiveControl = sensitiveInput
              || this instanceof HTMLTextAreaElement
              || (this instanceof HTMLElement && this.isContentEditable)
            return sensitiveControl && ["aria-valuenow", "aria-valuetext", "value"].includes(attribute)
              ? null
              : state.getAttribute.value.call(this, name)
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

await selectors.register(
  redactionSelectorName,
  { content: redactionSelectorSource },
  { contentScript: true },
)

let nextRedactionToken = 0

export async function ariaSnapshotWithoutTextControlValues(
  locator: Locator,
  options: { readonly timeout: number },
): Promise<string> {
  const token = String(++nextRedactionToken)
  try {
    return await locator
      .locator(`${redactionSelectorName}=on_${token}`)
      .ariaSnapshot(options)
  } finally {
    const cleanup = await Promise.allSettled(locator.page().frames().map(async (frame) => {
      await frame.locator(`${redactionSelectorName}=off_${token}`).waitFor({ state: "attached", timeout: 1_000 })
    }))
    if (cleanup.some((result) => result.status === "rejected")) {
      throw new Error("Browser Control could not confirm ARIA snapshot value-redaction cleanup")
    }
  }
}
