import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"
import { build } from "esbuild"
import { Config, ConfigProvider, Effect, Schema } from "effect"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { values } = parseArgs({ options: { outdir: { type: "string" } } })
const requested = path.resolve(await Effect.runPromise(
  Config.string("outdir").pipe(Config.withDefault(path.join(root, "dist")))
    .parse(ConfigProvider.fromUnknown(values)),
))
const dist = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested))
if (dist !== path.join(root, "dist") && (dist === root || root.startsWith(`${dist}${path.sep}`) || dist.startsWith(`${root}${path.sep}`))) {
  throw new Error("Alternate build output must be outside the source checkout")
}

const packageJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
)
const buildId = new Date().toISOString()
const execFileAsync = promisify(execFile)

if (dist === path.join(root, "dist")) await fs.rm(dist, { recursive: true, force: true })
// A custom output is a fresh candidate, never permission to delete another tree.
await fs.mkdir(dist)
await Promise.all([
  build({
    entryPoints: {
      cli: path.join(root, "src", "cli.ts"),
      index: path.join(root, "src", "index.ts"),
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
  }),
  execFileAsync(path.join(root, "node_modules", ".bin", "tsc"), [
    "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(dist, "types"),
  ]),
])
await fs.chmod(path.join(dist, "cli.js"), 0o755)
await fs.chmod(path.join(dist, "mcp.js"), 0o755)
