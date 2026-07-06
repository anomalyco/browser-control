import { describe, expect, it } from "vitest"
import { toolResultForValue } from "../src/mcp.ts"

describe("MCP tool results", () => {
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
