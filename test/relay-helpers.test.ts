import { describe, expect, it } from "vitest"
import {
  generateSessionId,
  getTargetInfo,
  isRestrictedTarget,
  optionalSessionId,
  parseTargetSelection,
  validateBrowserFetchSite,
  validateHostHeader,
  validateWebSocketOrigin,
} from "../src/relay-helpers.ts"
import type { BrowserControlSession } from "../src/relay-types.ts"
import type { TargetInfo } from "../src/protocol.ts"

describe("validateHostHeader", () => {
  const base = { host: "127.0.0.1", port: 19989 }

  it("accepts local hosts with the right port", () => {
    expect(validateHostHeader({ hostHeader: "127.0.0.1:19989", ...base })).toBeUndefined()
    expect(validateHostHeader({ hostHeader: "localhost:19989", ...base })).toBeUndefined()
    expect(validateHostHeader({ hostHeader: "[::1]:19989", ...base })).toBeUndefined()
    expect(validateHostHeader({ hostHeader: "localhost", ...base })).toBeUndefined()
  })

  it("rejects DNS-rebinding style hosts", () => {
    expect(validateHostHeader({ hostHeader: "evil.example.com:19989", ...base })).toBeDefined()
    expect(validateHostHeader({ hostHeader: "127.0.0.1.evil.example:19989", ...base })).toBeDefined()
  })

  it("rejects wrong ports and malformed headers", () => {
    expect(validateHostHeader({ hostHeader: "127.0.0.1:9999", ...base })).toBeDefined()
    expect(validateHostHeader({ hostHeader: undefined, ...base })).toBeDefined()
    expect(validateHostHeader({ hostHeader: "[::1", ...base })).toBeDefined()
    expect(validateHostHeader({ hostHeader: "127.0.0.1:0x50", ...base })).toBeDefined()
  })
})

describe("validateBrowserFetchSite", () => {
  it("allows same-origin, none, and non-browser requests", () => {
    expect(validateBrowserFetchSite({ headers: {} } as never)).toBeUndefined()
    expect(validateBrowserFetchSite({ headers: { "sec-fetch-site": "same-origin" } } as never)).toBeUndefined()
    expect(validateBrowserFetchSite({ headers: { "sec-fetch-site": "none" } } as never)).toBeUndefined()
  })

  it("rejects cross-site browser requests", () => {
    expect(validateBrowserFetchSite({ headers: { "sec-fetch-site": "cross-site" } } as never)).toBeDefined()
  })
})

describe("validateWebSocketOrigin", () => {
  it("accepts extension origins and missing origins", () => {
    expect(validateWebSocketOrigin({ origin: "chrome-extension://abc" })).toBeUndefined()
    expect(validateWebSocketOrigin({ origin: undefined })).toBeUndefined()
  })

  it("rejects web origins for the extension endpoint", () => {
    expect(validateWebSocketOrigin({ origin: "https://example.com", requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: "https://example.com" })).toBeDefined()
  })
})

describe("optionalSessionId", () => {
  it("accepts lowercase ids", () => {
    expect(optionalSessionId("rapid-otter-633")).toBe("rapid-otter-633")
    expect(optionalSessionId("  padded  ")).toBe("padded")
  })

  it("returns undefined for empty values", () => {
    expect(optionalSessionId(undefined)).toBeUndefined()
    expect(optionalSessionId("   ")).toBeUndefined()
  })

  it("rejects invalid ids", () => {
    expect(() => optionalSessionId("Upper")).toThrow()
    expect(() => optionalSessionId("-leading-dash")).toThrow()
    expect(() => optionalSessionId("a".repeat(64))).toThrow()
  })
})

describe("parseTargetSelection", () => {
  it("parses url and index selectors", () => {
    expect(parseTargetSelection({ urlIncludes: "example" })).toEqual({ urlIncludes: "example" })
    expect(parseTargetSelection({ index: 2 })).toEqual({ index: 2 })
    expect(parseTargetSelection(undefined)).toBeUndefined()
  })

  it("rejects combined and invalid selectors", () => {
    expect(() => parseTargetSelection({ urlIncludes: "a", index: 1 })).toThrow()
    expect(() => parseTargetSelection({ index: -1 })).toThrow()
    expect(() => parseTargetSelection({ index: 1.5 })).toThrow()
    expect(() => parseTargetSelection({ index: "1" })).toThrow()
    expect(() => parseTargetSelection("nope")).toThrow()
  })
})

describe("generateSessionId", () => {
  it("generates readable unique ids", () => {
    const existing = new Map<string, BrowserControlSession>()
    const id = generateSessionId(existing)
    expect(id).toMatch(/^[a-z]+-[a-z]+-\d{3}$/)
  })
})

describe("isRestrictedTarget", () => {
  const target = (overrides: Partial<TargetInfo>): TargetInfo => ({
    targetId: "T1",
    type: "page",
    title: "t",
    url: "https://example.com",
    attached: true,
    canAccessOpener: false,
    ...overrides,
  })

  it("allows normal pages, iframes, and dedicated workers", () => {
    expect(isRestrictedTarget(target({}))).toBe(false)
    expect(isRestrictedTarget(target({ type: "iframe" }))).toBe(false)
    expect(isRestrictedTarget(target({ type: "worker" }))).toBe(false)
    expect(isRestrictedTarget(target({ url: "" }))).toBe(false)
  })

  it("parses dedicated workers but leaves service workers unsupported", () => {
    expect(getTargetInfo({ ...target({}), type: "worker" })?.type).toBe("worker")
    expect(getTargetInfo({ ...target({}), type: "service_worker" })).toBeUndefined()
  })

  it("blocks browser-internal targets", () => {
    expect(isRestrictedTarget(target({ url: "chrome://settings" }))).toBe(true)
    expect(isRestrictedTarget(target({ url: "chrome-extension://abc/page.html" }))).toBe(true)
    expect(isRestrictedTarget(target({ url: "brave://rewards" }))).toBe(true)
  })
})
