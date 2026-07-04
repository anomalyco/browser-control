import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, "dist")

const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { readonly version: string }
const buildId = new Date().toISOString()

await fs.rm(dist, { recursive: true, force: true })
await fs.mkdir(dist, { recursive: true })
await build({
  entryPoints: {
    cli: path.join(root, "src", "cli.ts"),
    mcp: path.join(root, "src", "mcp-main.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  define: {
    "globalThis.__BROWSER_CONTROL_VERSION__": JSON.stringify(packageJson.version),
    "globalThis.__BROWSER_CONTROL_BUILD_ID__": JSON.stringify(buildId),
  },
  outdir: dist,
})
await fs.chmod(path.join(dist, "cli.js"), 0o755)
await fs.chmod(path.join(dist, "mcp.js"), 0o755)
