import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { Frame, Page } from "playwright-core"
import { formatDemonstrationCode, startDemonstrationRecorder, type DemonstrationStep } from "../src/demonstration.ts"

class FakePage extends EventEmitter {
  href = "https://example.test/start"
  readonly frame = {
    url: () => this.href,
    evaluate: vi.fn().mockResolvedValue(undefined),
  } as unknown as Frame
  binding: ((source: unknown, value: unknown) => void) | undefined
  readonly exposeBinding = vi.fn(async (_name: string, callback: (source: unknown, value: unknown) => void) => {
    this.binding = callback
  })

  url() { return this.href }
  isClosed() { return false }
  frames() { return [this.frame] }
  mainFrame() { return this.frame }
}

describe("human demonstration recorder", () => {
  it("records, compacts edits, and returns reusable Playwright code", async () => {
    const page = new FakePage()
    const recorder = await startDemonstrationRecorder(page as unknown as Page)
    const send = (step: DemonstrationStep) => page.binding?.({}, step)
    send({ kind: "fill", selector: "#name", value: "K" })
    send({ kind: "fill", selector: "#name", value: "Kit" })
    send({ kind: "click", selector: "#save", role: "button", name: "Save" })
    page.href = "https://example.test/done"
    page.emit("framenavigated", page.frame)

    const result = await recorder.stop()

    expect(result.steps).toEqual([
      { kind: "fill", selector: "#name", value: "Kit" },
      { kind: "click", selector: "#save", role: "button", name: "Save" },
      { kind: "navigation", url: "https://example.test/done" },
    ])
    expect(result.code).toContain('await page.locator("#name").fill("Kit")')
    expect(result.code).toContain('await page.locator("#save").click() // button "Save"')
    expect(result.code).toContain("// Navigated to https://example.test/done")
    expect(page.listenerCount("framenavigated")).toBe(0)
    expect(page.frame.evaluate).toHaveBeenCalledTimes(3)
  })

  it("renders password input as a secret placeholder", () => {
    expect(formatDemonstrationCode({
      startedUrl: "https://example.test/login",
      steps: [{ kind: "fill", selector: "#password", value: "", redacted: true }],
    })).toContain('// Fill "#password" from an approved secret source.')
  })

  it("rejects concurrent recorders on the same page", async () => {
    const page = new FakePage()
    const first = await startDemonstrationRecorder(page as unknown as Page)
    await expect(startDemonstrationRecorder(page as unknown as Page)).rejects.toThrow("already being recorded")
    await first.stop()
  })
})
