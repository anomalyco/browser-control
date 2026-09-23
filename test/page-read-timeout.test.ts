import { afterEach, expect, it, vi } from "vitest"
import { installPageReadTimeout, PageReadTimeoutError } from "../src/page-read-timeout.ts"

afterEach(() => vi.useRealTimers())

it("releases a hung title read and permits a later read without closing the page", async () => {
  vi.useFakeTimers()
  const page = { title: vi.fn<() => Promise<string>>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue("Recovered") }
  installPageReadTimeout(page, 100)
  const first = page.title().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await first).toMatchObject({
    name: "PageReadTimeoutError", operation: "page.title", timeoutMs: 100,
    message: "page.title() timed out after 100ms: the page execution-context read did not complete; the context may be unavailable or busy.",
  })
  await expect(page.title()).resolves.toBe("Recovered")
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["resolve", "reject"] as const)("handles late %s after the watchdog and permits a successful read", async (outcome) => {
  vi.useFakeTimers()
  let resolve!: (value: string) => void
  let reject!: (cause: Error) => void
  const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  const page = { title: vi.fn<() => Promise<string>>().mockReturnValueOnce(pending).mockResolvedValue("Recovered") }
  installPageReadTimeout(page, 100)
  const failure = page.title().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await failure).toBeInstanceOf(PageReadTimeoutError)
  if (outcome === "resolve") resolve("Late")
  else reject(new Error("Late rejection"))
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
