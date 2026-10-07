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

  it("intercepts Content-Disposition attachment downloads over CDP without prompting and supports suggestedFilename, path, and saveAs", async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const send = vi.fn(async (method: string) => {
      if (method === "Fetch.getResponseBody") {
        return {
          body: Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").toString("base64"),
          base64Encoded: true,
        }
      }
      return {}
    })
    const cdpSession = {
      on: (event: string, cb: (payload: unknown) => void) => {
        listeners.set(event, cb)
      },
      send,
      detach: vi.fn(async () => {}),
    }
    const page = {
      waitForEvent: vi.fn(),
      evaluate: vi.fn(async () => {}),
      url: () => "https://github.com/organizations/anomalyco/settings/apps/slack-app",
      context: () => ({
        newCDPSession: vi.fn(async () => cdpSession),
      }),
    } as unknown as Page

    installDownloadCapabilityGuard(page)
    const downloadPromise = page.waitForEvent("download", { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 10))

    listeners.get("Fetch.requestPaused")?.({
      requestId: "req-1",
      resourceType: "Document",
      request: { url: "https://github.com/organizations/anomalyco/settings/apps/slack-app/key" },
      responseStatusCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "application/x-pem-file" },
        { name: "Content-Disposition", value: 'attachment; filename="slack-app.2026-10-07.private-key.pem"' },
      ],
    })

    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe("slack-app.2026-10-07.private-key.pem")
    const savedPath = await download.path()
    expect(savedPath).toContain("slack-app.2026-10-07.private-key.pem")
    expect(send).toHaveBeenCalledWith("Fetch.fulfillRequest", {
      requestId: "req-1",
      responseCode: 204,
      responseHeaders: [],
    })
    await download.delete()
  })
})
