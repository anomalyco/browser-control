import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { build } from "esbuild"
import { prepareBuildOutput } from "./build-output.ts"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { values } = parseArgs({ options: { outdir: { type: "string" } } })
const defaultOutput = path.join(root, "extension", "dist")
const dist = await prepareBuildOutput(root, defaultOutput, values.outdir ?? defaultOutput)
await Promise.all([
  build({
    entryPoints: [
      path.join(root, "extension", "src", "background.ts"),
      path.join(root, "extension", "src", "offscreen.ts"),
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    outdir: dist,
  }),
  build({
    entryPoints: [path.join(root, "extension", "src", "content-script.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    outdir: dist,
  }),
])
await fs.copyFile(path.join(root, "extension", "manifest.json"), path.join(dist, "manifest.json"))
await fs.copyFile(path.join(root, "extension", "src", "offscreen.html"), path.join(dist, "offscreen.html"))
await fs.mkdir(path.join(dist, "icons"), { recursive: true })
await Promise.all([16, 32, 48, 128].map((size) => {
  return fs.copyFile(
    path.join(root, "extension", "icons", `icon-${size}.png`),
    path.join(dist, "icons", `icon-${size}.png`),
  )
}))
