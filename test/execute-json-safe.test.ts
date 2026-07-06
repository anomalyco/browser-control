import { describe, expect, it } from "vitest"
import { extractExecuteMedia, toJsonSafeValue } from "../src/execute.ts"

describe("toJsonSafeValue", () => {
  it("keeps JSON primitives and plain nested values", () => {
    expect(toJsonSafeValue({ a: 1, b: "two", c: [true, null], nested: { ok: { deep: "yes" } } })).toEqual({
      serializable: true,
      value: { a: 1, b: "two", c: [true, null], nested: { ok: { deep: "yes" } } },
    })
  })

  it("converts bigints and non-finite numbers safely", () => {
    expect(toJsonSafeValue({
      id: 123n,
      bad: Number.NaN,
    })).toEqual({
      serializable: true,
      value: {
        id: "123",
        bad: null,
      },
    })
  })

  it("omits unsupported object properties and replaces unsupported array entries with null", () => {
    const converted = toJsonSafeValue({ keep: 1, drop: () => "nope", items: [undefined, Symbol("x"), 2] })
    expect(converted).toEqual({ serializable: true, value: { keep: 1, items: [null, null, 2] } })
  })

  it("fails gracefully for top-level unsupported values", () => {
    expect(toJsonSafeValue(undefined)).toEqual({ serializable: false, reason: "undefined" })
    expect(toJsonSafeValue(() => "nope")).toEqual({ serializable: false, reason: "function value" })
  })

  it("omits value for top-level class instances", () => {
    class FakePage {
      readonly url = "https://example.com"
      readonly internals = { noisy: true }
    }

    expect(toJsonSafeValue(new FakePage())).toEqual({ serializable: false, reason: "class instance" })
  })

  it("omits nested class instances from object branches and nulls them in array branches", () => {
    class FakeLocator {
      readonly selector = "button"
    }

    expect(toJsonSafeValue({ keep: "data", locator: new FakeLocator(), items: [1, new FakeLocator()] })).toEqual({
      serializable: true,
      value: { keep: "data", items: [1, null] },
    })
  })

  it("omits value for payloads above the 32KB JSON cap", () => {
    const converted = toJsonSafeValue({ text: "x".repeat(33 * 1024) })
    expect(converted.serializable).toBe(false)
    if (!converted.serializable) {
      expect(converted.reason).toContain("32768 bytes")
    }
  })

  it("omits throwing getter properties and keeps siblings", () => {
    const trap = {
      fine: 1,
      get boom() {
        throw new Error("getter throws")
      },
    }

    expect(toJsonSafeValue(trap)).toEqual({ serializable: true, value: { fine: 1 } })
  })

  it("omits value when proxy key enumeration throws", () => {
    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error("proxy trap")
      },
    })

    const converted = toJsonSafeValue(proxy)
    expect(converted.serializable).toBe(false)
    if (!converted.serializable) {
      expect(converted.reason).toBe("object keys unavailable")
    }
  })

  it("handles nested throwing getters inside objects and arrays", () => {
    const nested = {
      keep: "nested",
      get boom() {
        throw new Error("nested getter throws")
      },
    }

    expect(toJsonSafeValue({ outer: nested, list: [nested] })).toEqual({
      serializable: true,
      value: { outer: { keep: "nested" }, list: [{ keep: "nested" }] },
    })
  })

  it("converts string-keyed Maps to plain objects and Sets to arrays", () => {
    expect(toJsonSafeValue({ map: new Map<string, unknown>([["a", 1], ["b", { ok: true }]]), set: new Set(["x", 2]) })).toEqual({
      serializable: true,
      value: { map: { a: 1, b: { ok: true } }, set: ["x", 2] },
    })
  })

  it("omits Maps with non-string keys at that branch", () => {
    expect(toJsonSafeValue({ keep: true, map: new Map([[1, "nope"]]), list: [new Map([[1, "nope"]])] })).toEqual({
      serializable: true,
      value: { keep: true, list: [null] },
    })
    expect(toJsonSafeValue(new Map([[1, "nope"]]))).toEqual({ serializable: false, reason: "map contains non-string key" })
  })

  it("handles circular references without throwing", () => {
    const value: { name: string; self?: unknown } = { name: "loop" }
    value.self = value
    expect(toJsonSafeValue(value)).toEqual({ serializable: true, value: { name: "loop" } })
  })
})

describe("extractExecuteMedia", () => {
  const png = (suffix: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, suffix])

  it("extracts nested screenshot buffers and leaves compact metadata", () => {
    const before = png(1)
    const after = png(2)
    expect(extractExecuteMedia({ url: "https://example.com", images: [before, after] })).toEqual({
      value: {
        url: "https://example.com",
        images: [
          { type: "image", mimeType: "image/png", size: before.byteLength },
          { type: "image", mimeType: "image/png", size: after.byteLength },
        ],
      },
      media: [
        { type: "image", mimeType: "image/png", data: before.toString("base64"), size: before.byteLength },
        { type: "image", mimeType: "image/png", data: after.toString("base64"), size: after.byteLength },
      ],
    })
  })

  it("does not treat arbitrary buffers as images", () => {
    const value = Buffer.from("hello")
    expect(extractExecuteMedia(value)).toEqual({ value, media: [] })
  })

  it("extracts images from Map keys and values and from Sets", () => {
    const key = png(1)
    const value = png(2)
    const setValue = png(3)
    const extracted = extractExecuteMedia({ map: new Map([[key, value]]), set: new Set([setValue]) })
    expect(extracted.media.map((image) => image.data)).toEqual([
      key.toString("base64"),
      value.toString("base64"),
      setValue.toString("base64"),
    ])
  })
})
