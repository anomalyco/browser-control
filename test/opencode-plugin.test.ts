import { describe, expect, it } from "vitest"
import plugin, { extensionDirectory, mcpServerConfig, skillDefinition } from "../src/opencode.ts"

describe("OpenCode plugin", () => {
  it("exports the Browser Control plugin", () => {
    expect(plugin.id).toBe("browser-control")
  })

  it("runs the MCP entrypoint adjacent to the installed plugin bundle", () => {
    const moduleUrl = "file:///opt/node_modules/@opencode-ai/browser-control/dist/opencode.js"
    expect(mcpServerConfig(moduleUrl)).toEqual({
      type: "local",
      command: ["node", "/opt/node_modules/@opencode-ai/browser-control/dist/mcp.js"],
    })
    expect(extensionDirectory(moduleUrl)).toBe(
      "/opt/node_modules/@opencode-ai/browser-control/extension/dist",
    )
  })

  it("registers the packaged workflow as an explicit OpenCode skill", async () => {
    const skill = await skillDefinition()
    expect(skill).toMatchObject({
      id: "browser",
      name: "Browser",
      autoinvoke: false,
    })
    expect(skill.location).toMatch(/skills\/browser-control\/SKILL\.md$/)
    expect(skill.content).toContain("# Browser Control")
    expect(skill.content).not.toMatch(/^---/)
    expect(skill.content).toContain("Use the `browser_control` MCP server")
  })

  it("registers both capabilities during setup", async () => {
    const mcp: unknown[] = []
    const skills: unknown[] = []
    await plugin.setup({
      mcp: {
        transform: async (edit) => edit({ set: (name, server) => mcp.push({ name, server }) }),
      },
      skill: {
        transform: async (edit) => edit({ add: (skill) => skills.push(skill) }),
      },
    })

    expect(mcp).toEqual([{ name: "browser_control", server: mcpServerConfig() }])
    expect(skills).toEqual([await skillDefinition()])
  })
})
