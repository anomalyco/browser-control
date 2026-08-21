import { createHash, createPublicKey } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { unzipSync } from "fflate"
import { extensionVersion, isChromeExtensionVersion, makeExtensionArchive } from "../scripts/package-extension.ts"
import { stableUnpackedExtensionOrigin } from "../src/relay-helpers.ts"

describe("Chrome Web Store extension package", () => {
  it("is deterministic and rooted at the extension manifest", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-extension-package-"))
    try {
      await fs.mkdir(path.join(directory, "icons"))
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "1.2.3.4", key: "unpacked-key" }))
      await fs.writeFile(path.join(directory, "background.js"), "export {}\n")
      await fs.writeFile(path.join(directory, "icons", "icon-16.png"), new Uint8Array([1, 2, 3]))

      const first = await makeExtensionArchive(directory)
      await fs.utimes(path.join(directory, "background.js"), new Date(), new Date())
      const second = await makeExtensionArchive(directory)

      expect(second).toEqual(first)
      expect(Object.keys(unzipSync(first)).sort()).toEqual([
        "background.js",
        "icons/icon-16.png",
        "manifest.json",
      ])
      const archivedManifest = JSON.parse(new TextDecoder().decode(unzipSync(first)["manifest.json"]))
      expect(archivedManifest).not.toHaveProperty("key")
      expect(await extensionVersion(directory)).toBe("1.2.3.4")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("pins the unpacked extension id with a valid public key", async () => {
    const manifestPath = path.join(import.meta.dirname, "..", "extension", "manifest.json")
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { readonly key?: unknown }
    expect(typeof manifest.key).toBe("string")
    const publicKeyBytes = Buffer.from(manifest.key as string, "base64")
    expect(createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" }).asymmetricKeyType).toBe("rsa")

    const digest = createHash("sha256").update(publicKeyBytes).digest()
    let extensionId = ""
    for (const byte of digest.subarray(0, 16)) {
      extensionId += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
    }
    expect(`chrome-extension://${extensionId}`).toBe(stableUnpackedExtensionOrigin)
  })

  it("validates Chrome extension version components", () => {
    expect(isChromeExtensionVersion("0.0.19")).toBe(true)
    expect(isChromeExtensionVersion("65535.1.2.3")).toBe(true)
    expect(isChromeExtensionVersion("1.2.3.4.5")).toBe(false)
    expect(isChromeExtensionVersion("65536")).toBe(false)
    expect(isChromeExtensionVersion("01.2")).toBe(false)
    expect(isChromeExtensionVersion("1.-2")).toBe(false)
  })

  it("rejects source maps", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-extension-package-"))
    try {
      await fs.writeFile(path.join(directory, "background.js.map"), "{}")
      await expect(makeExtensionArchive(directory)).rejects.toThrow("must not contain source maps")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
