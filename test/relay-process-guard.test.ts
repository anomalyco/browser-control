import { describe, expect, it, vi } from "vitest"
import { handleRelayProcessFault, shouldSuppressRelayProcessFault } from "../src/relay.ts"

describe("relay process fault guard", () => {
  it("suppresses Playwright duplicate-target dispatch errors", () => {
    const error = new Error("Duplicate target target-1")
    error.stack = "Error: Duplicate target target-1\n    at CRBrowser._onAttachedToTarget (node_modules/playwright-core/lib/server/chromium/crBrowser.js:1:1)"
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const rethrow = vi.fn((): never => {
      throw new Error("should not rethrow")
    })
    try {
      expect(shouldSuppressRelayProcessFault(error)).toBe(true)
      handleRelayProcessFault("uncaughtException", error, { origin: "uncaughtException" }, { rethrow })
      expect(rethrow).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it("preserves fatal behavior for unknown faults", () => {
    const error = new Error("ordinary application bug")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const rethrow = vi.fn((cause: unknown): never => {
      throw cause
    })
    try {
      expect(shouldSuppressRelayProcessFault(error)).toBe(false)
      expect(() => handleRelayProcessFault("unhandledRejection", error, {}, { rethrow })).toThrow(error)
      expect(rethrow).toHaveBeenCalledWith(error)
    } finally {
      consoleError.mockRestore()
    }
  })
})
