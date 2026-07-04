import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, "extension", "dist")

await fs.rm(dist, { recursive: true, force: true })
await fs.mkdir(dist, { recursive: true })
await build({
  entryPoints: [path.join(root, "extension", "src", "background.ts"), path.join(root, "extension", "src", "offscreen.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: dist,
})
await build({
  entryPoints: [path.join(root, "extension", "src", "content-script.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outdir: dist,
})
await fs.copyFile(path.join(root, "extension", "manifest.json"), path.join(dist, "manifest.json"))
await fs.copyFile(path.join(root, "extension", "src", "offscreen.html"), path.join(dist, "offscreen.html"))
