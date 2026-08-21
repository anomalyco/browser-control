import { createHash, createPublicKey } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { zipSync, type Zippable } from "fflate"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const storePackageFiles = [
  "background.js",
  "content-script.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "offscreen.html",
  "offscreen.js",
] as const

export async function makeExtensionArchive(dist: string): Promise<Uint8Array> {
  const entries: Zippable = {}
  for (const relativePath of await listFiles(dist)) {
    if (relativePath.endsWith(".map")) {
      throw new Error(`Chrome Web Store package must not contain source maps: ${relativePath}`)
    }
    const contents = new Uint8Array(await fs.readFile(path.join(dist, relativePath)))
    entries[relativePath] = [
      relativePath === "manifest.json" ? storeManifest(contents) : contents,
      { mtime: new Date(2000, 0, 1), os: 3, attrs: 0o644 << 16 },
    ]
  }
  return zipSync(entries, { level: 9, mtime: new Date(2000, 0, 1), os: 3 })
}

function storeManifest(contents: Uint8Array): Uint8Array {
  const manifest = parseManifest(new TextDecoder().decode(contents))
  Reflect.deleteProperty(manifest, "key")
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
}

export async function extensionVersion(dist: string): Promise<string> {
  return manifestVersion(await readManifest(dist))
}

function manifestVersion(manifest: Record<string, unknown>): string {
  const version = manifest.version
  if (typeof version !== "string" || !isChromeExtensionVersion(version)) {
    throw new Error("Extension manifest has an invalid Chrome version")
  }
  return version
}

async function readManifest(dist: string): Promise<Record<string, unknown>> {
  return parseManifest(await fs.readFile(path.join(dist, "manifest.json"), "utf8"))
}

function parseManifest(contents: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(contents)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extension manifest must be an object")
  }
  return parsed as Record<string, unknown>
}

export function isChromeExtensionVersion(version: string): boolean {
  const components = version.split(".")
  return components.length >= 1 && components.length <= 4 && components.every((component) => {
    if (!/^\d+$/.test(component) || component.length > 1 && component.startsWith("0")) return false
    const value = Number(component)
    return Number.isInteger(value) && value >= 0 && value <= 65_535
  })
}

async function validateStoreExtension(dist: string): Promise<string> {
  const files = await listFiles(dist)
  if (files.length !== storePackageFiles.length || files.some((file, index) => file !== storePackageFiles[index])) {
    throw new Error(`Unexpected Chrome Web Store package files: ${files.join(", ")}`)
  }
  const manifest = await readManifest(dist)
  if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== "120") {
    throw new Error("Extension manifest must target Manifest V3 and Chrome 120 or later")
  }
  const permissions = manifest.permissions
  const expectedPermissions = ["activeTab", "alarms", "debugger", "offscreen", "tabCapture", "tabGroups"]
  if (!Array.isArray(permissions) || permissions.join(",") !== expectedPermissions.join(",")) {
    throw new Error("Extension manifest permissions differ from the reviewed allowlist")
  }
  if (Reflect.has(manifest, "host_permissions")) {
    throw new Error("Extension manifest must not declare redundant host_permissions")
  }
  const key = manifest.key
  if (typeof key !== "string") {
    throw new Error("Unpacked extension manifest must declare a stable public key")
  }
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" })
    if (publicKey.asymmetricKeyType !== "rsa") throw new Error("Expected an RSA key")
  } catch (error) {
    throw new Error("Unpacked extension manifest key is not a valid RSA public key", { cause: error })
  }
  const version = manifestVersion(manifest)
  await Promise.all([16, 32, 48, 128].map(async (size) => {
    const png = await fs.readFile(path.join(dist, "icons", `icon-${size}.png`))
    if (png.readUInt32BE(0) !== 0x89504e47 || png.toString("ascii", 1, 4) !== "PNG") {
      throw new Error(`Extension icon ${size} is not a PNG`)
    }
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
      throw new Error(`Extension icon ${size} has incorrect dimensions`)
    }
  }))
  return version
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relativePath = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(directory, relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    } else {
      throw new Error(`Chrome Web Store package contains an unsupported entry: ${relativePath}`)
    }
  }
  return files
}

async function main(): Promise<void> {
  const dist = path.join(root, "extension", "dist")
  const version = await validateStoreExtension(dist)
  const archive = await makeExtensionArchive(dist)
  const artifactDirectory = path.join(root, "artifacts")
  const artifactPath = path.join(artifactDirectory, `browser-control-extension-${version}.zip`)
  await fs.mkdir(artifactDirectory, { recursive: true })
  await fs.writeFile(artifactPath, archive)
  const digest = createHash("sha256").update(archive).digest("hex")
  console.log(`${path.relative(root, artifactPath)} sha256:${digest}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
