import { Effect } from "effect"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { prepareRuntime, selectRuntime } from "../scripts/runtime-install.ts"

const exec = promisify(execFile)
const packageName = "@opencode-ai/browser-control"
const marker = ".browser-control-runtime.json"
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-runtime-")))
  temporary.push(directory)
  const source = path.join(directory, "checkout")
  const staging = path.join(directory, "staging")
  const install = path.join(directory, "install")
  const active = path.join(directory, "active")
  for (const relative of ["src", "scripts", "extension/src", "extension/icons", "extension/dist", "dist", "node_modules", "skills/browser-control"]) {
    await fs.mkdir(path.join(source, relative), { recursive: true })
  }
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: packageName, version: "1.2.3", packageManager: "pnpm@11.20.0", type: "module", exports: "./dist/index.js" }))
  for (const relative of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.build.json", "extension/manifest.json", "README.md", "LICENSE"]) {
    await fs.writeFile(path.join(source, relative), "fixture")
  }
  await fs.writeFile(path.join(source, "src/untracked.ts"), "untracked source is included")
  await fs.writeFile(path.join(source, "skills/browser-control/SKILL.md"), "# Browser Control\nFixture skill\n")
  for (const relative of ["dist", "node_modules", "extension/dist"]) await fs.writeFile(path.join(source, relative, "untouched"), "live")

  // Fake only expensive build/package-manager/compiler steps. Installed binaries,
  // SDK resolution, MCP protocol, filesystem isolation and selection run for real.
  // The strict pnpm consumer runs against a real tarball in CI's runtime:prepare.
  const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Effect.tryPromise(async () => {
    if (path.basename(cwd).startsWith(".browser-control-pnpm-")) {
      expect(path.dirname(cwd)).toBe(directory)
      expect(env).toEqual({
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: cwd,
        XDG_CONFIG_HOME: path.join(cwd, "config"), XDG_DATA_HOME: path.join(cwd, "data"),
        XDG_CACHE_HOME: path.join(cwd, "cache"), XDG_STATE_HOME: path.join(cwd, "state"),
      })
      expect(await fs.readFile(path.join(cwd, "package.json"), "utf8")).toBe(JSON.stringify({ private: true, type: "module", packageManager: "pnpm@11.20.0" }))
      if (command === "pnpm") {
        expect(args).toEqual(["add", "--workspace-root", "--prod", "--ignore-scripts", "--config.node-linker=isolated", path.join(staging, "artifacts/package.tgz")])
        await expect(fs.lstat(path.join(cwd, "pnpm-lock.yaml"))).rejects.toMatchObject({ code: "ENOENT" })
      }
      return args[0] === "--version" ? "browser-control v1.2.3" : args[0] === "--help" ? "browser-control help" : ""
    }
    if (command === "pnpm") {
      expect(cwd).toBe(staging)
      if (args[0] === "install") {
        expect(args).toEqual(["install", "--frozen-lockfile"])
        expect(await fs.readFile(path.join(staging, "src/untracked.ts"), "utf8")).toBe("untracked source is included")
        for (const relative of ["dist", "node_modules", "extension/dist"]) {
          await expect(fs.lstat(path.join(staging, relative))).rejects.toMatchObject({ code: "ENOENT" })
        }
      }
      return ""
    }
    if (command === "npm" && args[0] === "pack") {
      expect(args).toContain("--ignore-scripts")
      await fs.writeFile(path.join(staging, "artifacts/package.tgz"), "fake tarball")
      return "package.tgz\n"
    }
    if (command === "npm" && args[0] === "install") {
      expect(args).toContain("--ignore-scripts")
      expect(cwd).toBe(install)
      const pkg = path.join(install, "node_modules", packageName)
      await fs.mkdir(path.join(pkg, "dist"), { recursive: true })
      await fs.copyFile(path.join(staging, "package.json"), path.join(pkg, "package.json"))
      await fs.cp(path.join(staging, "skills"), path.join(pkg, "skills"), { recursive: true })
      await fs.writeFile(path.join(pkg, "dist/index.js"), "export const BrowserControlClient = { Service: {} }; export const AuthenticatedOrigin = { reveal() {} }; export const SecretProfile = { run() {}, Error: class extends Error {} };\n")
      await fs.writeFile(path.join(pkg, "dist/cli.js"), `#!/usr/bin/env node
import fs from 'node:fs';
const argument = process.argv[2];
console.log(argument === '--version' ? 'browser-control v1.2.3' : argument === 'skill' ? fs.readFileSync(new URL('../skills/browser-control/SKILL.md', import.meta.url), 'utf8').trim() : 'browser-control help');
`)
      await fs.writeFile(path.join(pkg, "dist/mcp.js"), `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
await fetch('http://127.0.0.1:' + process.env.BROWSER_CONTROL_PORT + '/version');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.id) continue;
  console.log(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  const result = request.method === 'initialize' ? { serverInfo: { name: 'browser-control', version: '1.2.3' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'execute' }, { name: 'skill' }] }
    : { content: [{ type: 'text', text: fs.readFileSync(new URL('../skills/browser-control/SKILL.md', import.meta.url), 'utf8') }] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
`)
      await fs.mkdir(path.join(install, "node_modules/.bin"))
      for (const [bin, file] of Object.entries({ "browser-control": "cli.js", "browser-control-mcp": "mcp.js" })) {
        await fs.chmod(path.join(pkg, "dist", file), 0o755)
        await fs.symlink(`../${packageName}/dist/${file}`, path.join(install, "node_modules/.bin", bin))
      }
      return ""
    }
    if (command.endsWith("/.bin/tsc")) return ""
    return (await exec(command, args, { cwd, timeout: 10_000 })).stdout
  }).pipe(Effect.mapError((cause) => new Error("Fixture command failed", { cause })))
  return { directory, source, staging, install, active, run }
}

describe("isolated runtime installation", () => {
  it("leaves the active pointer and checkout untouched when prepare fails", async () => {
    const f = await fixture()
    const previous = path.join(f.directory, "previous")
    await fs.mkdir(previous)
    await fs.symlink(previous, f.active)
    await expect(Effect.runPromise(prepareRuntime(f, () => Effect.fail(new Error("install failed"))))).rejects.toThrow("install failed")
    expect(await fs.realpath(f.active)).toBe(previous)
    await expect(fs.lstat(path.join(f.install, marker))).rejects.toMatchObject({ code: "ENOENT" })
    for (const relative of ["dist", "node_modules", "extension/dist"]) {
      expect(await fs.readFile(path.join(f.source, relative, "untouched"), "utf8")).toBe("live")
    }
  })

  it("selects both bins together from a validated standalone copy and retains the previous install", async () => {
    const f = await fixture()
    await Effect.runPromise(prepareRuntime(f, f.run))
    const previous = path.join(f.directory, "previous")
    await fs.mkdir(previous)
    await fs.writeFile(path.join(previous, "retained"), "old runtime")
    await fs.symlink(previous, f.active)
    expect(await fs.realpath(f.active)).toBe(previous)
    await Effect.runPromise(selectRuntime(f))
    for (const [bin, file] of Object.entries({ "browser-control": "cli.js", "browser-control-mcp": "mcp.js" })) {
      expect(await fs.realpath(path.join(f.active, "bin", bin))).toBe(path.join(f.install, "node_modules", packageName, "dist", file))
    }
    expect(await fs.readFile(path.join(previous, "retained"), "utf8")).toBe("old runtime")
    await fs.rm(f.source, { recursive: true })
    await fs.rm(f.staging, { recursive: true })
    expect((await exec(path.join(f.active, "bin/browser-control"), ["--version"])).stdout.trim()).toBe("browser-control v1.2.3")
    await Effect.runPromise(selectRuntime(f))
  })

  it("refuses missing or modified candidates without touching the active pointer", async () => {
    const f = await fixture()
    await fs.symlink(f.source, f.active)
    await expect(Effect.runPromise(selectRuntime(f))).rejects.toThrow()
    expect(await fs.realpath(f.active)).toBe(f.source)
    await Effect.runPromise(prepareRuntime(f, f.run))
    await fs.appendFile(path.join(f.install, "node_modules", packageName, "dist/cli.js"), "// changed\n")
    await expect(Effect.runPromise(selectRuntime(f))).rejects.toThrow("changed since validation")
    expect(await fs.realpath(f.active)).toBe(f.source)
  })

  it("refuses plain active paths and existing prepare destinations", async () => {
    const f = await fixture()
    await Effect.runPromise(prepareRuntime(f, f.run))
    await fs.writeFile(f.active, "unrelated file")
    await expect(Effect.runPromise(selectRuntime(f))).rejects.toThrow("non-symlink")
    expect(await fs.readFile(f.active, "utf8")).toBe("unrelated file")
    await fs.unlink(f.active)
    await fs.mkdir(f.active)
    await expect(Effect.runPromise(selectRuntime(f))).rejects.toThrow("non-symlink")
    expect((await fs.lstat(f.active)).isDirectory()).toBe(true)
    await expect(Effect.runPromise(prepareRuntime(f, f.run))).rejects.toThrow("overwrite existing path")
  })

  it("rejects prepare inside the checkout and linked source inputs", async () => {
    const f = await fixture()
    await expect(Effect.runPromise(prepareRuntime({ ...f, staging: path.join(f.source, "stage") }, f.run))).rejects.toThrow("non-overlapping")
    await fs.symlink(path.join(f.source, "README.md"), path.join(f.source, "src/linked.ts"))
    await expect(Effect.runPromise(prepareRuntime(f, f.run))).rejects.toThrow("must not be a symlink")
  })

  it("does not stamp a candidate whose final installed validation fails", async () => {
    const f = await fixture()
    await expect(Effect.runPromise(prepareRuntime(f, (command, args, cwd, env) => args[0] === "--version" && !env
      ? Effect.succeed("wrong-version")
      : f.run(command, args, cwd, env)))).rejects.toThrow("CLI version mismatch")
    await expect(fs.lstat(path.join(f.install, marker))).rejects.toMatchObject({ code: "ENOENT" })
    await fs.symlink(f.source, f.active)
    await expect(Effect.runPromise(selectRuntime(f))).rejects.toThrow()
    expect(await fs.realpath(f.active)).toBe(f.source)
  })

  it("cleans the strict packed consumer and leaves the candidate unvalidated when its check fails", async () => {
    const f = await fixture()
    await expect(Effect.runPromise(prepareRuntime(f, (command, args, cwd, env) => command === "node" && env
      ? Effect.fail(new Error("packed Effect cohort mismatch"))
      : f.run(command, args, cwd, env)))).rejects.toThrow("packed Effect cohort mismatch")
    expect((await fs.readdir(f.directory)).some((name) => name.startsWith(".browser-control-pnpm-"))).toBe(false)
    await expect(fs.lstat(path.join(f.install, marker))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
