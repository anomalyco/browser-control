import { fileURLToPath } from "node:url"
import fs from "node:fs/promises"

type McpServer = ReturnType<typeof mcpServerConfig>
type Skill = Awaited<ReturnType<typeof skillDefinition>>
type Context = {
  readonly mcp: {
    readonly transform: (edit: (mcp: { readonly set: (name: string, server: McpServer) => void }) => void) => Promise<unknown>
  }
  readonly skill: {
    readonly transform: (edit: (skills: { readonly add: (skill: Skill) => void }) => void) => Promise<unknown>
  }
}

export function mcpServerConfig(moduleUrl = import.meta.url) {
  return {
    type: "local" as const,
    command: ["node", fileURLToPath(new URL("./mcp.js", moduleUrl))],
  }
}

export function extensionDirectory(moduleUrl = import.meta.url) {
  return fileURLToPath(new URL("../extension/dist", moduleUrl))
}

export async function skillDefinition(moduleUrl = import.meta.url) {
  const location = fileURLToPath(new URL("../skills/browser-control/SKILL.md", moduleUrl))
  const source = await fs.readFile(location, "utf8")
  const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (!frontmatter) throw new Error(`Browser Control skill frontmatter is missing: ${location}`)
  return {
    id: "browser",
    name: "Browser",
    description: "Drive the user's existing Chromium-family browser with deterministic Playwright",
    autoinvoke: false,
    location,
    content: [
      source.slice(frontmatter[0].length).trim(),
      "## OpenCode package integration",
      "Use the `browser_control` MCP server registered by this plugin.",
      `If Browser Control reports that its extension is disconnected, ask the user to load the unpacked extension from ${extensionDirectory(moduleUrl)}.`,
    ].join("\n\n"),
  }
}

export default {
  id: "browser-control",
  async setup(ctx: Context) {
    const skill = await skillDefinition()
    await ctx.mcp.transform((mcp) => {
      mcp.set("browser_control", mcpServerConfig())
    })
    await ctx.skill.transform((skills) => {
      skills.add(skill)
    })
  },
}
