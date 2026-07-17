import { describe, expect, it, vi } from "vitest"
import type { BrowserContext, Page } from "playwright-core"
import { downloadCapabilityErrorMessage, installDownloadCapabilityGuard, installDownloadCapabilityGuards } from "../src/execute.ts"

describe("execute download capability", () => {
  it("fails download waits immediately without changing other page event waits", async () => {
    const waitForEvent = vi.fn(async (event: string) => event)
    const page = { waitForEvent } as unknown as Page

    installDownloadCapabilityGuard(page)
    installDownloadCapabilityGuard(page)

    await expect(page.waitForEvent("download", { timeout: 30_000 })).rejects.toThrow(downloadCapabilityErrorMessage)
    await expect(page.waitForEvent("popup")).resolves.toBe("popup")
    expect(waitForEvent).toHaveBeenCalledTimes(1)
  })

  it("guards existing and newly created pages in the session context", async () => {
    const existing = { waitForEvent: vi.fn() } as unknown as Page
    const created = { waitForEvent: vi.fn() } as unknown as Page
    let onPage: ((page: Page) => void) | undefined
    const context = {
      pages: () => [existing],
      on: (_event: "page", listener: (page: Page) => void) => {
        onPage = listener
      },
    } as unknown as BrowserContext

    installDownloadCapabilityGuards(context)
    installDownloadCapabilityGuards(context)
    onPage?.(created)

    await expect(existing.waitForEvent("download")).rejects.toThrow(downloadCapabilityErrorMessage)
    await expect(created.waitForEvent("download")).rejects.toThrow(downloadCapabilityErrorMessage)
  })
})
