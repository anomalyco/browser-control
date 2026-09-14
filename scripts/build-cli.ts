import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"
import { build } from "esbuild"
import { Config, ConfigProvider, Effect, Schema } from "effect"
import { prepareBuildOutput } from "./build-output.ts"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { values } = parseArgs({ options: { outdir: { type: "string" } } })
const defaultOutput = path.join(root, "dist")
const dist = await prepareBuildOutput(root, defaultOutput, await Effect.runPromise(
  Config.String("outdir").pipe(Config.withDefault(defaultOutput))
    .parse(ConfigProvider.fromUnknown(values)),
))

const packageJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
)
const buildId = new Date().toISOString()
const execFileAsync = promisify(execFile)

await Promise.all([
  build({
    entryPoints: {
      cli: path.join(root, "src", "cli.ts"),
      index: path.join(root, "src", "index.ts"),
      mcp: path.join(root, "src", "mcp-main.ts"),
      opencode: path.join(root, "src", "opencode.ts"),
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
