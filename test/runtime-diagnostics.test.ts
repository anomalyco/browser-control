import { describe, expect, it } from "vitest"
import { PageReadTimeoutError } from "../src/page-read-timeout.ts"
import {
  boundedToken,
  executionContextFailureDiagnostic,
  runtimeFailureKind,
  summarizeDiagnosticUrl,
  summarizeRuntimeEvaluate,
} from "../src/runtime-diagnostics.ts"

describe("runtime diagnostics", () => {
  it("names only the bounded context-read timeout through wrapped causes", () => {
    for (const operation of ["page.title", "page.content"] as const) {
      const error = new PageReadTimeoutError(100, operation)
      for (const cause of [error, new Error(error.message, { cause: error })]) {
        expect(runtimeFailureKind(cause)).toBe("timeout")
        expect(executionContextFailureDiagnostic(cause, undefined)).toBe(
          `session-page/context-read-timeout; operation=${operation}; timeoutMs=100`,
        )
      }
    }
  })

  it.each([
    "locator.click: Timeout 100ms exceeded.\nCall log:\n  - waiting for locator('#missing')",
    "page.title() timed out after 100ms waiting for the page execution context",
    "page.title() timed out after 100ms: the page execution-context read did not complete; the context may be unavailable or busy.",
  ])("does not infer a context-read diagnostic from generic timeout text: %s", (message) => {
    expect(runtimeFailureKind(new Error(message))).toBe("timeout")
    expect(executionContextFailureDiagnostic(new Error(message), undefined)).toBeUndefined()
  })

  it("classifies execution-context failures through wrapped causes", () => {
    const error = new Error("evaluate failed", {
      cause: new Error("Execution context was destroyed, most likely because of a navigation"),
    })
    expect(runtimeFailureKind(error)).toBe("context-destroyed")
    expect(executionContextFailureDiagnostic(error, {
      startUrl: "https://example.test/start",
      endUrl: "https://example.test/final",
      navigations: ["https://example.test/final"],
      consoleErrorCount: 0,
      pageErrorCount: 0,
      handoffs: 0,
    })).toBe("execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1")
    expect(runtimeFailureKind(new Error("Frame was detached"))).toBe("context-missing")
  })

  it("classifies cross-extension navigation failures", () => {
    expect(runtimeFailureKind(new Error("Protocol error (Page.navigate): Cannot access a chrome-extension:// URL of different extension"))).toBe("cross-extension-page")
    expect(executionContextFailureDiagnostic(
      new Error("Protocol error (Page.navigate): Cannot access a chrome-extension:// URL of different extension"),
      undefined,
    )).toBe("target/cross-extension-page")
  })

  it("does not attach diagnostics to unrelated failures", () => {
    expect(executionContextFailureDiagnostic(new Error("selector did not match"), undefined)).toBeUndefined()
  })

  it("summarizes URLs without paths, credentials, query values, or fragments", () => {
    const summary = summarizeDiagnosticUrl("https://user:password@example.test/private/token?secret=value#account")
    expect(summary).toContain("origin=https://example.test")
    expect(summary).toContain("pathSegments=2")
    expect(summary).toContain("query=yes")
    expect(summary).toContain("fragment=yes")
    expect(summary).not.toMatch(/user|password|private|token|secret|value|account/)
  })

  it("summarizes evaluate shape without its expression or values", () => {
    const summary = summarizeRuntimeEvaluate({
      expression: "document.querySelector('#password').value",
      contextId: 17,
      awaitPromise: true,
      returnByValue: true,
    })
    expect(summary).toBe("sourceChars=41 argumentCount=0 context=17 awaitPromise=true returnByValue=true userGesture=false")
    expect(summary).not.toMatch(/document|password|querySelector/)
  })

  it("counts call-function arguments without retaining their values", () => {
    const summary = summarizeRuntimeEvaluate({
      functionDeclaration: "value => value",
      executionContextId: 19,
      arguments: [{ value: "private form value" }, { objectId: "opaque-object" }],
    })
    expect(summary).toBe("sourceChars=14 argumentCount=2 context=19 awaitPromise=false returnByValue=false userGesture=false")
    expect(summary).not.toMatch(/private|form|opaque|object/)
  })

  it("bounds opaque identifiers", () => {
    const bounded = boundedToken("a".repeat(200))
    expect(bounded.length).toBeLessThanOrEqual(48)
    expect(bounded).toMatch(/~[a-f0-9]{8}$/)
  })
})
