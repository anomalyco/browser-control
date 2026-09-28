import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function resolveOutput(requested: string): Promise<string> {
  const resolved = path.resolve(requested)
  return path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved))
}

/**
 * Recreate the default checkout output, or create a fresh alternate output
 * outside the checkout. An alternate output is never permission to delete a tree.
 */
export async function prepareBuildOutput(root: string, defaultOutput: string, requested: string): Promise<string> {
  const output = await resolveOutput(requested)
  if (output === defaultOutput) {
    await fs.rm(output, { recursive: true, force: true })
    await fs.mkdir(output, { recursive: true })
    return output
  }
  if (output === root || root.startsWith(`${output}${path.sep}`) || output.startsWith(`${root}${path.sep}`)) {
    throw new Error("Alternate build output must be a fresh directory outside the source checkout")
  }
  await fs.mkdir(output)
  return output
}

/**
 * Build into a staging directory, then replace the default checkout output file
 * by file. The directory stays in place for a browser that loads it unpacked,
 * and a failed build leaves the previous output intact. Alternate outputs keep
 * the fresh-directory rules of `prepareBuildOutput`.
 */
export async function buildIntoOutput(
  root: string,
  defaultOutput: string,
  requested: string,
  write: (directory: string) => Promise<void>,
): Promise<string> {
  if (await resolveOutput(requested) !== defaultOutput) {
    const output = await prepareBuildOutput(root, defaultOutput, requested)
    await write(output)
    return output
  }
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-build-"))
  try {
    await write(staging)
    await fs.mkdir(defaultOutput, { recursive: true })
    await replaceDirectoryContents(staging, defaultOutput)
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
  return defaultOutput
}

async function replaceDirectoryContents(source: string, destination: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    const existing = await fs.lstat(to).catch(() => undefined)
    if (existing && existing.isDirectory() !== entry.isDirectory()) {
      await fs.rm(to, { recursive: true, force: true })
    }
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true })
      await replaceDirectoryContents(from, to)
      continue
    }
    const temporary = path.join(destination, `.${entry.name}.${process.pid}.tmp`)
    await fs.copyFile(from, temporary)
    await fs.rename(temporary, to)
  }
  const staged = new Set(entries.map((entry) => entry.name))
  for (const name of await fs.readdir(destination)) {
    if (!staged.has(name)) await fs.rm(path.join(destination, name), { recursive: true, force: true })
  }
}
