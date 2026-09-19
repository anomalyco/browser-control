import { describe, expect, it, vi } from "vitest"
import type { Frame, Page } from "playwright-core"
import { createWebMcpHelper } from "../src/webmcp.ts"

function fakeFrame(url: string, tools: readonly Record<string, unknown>[], callResult: unknown = null): Frame {
  return {
    url: () => url,
    evaluate: vi.fn(async (_fn: unknown, argument?: unknown) => argument === undefined ? tools : callResult),
  } as unknown as Frame
}

describe("WebMCP execute helper", () => {
  it("discovers bounded page-provided tool metadata across frames", async () => {
    const main = fakeFrame("https://example.test/", [{
      name: "search",
      title: "Search",
      description: "Search the catalog",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      annotations: { readOnly: true, consequential: false, untrustedContent: false },
      origin: "https://example.test",
    }])
    const child = fakeFrame("https://widget.test/", [{
      name: "checkout",
      description: "Place the current order",
      annotations: { readOnly: false, consequential: true, untrustedContent: false },
    }])
    const page = { frames: () => [main, child] } as unknown as Page

    await expect(createWebMcpHelper(page).list()).resolves.toEqual({
      available: true,
      omitted: 0,
      tools: [
        expect.objectContaining({ name: "search", frame: "https://example.test/", annotations: { readOnly: true, consequential: false, untrustedContent: false } }),
        expect.objectContaining({ name: "checkout", frame: "https://widget.test/", annotations: { readOnly: false, consequential: true, untrustedContent: false } }),
      ],
    })
  })

  it("re-discovers and invokes the exact frame tool", async () => {
    const main = fakeFrame("https://example.test/", [{ name: "add", description: "Add numbers" }], { content: [{ type: "text", text: "42" }] })
    const helper = createWebMcpHelper({ frames: () => [main] } as unknown as Page)

    await expect(helper.call("add", { a: 2, b: 40 })).resolves.toEqual({ content: [{ type: "text", text: "42" }] })
    expect(main.evaluate).toHaveBeenCalledTimes(2)
    expect(vi.mocked(main.evaluate).mock.calls[1]?.[1]).toEqual({ name: "add", inputJson: '{"a":2,"b":40}' })
  })

  it("requires a frame when the same tool name is registered more than once", async () => {
    const first = fakeFrame("https://example.test/widget", [{ name: "submit", description: "First" }])
    const second = fakeFrame("https://example.test/widget", [{ name: "submit", description: "Second" }])
    const helper = createWebMcpHelper({ frames: () => [first, second] } as unknown as Page)

    await expect(helper.call("submit")).rejects.toThrow("registered in multiple frames")
    await expect(helper.call("submit", {}, { frame: "https://example.test/widget (frame 1)" })).resolves.toBeNull()
  })

  it("reports unavailable WebMCP without treating it as a page failure", async () => {
    const frame = {
      url: () => "https://example.test/",
      evaluate: vi.fn().mockResolvedValue(null),
    } as unknown as Frame
    const page = { frames: () => [frame] } as unknown as Page

    const helper = createWebMcpHelper(page)
    await expect(helper.list()).resolves.toEqual({ available: false, tools: [], omitted: 0 })
    await expect(helper.call("missing")).rejects.toThrow("does not register any WebMCP tools")
  })
})
