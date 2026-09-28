import fs from "node:fs/promises"
import path from "node:path"

/**
 * Recreate the default checkout output, or create a fresh alternate output
 * outside the checkout. An alternate output is never permission to delete a tree.
 */
export async function prepareBuildOutput(root: string, defaultOutput: string, requested: string): Promise<string> {
  const resolved = path.resolve(requested)
  const output = path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved))
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
