import { describe, expect, it } from "vitest"
import { mcpErrorMessage, toolResultForValue } from "../src/mcp.ts"

describe("MCP tool results", () => {
  it("marks execute script failures as failed MCP tool calls", () => {
    const result = toolResultForValue({
      text: "locator.click: Timeout 30000ms exceeded",
      isError: true,
      logs: [],
      session: { id: "mcp-test" },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "locator.click: Timeout 30000ms exceeded",
    })
    expect(result.structuredContent).toMatchObject({ isError: true })
  })

  it("omits structured content for primitive tool results", () => {
    const result = toolResultForValue("# Browser Control\n\nSkill instructions")

    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ type: "text", text: "# Browser Control\n\nSkill instructions" })
    expect(result.structuredContent).toBeUndefined()
  })

  it("adds session recovery guidance at the MCP boundary", () => {
    expect(mcpErrorMessage("execute", "Session not found: stale")).toContain("omit the explicit session id")
    expect(mcpErrorMessage("session_use", "Session not found: stale")).toContain("Create it with session_new first")
    expect(mcpErrorMessage("execute", "Extension disconnected")).toBe("Extension disconnected")
  })

  it("attaches explicit execute images without duplicating base64 in metadata", () => {
    const result = toolResultForValue({
      text: "Image (image/png, 4 bytes)",
      media: [
        { type: "image", mimeType: "image/png", data: Buffer.from([1, 2]).toString("base64"), size: 2 },
        { type: "image", mimeType: "image/png", data: Buffer.from([3, 4]).toString("base64"), size: 2 },
      ],
      isError: false,
      logs: [],
      session: { id: "mcp-test" },
    })

    expect(result.content).toHaveLength(3)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(Array.from(result.content[1]?.type === "image" ? result.content[1].data : [])).toEqual([1, 2])
    expect(Array.from(result.content[2]?.type === "image" ? result.content[2].data : [])).toEqual([3, 4])
    expect(result.structuredContent).not.toHaveProperty("media")
  })
})
