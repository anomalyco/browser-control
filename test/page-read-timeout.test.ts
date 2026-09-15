import { afterEach, expect, it, vi } from "vitest"
import { installPageReadTimeout } from "../src/page-read-timeout.ts"

afterEach(() => vi.useRealTimers())

it("releases a hung title read and permits a later read without closing the page", async () => {
  vi.useFakeTimers()
  const page = { title: vi.fn<() => Promise<string>>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue("Recovered") }
  installPageReadTimeout(page, 100)
  const first = expect(page.title()).rejects.toThrow("page.title() timed out after 100ms")
  await vi.advanceTimersByTimeAsync(100)
  await first
  await expect(page.title()).resolves.toBe("Recovered")
  expect(vi.getTimerCount()).toBe(0)
})

it("preserves read errors and installs the bound only once", async () => {
  vi.useFakeTimers()
  const failure = new Error("Target closed")
  const page = { title: async () => { throw failure } }
  installPageReadTimeout(page, 100)
  const wrapped = page.title
  installPageReadTimeout(page, 200)
  expect(page.title).toBe(wrapped)
  await expect(page.title()).rejects.toBe(failure)
  expect(vi.getTimerCount()).toBe(0)
})
